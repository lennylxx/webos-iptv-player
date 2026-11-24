import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import type { MappingSearchDocument } from './tasks';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { IndexRetryPendingError } from './index-retry';

const log = createLogger('MappingSearchWorker');

export class WorkerMappingSearch<T extends MappingSearchDocument> {
  private sessionId = 0;
  private source: T[] | null = null;
  private indexPromise: Promise<boolean> | null = null;
  private releaseWorker: (() => void) | null = null;
  private retryAt = 0;
  // Failures repeat until an attempt succeeds; only the first is logged.
  private failureLogged = false;

  constructor(private readonly owner: string) {}

  /** Entries whose names are most alike `name`, best first, and whether the best has the same name. */
  async similar(source: T[], name: string, limit: number): Promise<{ items: T[]; sameName: boolean }> {
    await this.ensureIndex(source);
    const result = await runAppWorkerTask('mapping-search.similar', {
      owner: this.owner,
      sessionId: this.sessionId,
      name,
      limit,
    });
    if (!result) throw new Error(`Mapping search index unavailable: ${this.owner}`);
    return {
      items: result.indices.map(index => source[index]).filter(item => item !== undefined),
      sameName: result.sameName,
    };
  }

  async query(source: T[], query: string, selectedId: string): Promise<T[]> {
    return (await this.queryWithSimilar(source, query, selectedId, 0)).items;
  }

  /**
   * Like `query`; with nothing but the selected entry containing `query`, up
   * to `similarLimit` entries with the most alike names follow it.
   */
  async queryWithSimilar(
    source: T[],
    query: string,
    selectedId: string,
    similarLimit: number,
  ): Promise<{ items: T[]; similar: boolean }> {
    const indexed = await this.ensureIndex(source);
    let result = await this.runQuery(query, selectedId, similarLimit);
    if (!result && source !== this.source) {
      // A newer query switched lists, or a release dropped this one: indexing
      // this list again would replace the newer index and fail that query.
      throw new Error(`Mapping search query superseded: ${this.owner}`);
    }
    if (!result) {
      log.warn(
        'Mapping search index missing; rebuilding',
        'event=search.worker.index.missing',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      // Rebuild as a fresh attempt, so a worker that keeps failing gets the
      // retry delay rather than the whole list on every query.
      if (this.indexPromise === indexed.attempt) this.indexPromise = null;
      await this.ensureIndex(source);
      result = await this.runQuery(query, selectedId, similarLimit);
      if (result) {
        log.info(
          'Mapping search index recovery completed',
          'event=search.worker.recovery.completed',
          'scope=mapping',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
        );
      }
    }
    if (!result) {
      log.error(
        'Mapping search index recovery failed',
        'event=search.worker.recovery.failed',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      throw new Error(`Mapping search index unavailable: ${this.owner}`);
    }
    return {
      items: result.indices.map(index => source[index]).filter(item => item !== undefined),
      similar: result.similar === true,
    };
  }

  release(): void {
    const releasedSession = this.source ? this.sessionId : null;
    this.sessionId++;
    this.source = null;
    this.indexPromise = null;
    this.retryAt = 0;
    this.failureLogged = false;
    if (releasedSession !== null) void this.releaseIndex(releasedSession);
    this.releaseWorker?.();
    this.releaseWorker = null;
  }

  private async ensureIndex(source: T[]): Promise<{ attempt: Promise<boolean> }> {
    if (source !== this.source) {
      this.sessionId++;
      this.source = source;
      this.retryAt = 0;
      this.failureLogged = false;
      this.indexPromise = this.index(source);
    } else if (!this.indexPromise) {
      // Each attempt posts the whole list, so a failing worker is not retried on every query.
      if (performance.now() < this.retryAt) {
        throw new IndexRetryPendingError(`Mapping search index retry pending: ${this.owner}`);
      }
      this.indexPromise = this.index(source);
    }
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    const pending = this.indexPromise;
    let accepted = false;
    let threw = false;
    let failure: unknown;
    try {
      accepted = await pending;
    } catch (error) {
      threw = true;
      failure = error;
    }
    if (accepted) return { attempt: pending };
    const error = threw ? failure : new Error(`Mapping search index rejected: ${this.owner}`);
    // A released or replaced attempt, or one a sharing query already handled:
    // its failure must not take the current attempt's log.
    if (pending !== this.indexPromise) throw error;
    // A failed attempt is forgotten, so a query after the delay indexes again.
    this.indexPromise = null;
    this.retryAt = performance.now() + CONFIG.SEARCH.INDEX_RETRY_DELAY_MS;
    if (!this.failureLogged) {
      this.failureLogged = true;
      if (threw) {
        log.error(
          'Mapping search indexing failed',
          'event=search.worker.index.failed',
          'scope=mapping',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
          failure,
        );
      } else {
        log.warn(
          'Mapping search index rejected',
          'event=search.worker.index.rejected',
          'scope=mapping',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
        );
      }
    }
    throw error;
  }

  private async index(source: T[]): Promise<boolean> {
    const sessionId = this.sessionId;
    const response = await runAppWorkerTask('mapping-search.index', {
      owner: this.owner,
      sessionId,
      documents: source,
    });
    const accepted = response.accepted && sessionId === this.sessionId;
    if (accepted) {
      this.failureLogged = false;
      log.info(
        'Mapping search index ready',
        'event=search.worker.index.ready',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        `documents=${String(source.length)}`,
      );
    }
    return accepted;
  }

  private async runQuery(query: string, selectedId: string, similarLimit: number) {
    try {
      return await runAppWorkerTask('mapping-search.query', {
        owner: this.owner,
        sessionId: this.sessionId,
        query,
        selectedId,
        similarLimit,
      });
    } catch (error) {
      log.error(
        'Mapping search query failed',
        'event=search.worker.query.failed',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
        error,
      );
      throw error;
    }
  }

  private async releaseIndex(sessionId: number): Promise<void> {
    try {
      const response = await runAppWorkerTask('mapping-search.release', {
        owner: this.owner,
        sessionId,
      });
      if (!response.accepted) return;
      log.debug(
        'Mapping search index released',
        'event=search.worker.index.released',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
      );
    } catch (error) {
      log.warn(
        'Mapping search index release failed',
        'event=search.worker.index.release.failed',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        error,
      );
    }
  }
}
