import type { Page } from '@playwright/test';
import { faultBytes, faultFor, type FaultPlan } from '../../src/test/fault-plan';

/**
 * Plays a FaultPlan through page.route: status codes, error pages, a failed
 * connection, a slow start, or no answer at all. A body that stalls, trickles,
 * or is cut partway needs startFaultServer, since a route sends a whole body.
 */
export async function routeFault(page: Page, url: string | RegExp, plan: FaultPlan): Promise<void> {
  let request = 0;
  await page.route(url, async (route) => {
    const fault = faultFor(plan, request++);
    if ('networkError' in fault) return route.abort('failed');
    // Left unanswered, the request stays pending until the page gives up on it.
    if ('hang' in fault || fault.holdHeaders) return undefined;
    if (fault.chunkSize !== undefined || fault.stallAfterBytes !== undefined || fault.resetAfterBytes !== undefined) {
      throw new Error('routeFault cannot stream a body; use startFaultServer');
    }
    if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
    return route.fulfill({
      status: fault.status ?? 200,
      headers: { 'access-control-allow-origin': '*', ...fault.headers },
      body: Buffer.from(faultBytes(fault.body)),
    });
  });
}
