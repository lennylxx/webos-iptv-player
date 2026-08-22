import { type Browser, type Page } from '@playwright/test';
import { LEGACY_HEADER, postTargetApis, removeApis } from '../scripts/chromium-53-simulation.mjs';
import { stubUploadService } from './helpers';

const POST_TARGET_APIS = postTargetApis();

/**
 * A second page driven through the webOS 4 simulation, inside whatever project
 * is running. `chromium-53-simulation` applies these two degradations through
 * the project config; a parity test needs both engines side by side in one run,
 * so it assembles the legacy one itself.
 */
export async function newLegacyPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { [LEGACY_HEADER]: '1' },
  });
  const page = await context.newPage();
  await page.addInitScript(removeApis, POST_TARGET_APIS);
  await stubUploadService(page);
  return { page, close: () => context.close() };
}

export interface PixelDiff {
  /** Fraction of pixels differing by more than the hard threshold. */
  ratio: number;
  /** Bounding box of those pixels, or null when there are none. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Rendered diff, present only when `render` was asked for. */
  png?: Buffer;
}

export interface PixelDiffOptions {
  /** Per-channel delta that counts as a real difference. */
  hard?: number;
  /** Lower delta, drawn in a second colour as anti-aliasing noise. */
  soft?: number;
  /** Render a diff image: hard pixels red, soft yellow, over a dimmed base. */
  render?: boolean;
}

/**
 * Compare two PNG buffers. Decoding happens inside `canvasPage` so the suite
 * needs no image dependency; pass a page from the modern project, since the
 * simulation removes APIs the decode path uses.
 */
export async function pixelDiff(
  canvasPage: Page,
  a: Buffer,
  b: Buffer,
  options: PixelDiffOptions = {},
): Promise<PixelDiff> {
  const { hard = 64, soft = 16, render = false } = options;
  const result = await canvasPage.evaluate(async (args) => {
    const load = (b64: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = `data:image/png;base64,${b64}`;
    });
    const context = (w: number, h: number): CanvasRenderingContext2D => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      return ctx;
    };
    const pixels = (img: HTMLImageElement): ImageData => {
      const ctx = context(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    };
    const [ia, ib] = await Promise.all([load(args.a), load(args.b)]);
    if (ia.naturalWidth !== ib.naturalWidth || ia.naturalHeight !== ib.naturalHeight) {
      throw new Error(`size mismatch ${ia.naturalWidth}x${ia.naturalHeight} vs ${ib.naturalWidth}x${ib.naturalHeight}`);
    }
    const pa = pixels(ia);
    const pb = pixels(ib);
    const w = pa.width;
    const h = pa.height;
    const out = args.render ? context(w, h) : null;
    const image = out ? out.createImageData(w, h) : null;

    let count = 0;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    for (let i = 0; i < pa.data.length; i += 4) {
      const d = Math.max(
        Math.abs(pa.data[i] - pb.data[i]),
        Math.abs(pa.data[i + 1] - pb.data[i + 1]),
        Math.abs(pa.data[i + 2] - pb.data[i + 2]),
      );
      if (d > args.hard) {
        count++;
        const p = i / 4;
        const x = p % w;
        const y = (p - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (!image) continue;
      // Dim the modern render to a grey plate so the marked pixels stand out.
      const grey = (pa.data[i] * 0.3 + pa.data[i + 1] * 0.59 + pa.data[i + 2] * 0.11) * 0.25 + 40;
      const rgb = d > args.hard ? [255, 40, 40] : d > args.soft ? [255, 200, 0] : [grey, grey, grey];
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
      image.data[i + 3] = 255;
    }
    let png: string | undefined;
    if (out && image) {
      out.putImageData(image, 0, 0);
      png = out.canvas.toDataURL('image/png').split(',')[1];
    }
    return {
      ratio: count / (pa.data.length / 4),
      bbox: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
      png,
    };
  }, { a: a.toString('base64'), b: b.toString('base64'), hard, soft, render });

  return {
    ratio: result.ratio,
    bbox: result.bbox,
    png: result.png ? Buffer.from(result.png, 'base64') : undefined,
  };
}

/**
 * A whole-screen pixel budget can mask a small text shift, so measure the one
 * spacing the `> * + *` fallback structurally cannot reach: a loose text node
 * beside an element child, which the sibling combinator never matches.
 *
 * Detection needs the modern engine — the simulation strips `gap`, so there is
 * nothing left to read the intended spacing from. Each hit is reported by its
 * nth-child path so the same node can be measured on the legacy page.
 */
export interface LooseTextGap { path: number[]; id: string; gap: number }

export function findGappedLooseText(page: Page): Promise<LooseTextGap[]> {
  return page.evaluate(() => {
    const spread = ['space-between', 'space-around', 'space-evenly'];
    const hits: { path: number[]; id: string; gap: number }[] = [];
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if (!/flex|grid/.test(style.display)) return;
      const gap = parseFloat(style.columnGap) || 0;
      if (!gap || spread.indexOf(style.justifyContent) >= 0) return;
      if (!el.children.length) return;
      const loose = Array.prototype.slice.call(el.childNodes).some(
        (n: Node) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim());
      if (!loose) return;
      const path: number[] = [];
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        path.unshift(Array.prototype.indexOf.call(n.parentElement!.children, n));
      }
      hits.push({ path, id: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''), gap });
    });
    return hits;
  });
}

/** Measure the same containers on the legacy page; report those that lost the gap. */
export function measureLooseText(page: Page, hits: LooseTextGap[]): Promise<string[]> {
  return page.evaluate((items: LooseTextGap[]) => {
    const bad: string[] = [];
    items.forEach((hit) => {
      let el: Element | undefined = document.documentElement;
      hit.path.forEach((i) => { el = el && el.children[i]; });
      if (!el) return;
      const kids = Array.prototype.slice.call(el.childNodes) as Node[];
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1];
        const node = kids[i];
        if (node.nodeType !== Node.TEXT_NODE || !(node.textContent || '').trim()) continue;
        if (prev.nodeType !== Node.ELEMENT_NODE) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const spacing = range.getBoundingClientRect().left
          - (prev as Element).getBoundingClientRect().right;
        if (spacing < hit.gap - 1) {
          bad.push(hit.id + ' :: ' + Math.round(spacing) + 'px, expected ' + hit.gap + 'px');
        }
      }
    });
    return bad;
  }, hits);
}
