import { describe, expect, it } from 'vitest';
import { POLYFILLED_APIS, simulationCoverageGap } from './polyfilled-apis.mjs';

describe('POLYFILLED_APIS', () => {
  it('has no duplicate entries', () => {
    expect(new Set(POLYFILLED_APIS).size).toBe(POLYFILLED_APIS.length);
  });

  // Every polyfill must be reachable in the simulation — otherwise only the
  // modern-engine half of e2e/legacy-fallbacks.spec.ts covers it, and the
  // discovery scan there can never notice if the install goes missing. A new
  // entry that lands outside the removal set has to be made reachable, or
  // deliberately accepted here.
  it('is exercised by the simulation in full', () => {
    expect(simulationCoverageGap()).toEqual([]);
  });
});
