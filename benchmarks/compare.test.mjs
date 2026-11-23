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

describe('compare', () => {
  const report = (suites) => ({
    version: 1,
    target: 'desktop',
    scale: 10,
    cpuRate: 4,
    browser: 'b',
    keySamples: 3,
    querySamples: 1,
    suites,
  });
  const run = async (baseline, latest) => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bench-compare-'));
    await mkdir(path.join(dir, 'benchmarks'));
    await mkdir(path.join(dir, 'test-output', 'benchmarks'), { recursive: true });
    await writeFile(path.join(dir, 'benchmarks', 'baseline.json'), JSON.stringify(report(baseline)));
    await writeFile(path.join(dir, 'test-output', 'benchmarks', 'latest.json'), JSON.stringify(report(latest)));
    return promisify(execFile)(process.execPath, [compare], { cwd: dir });
  };

  it('allows a frame metric one missed frame', async () => {
    await expect(run(
      { epg: { firstFrameMs: 16.7 }, parsers: { xmltvPipeline: { maxFrameGapMs: 16.7 } } },
      { epg: { firstFrameMs: 33.4 }, parsers: { xmltvPipeline: { maxFrameGapMs: 33.4 } } },
    )).resolves.toBeDefined();
  });

  it('still fails a frame metric two frames slower', async () => {
    await expect(run({ epg: { firstFrameMs: 16.7 } }, { epg: { firstFrameMs: 50.1 } })).rejects.toThrow();
  });

  it('keeps the small allowance for a handler metric', async () => {
    await expect(run({ epg: { maxLongTaskMs: 16.7 } }, { epg: { maxLongTaskMs: 33.4 } })).rejects.toThrow();
  });
});
