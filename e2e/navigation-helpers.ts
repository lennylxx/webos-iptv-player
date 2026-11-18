import type { Locator, Page } from '@playwright/test';

// Shared by the D-pad navigation specs: arrow keys, a seeded random, and
// page queries and actions.

export type Direction = 'up' | 'down' | 'left' | 'right';
export const KEYS: Record<Direction, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
export const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

export type NavBoxWindow = Window & { __navBox(el: Element): DOMRect };

export function seededRandom(seed: number): () => number {
  let value = seed;
  return () => (value = (value * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// Defines `__navBox(el)` in the page: the box SpatialNav measures, which is
// the first child's when the element has `data-nav-rect`.
export async function installNavBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as NavBoxWindow).__navBox = (el) =>
      ((el.hasAttribute('data-nav-rect') && el.firstElementChild) || el).getBoundingClientRect();
  });
}

// The `data-key` lit `.focused` under `root`, else `tabBar` when the tab bar
// has the ring, else null.
export async function focusedKey(page: Page, root: string, tabBar: string): Promise<string | null> {
  return page.evaluate(([scope, tab]) => {
    const own = document.querySelector<HTMLElement>(`${scope} .focused`);
    if (own) return own.dataset.key ?? null;
    return document.querySelector('.tab-bar .focused') ? tab : null;
  }, [root, tabBar] as const);
}

export async function hover(target: Locator): Promise<void> {
  await target.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
}

// False when `root` has no element with that `data-key`.
export async function hoverKey(page: Page, root: string, key: string): Promise<boolean> {
  const el = page.locator(`${root} [data-key="${key}"]`);
  if (!await el.count()) return false;
  await hover(el);
  return true;
}
