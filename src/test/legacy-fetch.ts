// Network stand-ins for tests that model webOS 4 (Chromium 53).

// The polyfilled AbortController from src/polyfills.ts: abort() fails only a
// fetch still waiting for its headers, never a body read already under way.
export class LegacyAbortController {
  signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
  abort(): void { this.signal.aborted = true; }
}
