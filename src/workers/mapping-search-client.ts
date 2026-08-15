import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import type { MappingSearchDocument } from './tasks';
import { createLogger } from '../utils/logger';

const log = createLogger('MappingSearchWorker');

export class WorkerMappingSearch<T extends MappingSearchDocument> {
  private sessionId = 0;
  private source: T[] | null = null;
  private indexPromise: Promise<boolean> | null = null;
  private releaseWorker: (() => void) | null = null;

  constructor(private readonly owner: string) {}

  async query(source: T[], query: string, selectedId: string): Promise<T[]> {
    await this.ensureIndex(source);
    let result = await this.runQuery(query, selectedId);
    if (!result) {
      log.warn(
        'Mapping search index missing; rebuilding',
        'event=search.worker.index.missing',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      await this.index(source);
      result = await this.runQuery(query, selectedId);
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
    return result.indices.map(index => source[index]).filter(item => item !== undefined);
  }

  release(): void {
    const releasedSession = this.source ? this.sessionId : null;
    this.sessionId++;
    this.source = null;
    this.indexPromise = null;
    if (releasedSession !== null) void this.releaseIndex(releasedSession);
    this.releaseWorker?.();
    this.releaseWorker = null;
  }

  private async ensureIndex(source: T[]): Promise<void> {
    if (source !== this.source) {
      this.sessionId++;
      this.source = source;
      this.indexPromise = this.index(source);
    }
    if (!this.releaseWorker) this.releaseWorker = retainAppWorker();
    if (!(await this.indexPromise)) {
      log.warn(
        'Mapping search index rejected',
        'event=search.worker.index.rejected',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      throw new Error(`Mapping search index rejected: ${this.owner}`);
    }
  }

  private async index(source: T[]): Promise<boolean> {
    const sessionId = this.sessionId;
    try {
      const response = await runAppWorkerTask('mapping-search.index', {
        owner: this.owner,
        sessionId,
        documents: source,
      });
      const accepted = response.accepted && sessionId === this.sessionId;
      if (accepted) {
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
    } catch (error) {
      log.error(
        'Mapping search indexing failed',
        'event=search.worker.index.failed',
        'scope=mapping',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        error,
      );
      throw error;
    }
  }

  private async runQuery(query: string, selectedId: string) {
    try {
      return await runAppWorkerTask('mapping-search.query', {
        owner: this.owner,
        sessionId: this.sessionId,
        query,
        selectedId,
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
