import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

interface DiagnosticContract {
  file: string;
  logger: string;
  events: string[];
}

const contracts: DiagnosticContract[] = [
  {
    file: 'idb-database.ts',
    logger: 'PersistenceDB',
    events: [
      'persistence.db.unavailable',
      'persistence.db.upgrade',
      'persistence.db.open.failed',
      'persistence.db.open.blocked',
    ],
  },
  {
    file: 'idb-cache.ts',
    logger: 'CacheStorage',
    events: [
      'xtream.cache.unavailable',
      'xtream.cache.read.failed',
      'xtream.cache.write.aborted',
      'xtream.cache.write.failed',
      'persistence.cache.read.failed',
      'persistence.cache.accounting.rebuild.failed',
      'persistence.cache.accounting.read.failed',
      'persistence.cache.eviction.scan.failed',
      'persistence.cache.eviction.failed',
      'persistence.cache.budget.exceeded',
      'persistence.cache.quota.exceeded',
      'persistence.cache.write.failed',
      'persistence.cache.clear.failed',
      'persistence.cache.clear.completed',
      'persistence.cache.migration.failed',
    ],
  },
  {
    file: 'idb-user-data.ts',
    logger: 'UserDataStorage',
    events: [
      'persistence.user.unavailable',
      'persistence.user.read.failed',
      'persistence.user.migration.failed',
      'persistence.user.migration.completed',
      'persistence.user.write.failed',
      'persistence.user.clear.failed',
      'persistence.user.clear.completed',
    ],
  },
  {
    file: 'storage-service.ts',
    logger: 'StorageService',
    events: [
      'persistence.user.write.failed',
      'persistence.local.quota',
      'persistence.local.write.failed',
      'persistence.cache.eviction.failed',
      'persistence.user.init.completed',
      'persistence.user.init.failed',
      'persistence.user.flush.retry',
      'persistence.user.flush.recovered',
    ],
  },
  {
    file: '../components/settings.ts',
    logger: 'Settings',
    events: [
      'persistence.reset.failed',
      'persistence.cache.accounting.read.failed',
      'persistence.cache.clear.failed',
    ],
  },
  {
    file: '../app.ts',
    logger: 'App',
    events: [
      'persistence.user.flush.completed',
      'persistence.user.flush.failed',
      'persistence.reset.completed',
    ],
  },
];

describe('persistence diagnostic contracts', () => {
  for (const contract of contracts) {
    it(`${contract.file} keeps its logger tag and stable events`, () => {
      const source = readFileSync(new URL(contract.file, import.meta.url), 'utf8');
      expect(source).toContain(`createLogger('${contract.logger}')`);
      for (const event of contract.events) {
        expect(source).toContain(`event=${event}`);
      }
    });
  }

  it('tags every persistence-module log with a diagnostic event', () => {
    const untagged: string[] = [];
    for (const contract of contracts.slice(0, 4)) {
      const source = readFileSync(new URL(contract.file, import.meta.url), 'utf8');
      const sourceFile = ts.createSourceFile(
        contract.file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(sourceFile) === 'log'
          && ['info', 'warn', 'error'].includes(node.expression.name.text)
          && !node.getText(sourceFile).includes('event=')
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          untagged.push(`${contract.file}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(untagged).toEqual([]);
  });
});
