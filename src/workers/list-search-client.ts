import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import type { ListSearchIndexRequest } from './tasks';
import { createLogger } from '../utils/logger';

const log = createLogger('ListSearchWorker');

export class WorkerListSearch<T> {
  private sessionId = 0;
  private source: T[] | null = null;
  private indexPromise: Promise<boolean> | null = null;
  private releaseWorker: (() => void) | null = null;

  constructor(
    private readonly owner: string,
    private readonly mode: ListSearchIndexRequest['mode'],
    private readonly fields: (item: T) => string[],
  ) {}

  async query(source: T[], query: string): Promise<T[]> {
    await this.ensureIndex(source);
    let result = await this.runQuery(query);
    if (!result) {
      log.warn(
        'List search index missing; rebuilding',
        'event=search.worker.index.missing',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      await this.index(source);
      result = await this.runQuery(query);
      if (result) {
        log.info(
          'List search index recovery completed',
          'event=search.worker.recovery.completed',
          'scope=list',
          `owner=${this.owner}`,
          `session=${String(this.sessionId)}`,
        );
      }
    }
    if (!result) {
      log.error(
        'List search index recovery failed',
        'event=search.worker.recovery.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      throw new Error(`List search index unavailable: ${this.owner}`);
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
        'List search index rejected',
        'event=search.worker.index.rejected',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
      );
      throw new Error(`List search index rejected: ${this.owner}`);
    }
  }

  private async index(source: T[]): Promise<boolean> {
    const sessionId = this.sessionId;
    try {
      const response = await runAppWorkerTask('list-search.index', {
        owner: this.owner,
        sessionId,
        mode: this.mode,
        documents: source.map(item => this.fields(item)),
      });
      const accepted = response.accepted && sessionId === this.sessionId;
      if (accepted) {
        log.info(
          'List search index ready',
          'event=search.worker.index.ready',
          'scope=list',
          `owner=${this.owner}`,
          `session=${String(sessionId)}`,
          `documents=${String(source.length)}`,
        );
      }
      return accepted;
    } catch (error) {
      log.error(
        'List search indexing failed',
        'event=search.worker.index.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        error,
      );
      throw error;
    }
  }

  private async runQuery(query: string) {
    try {
      return await runAppWorkerTask('list-search.query', {
        owner: this.owner,
        sessionId: this.sessionId,
        query,
      });
    } catch (error) {
      log.error(
        'List search query failed',
        'event=search.worker.query.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(this.sessionId)}`,
        error,
      );
      throw error;
    }
  }

  private async releaseIndex(sessionId: number): Promise<void> {
    try {
      const response = await runAppWorkerTask('list-search.release', {
        owner: this.owner,
        sessionId,
      });
      if (!response.accepted) return;
      log.debug(
        'List search index released',
        'event=search.worker.index.released',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
      );
    } catch (error) {
      log.warn(
        'List search index release failed',
        'event=search.worker.index.release.failed',
        'scope=list',
        `owner=${this.owner}`,
        `session=${String(sessionId)}`,
        error,
      );
    }
  }
}
