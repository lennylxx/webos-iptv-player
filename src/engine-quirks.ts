// Legacy engine behaviors that `@supports` cannot test, because they are not
// features. Each is measured once at boot and published as an `html.q-*`
// class for CSS and code to share. Measure behavior; never parse the UA.
// - q-scroll-end-padding: Chromium before 91 leaves a row flex scroller's
//   padding-right out of its scroll width.
// - q-no-flex-gap: no flex `gap` (Chromium before 84). `@supports (gap: …)`
//   is already true for grid gap alone, from Chromium 66.
//
// Unrelated to the document's quirks mode.
//
// Imported right after polyfills in src/app.ts only; the worker has no layout.

import { createLogger } from './utils/logger';

const log = createLogger('Quirks');

export interface EngineQuirks {
  scrollEndPadding: boolean;
  noFlexGap: boolean;
}

export const QUIRK_CLASSES: Record<keyof EngineQuirks, string> = {
  scrollEndPadding: 'q-scroll-end-padding',
  noFlexGap: 'q-no-flex-gap',
};

const PROBE_STYLE = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
  + 'box-sizing:content-box;';
const ITEM_STYLE = 'flex:0 0 auto;box-sizing:content-box;height:1px;margin:0;padding:0;';

function box(doc: Document, style: string): HTMLElement {
  const el = doc.createElement('div');
  el.style.cssText = style;
  return el;
}

export function measureEngineQuirks(doc: Document = document): EngineQuirks {
  const host = box(doc, PROBE_STYLE);

  // A 10px row scroller with 10px end padding and a 20px item scrolls 30px
  // wide when the padding counts, 20px when it does not.
  const scroller = box(doc, 'display:flex;flex-direction:row;overflow:auto;'
    + 'box-sizing:content-box;width:10px;height:10px;padding:0 10px 0 0;border:0;');
  scroller.appendChild(box(doc, `${ITEM_STYLE}width:20px;`));
  // Lets the Chromium 53 simulation, which cannot reproduce the layout,
  // report this scroller the way the old engine measures it.
  scroller.setAttribute('data-quirk-probe', 'scroll-end-padding');

  // Through the CSSOM reflection, not cssText: an engine (or the Chromium 53
  // simulation) without the property ignores the assignment.
  const row = box(doc, 'display:flex;flex-direction:row;width:100px;padding:0;border:0;');
  row.style.gap = '10px';
  const first = box(doc, `${ITEM_STYLE}width:10px;`);
  const second = box(doc, `${ITEM_STYLE}width:10px;`);
  row.appendChild(first);
  row.appendChild(second);

  host.appendChild(scroller);
  host.appendChild(row);
  (doc.body || doc.documentElement).appendChild(host);
  try {
    return {
      // Midpoints, so sub-pixel rounding cannot tip either probe.
      scrollEndPadding: scroller.scrollWidth < 25,
      noFlexGap: second.offsetLeft - first.offsetLeft < 15,
    };
  } finally {
    host.parentNode?.removeChild(host);
  }
}

export function applyEngineQuirks(quirks: EngineQuirks, root: Element): void {
  (Object.keys(QUIRK_CLASSES) as (keyof EngineQuirks)[]).forEach((name) => {
    if (quirks[name]) root.classList.add(QUIRK_CLASSES[name]);
    else root.classList.remove(QUIRK_CLASSES[name]);
  });
  log.info(
    'Engine quirks measured',
    'event=engine.quirks.measured',
    `scrollEndPadding=${quirks.scrollEndPadding ? 1 : 0}`,
    `noFlexGap=${quirks.noFlexGap ? 1 : 0}`,
  );
}

if (typeof document !== 'undefined') {
  applyEngineQuirks(measureEngineQuirks(document), document.documentElement);
}
