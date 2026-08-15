import { describe, expect, it } from 'vitest';
import { scanBundle } from './compat-gate.mjs';

describe('compat gate module workers', () => {
  it('rejects module Worker and SharedWorker constructors', () => {
    const violations = scanBundle(`
      new Worker('/worker.js', { type: 'module' });
      new window.SharedWorker('/shared.js', { "type": "module" });
    `);

    expect(violations).toEqual([
      expect.objectContaining({
        name: 'module worker',
        kind: 'worker-option',
        minChrome: 80,
        count: 2,
      }),
    ]);
  });

  it('allows classic workers and unrelated module options', () => {
    expect(scanBundle(`
      new Worker('/worker.js');
      new Worker('/worker.js', { name: 'worker' });
      configure({ type: 'module' });
      const example = "new Worker('/worker.js', { type: 'module' })";
    `)).toEqual([]);
  });
});

describe('compat gate unsupported options', () => {
  it('rejects object-form transfers and abortable event listeners', () => {
    const violations = scanBundle(`
      worker.postMessage(bytes, { transfer: [bytes.buffer] });
      target.addEventListener('click', handler, { signal: controller.signal });
    `);

    expect(violations).toEqual([
      expect.objectContaining({
        name: 'postMessage transfer options',
        kind: 'postmessage-option',
        count: 1,
      }),
      expect.objectContaining({
        name: 'abortable event listener',
        kind: 'listener-option',
        count: 1,
      }),
    ]);
  });

  it('allows legacy transfers and supported event-listener options', () => {
    expect(scanBundle(`
      worker.postMessage(bytes, [bytes.buffer]);
      target.addEventListener('click', handler, { once: true, passive: true });
    `)).toEqual([]);
  });
});

describe('compat gate unsupported constructors', () => {
  it('rejects post-Chrome-68 constructors', () => {
    const violations = scanBundle(`
      new OffscreenCanvas(10, 10);
      new self.CompressionStream('gzip');
      new globalThis["WeakRef"](value);
    `);

    expect(violations).toEqual([
      expect.objectContaining({ name: 'OffscreenCanvas', kind: 'constructor', count: 1 }),
      expect.objectContaining({ name: 'CompressionStream', kind: 'constructor', count: 1 }),
      expect.objectContaining({ name: 'WeakRef', kind: 'constructor', count: 1 }),
    ]);
  });

  it('allows constructors available in Chrome 68', () => {
    expect(scanBundle(`
      new Worker('/worker.js');
      new TextDecoder('utf-8');
      new AbortController();
    `)).toEqual([]);
  });
});
