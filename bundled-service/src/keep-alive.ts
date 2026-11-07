/**
 * Holds one webos-service activity while a feature is busy. The activity
 * manager completes an activity by the object its create callback returned
 * (it reads `activityId`); completing by name leaks the activity, and the
 * service then never idles out.
 */

import type { ServiceLogger } from './logger';

export interface ActivityManagerLike {
  create(name: string, callback: (activity: unknown) => void): void;
  complete(activity: unknown, callback: () => void): void;
}

export interface KeepAlive {
  hold(): void;
  release(): void;
}

function isActivity(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && (value as { activityId?: unknown }).activityId !== undefined;
}

export function createKeepAlive(manager: () => ActivityManagerLike | undefined, name: string,
  log: ServiceLogger): KeepAlive {
  let wanted = false;
  let creating = false;
  let held: unknown = null;

  function complete(activity: unknown): void {
    const am = manager();
    if (!am) return;
    try {
      am.complete(activity, () => { /* released */ });
    } catch (e) {
      log.warn(name + ' activity complete failed:', e);
    }
  }

  return {
    hold() {
      wanted = true;
      if (held || creating) return;
      const am = manager();
      if (!am) return;
      creating = true;
      try {
        am.create(name, (activity) => {
          creating = false;
          if (!isActivity(activity)) {
            log.warn(name + ' activity create failed');
            return;
          }
          // Released while the create was in flight.
          if (!wanted) complete(activity);
          else held = activity;
        });
      } catch (e) {
        creating = false;
        log.warn(name + ' activity create failed:', e);
      }
    },
    release() {
      wanted = false;
      if (!held) return;
      const activity = held;
      held = null;
      complete(activity);
    },
  };
}
