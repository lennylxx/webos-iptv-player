import { describe, expect, it, vi } from 'vitest';
import { createKeepAlive, type ActivityManagerLike } from './keep-alive';
import { registerLanService } from './lan/service';

vi.mock('./lan/server', () => ({
  startServer: () => Promise.resolve({ server: { close: (cb: (e?: Error) => void) => cb() }, port: 1234 }),
}));

// Shaped like webos-service's ActivityManager: create answers asynchronously
// with the activity object, and complete releases only that object.
function fakeManager(): ActivityManagerLike & { live: Set<number> } {
  const live = new Set<number>();
  let next = 1;
  return {
    live,
    create(name, callback) {
      const activity: { activity: { name: string }; activityId?: number } = { activity: { name } };
      setTimeout(() => {
        activity.activityId = next++;
        live.add(activity.activityId);
        callback(activity);
      }, 1);
    },
    complete(activity, callback) {
      const a = activity as { activityId?: number; completed?: boolean };
      if (!a || typeof a !== 'object' || a.completed || a.activityId === undefined) return;
      a.completed = true;
      live.delete(a.activityId);
      setTimeout(callback, 1);
    },
  };
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('createKeepAlive', () => {
  it('completes each activity it created across hold/release cycles', async () => {
    const manager = fakeManager();
    const keepAlive = createKeepAlive(() => manager, 'test', log);
    for (let i = 0; i < 3; i++) {
      keepAlive.hold();
      await tick();
      expect(manager.live.size).toBe(1);
      keepAlive.release();
      await tick();
    }
    expect(manager.live.size).toBe(0);
  });

  it('completes an activity released before its create answered', async () => {
    const manager = fakeManager();
    const keepAlive = createKeepAlive(() => manager, 'test', log);
    keepAlive.hold();
    keepAlive.release();
    await tick();
    expect(manager.live.size).toBe(0);
    keepAlive.hold();
    keepAlive.hold();
    await tick();
    expect(manager.live.size).toBe(1);
  });
});

describe('LAN service keepAlive', () => {
  it('completes the created activity on stop', async () => {
    const manager = fakeManager();
    const handlers: Record<string, (msg: { respond: (r: unknown) => void }) => void> = {};
    registerLanService({ register: (method, handler) => { handlers[method] = handler; }, activityManager: manager },
      'data');
    await tick();
    expect(manager.live.size).toBe(1);
    handlers.stop({ respond: () => undefined });
    await tick();
    expect(manager.live.size).toBe(0);
  });
});
