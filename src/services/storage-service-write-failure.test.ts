// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StorageService } from './storage-service';
import * as idbUserData from './idb-user-data';

// persistUserChanges() is fire-and-forget: it attaches its own .then()/.catch()
// to the applyUserChanges() promise *before* the caller here gets a chance to.
// Awaiting that same promise (once it's mocked to a value we hold onto)
// therefore guarantees persistUserChanges' own continuation already ran —
// same-tier .then() callbacks fire in attachment order.
function mockNextWriteRejection(message: string): Promise<never> {
  const rejection = Promise.reject(new Error(message));
  vi.spyOn(idbUserData, 'applyUserChanges').mockImplementationOnce(() => rejection);
  return rejection;
}

// Same ordering guarantee, but for a write that's left to actually succeed —
// spies just to capture the exact promise persistUserChanges() also awaits.
function captureNextWrite(): { result: Promise<void> } {
  const capture = { result: Promise.resolve() };
  const real = idbUserData.applyUserChanges;
  vi.spyOn(idbUserData, 'applyUserChanges').mockImplementationOnce((...args) => {
    capture.result = real(...args);
    return capture.result;
  });
  return capture;
}

describe('StorageService write-failure handler', () => {
  beforeEach(async () => {
    localStorage.clear();
    await StorageService.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await StorageService.clearUserData();
  });

  it('notifies once per failure streak, and again after it recovers', async () => {
    const onFailure = vi.fn();
    StorageService.setWriteFailureHandler(onFailure);

    const first = mockNextWriteRejection('boom');
    StorageService.setFavorites(['ch1']);
    await first.catch(() => {});
    expect(onFailure).toHaveBeenCalledTimes(1);

    // A second failure in the same streak must not notify again.
    const second = mockNextWriteRejection('boom again');
    StorageService.setFavorites(['ch1', 'ch2']);
    await second.catch(() => {});
    expect(onFailure).toHaveBeenCalledTimes(1);

    // A write that succeeds ends the streak.
    const recovered = captureNextWrite();
    StorageService.setFavorites(['ch1']);
    await recovered.result;

    // So a later failure notifies again.
    const third = mockNextWriteRejection('boom once more');
    StorageService.setFavorites(['ch1', 'ch3']);
    await third.catch(() => {});
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it('does not notify at all when writes succeed', async () => {
    const onFailure = vi.fn();
    StorageService.setWriteFailureHandler(onFailure);

    const write = captureNextWrite();
    StorageService.setFavorites(['ch1']);
    await write.result;

    expect(onFailure).not.toHaveBeenCalled();
  });
});
