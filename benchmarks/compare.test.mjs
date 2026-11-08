import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const compare = path.join(import.meta.dirname, 'compare.mjs');
let dir;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('compare --interactive', () => {
  it('skips a metric that neither report records', async () => {
    // Worker throttle mode records no projection in either report.
    const report = {
      version: 1,
      target: 'desktop',
      interactive: { networks: ['unthrottled'], workerThrottle: true },
      suites: { interactive: { unthrottled: {} } },
    };
    dir = await mkdtemp(path.join(os.tmpdir(), 'bench-compare-'));
    await mkdir(path.join(dir, 'benchmarks'));
    await mkdir(path.join(dir, 'test-output', 'benchmarks'), { recursive: true });
    await writeFile(path.join(dir, 'benchmarks', 'baseline.json'), JSON.stringify(report));
    await writeFile(path.join(dir, 'test-output', 'benchmarks', 'interactive-latest.json'), JSON.stringify(report));
    await expect(promisify(execFile)(process.execPath, [compare, '--interactive'], { cwd: dir }))
      .resolves.toBeDefined();
  });
});
