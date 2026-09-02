import { describe, expect, it } from 'vitest';
import { postTargetApis, removeApis, simulateLegacyEngine } from './chromium-53-simulation.mjs';

const { globals, members, cssProperties } = postTargetApis();
const hasMember = (owner, member) => members.some(([o, m]) => o === owner && m === member);

describe('postTargetApis', () => {
  it('lists builtins and DOM members Chromium 53 lacks', () => {
    expect(globals).toContain('ResizeObserver'); // Chrome 64
    expect(hasMember('Array', 'flat')).toBe(true); // Chrome 69
    expect(hasMember('Element', 'append')).toBe(true); // Chrome 54
    expect(hasMember('Element', 'getAnimations')).toBe(true); // Chrome 84
  });

  it('keeps APIs Chromium 53 already had', () => {
    expect(globals).not.toContain('Element');
    expect(hasMember('Array', 'map')).toBe(false);
    expect(hasMember('Element', 'closest')).toBe(false); // Chrome 41
  });

  it('reads a support range that was re-added for changed behavior', () => {
    // BCD lists Element.scrollLeft as added in 86 (spec RTL semantics) *before*
    // the 1–85 range, so reading only the first entry would strip an API
    // Chromium 53 has had since Chrome 1.
    expect(hasMember('Element', 'scrollLeft')).toBe(false);
    expect(hasMember('Element', 'scrollTo')).toBe(true); // genuinely Chrome 61
  });

  it('does not treat prefixed or alternative names as canonical support', () => {
    expect(globals).toContain('DOMMatrix'); // only WebKitCSSMatrix existed
    expect(hasMember('Element', 'requestFullscreen')).toBe(true); // webkit-prefixed in 53
    expect(cssProperties).toContain('marginBlockStart'); // -webkit-margin-before in 53
    expect(cssProperties).toContain('marginBlockEnd'); // -webkit-margin-after in 53
    expect(cssProperties).toContain('userSelect'); // only -webkit-user-select in 53
  });

  it('exempts globals the harness or desktop-only preview needs', () => {
    expect(globals).not.toContain('MediaSource');
    expect(globals).not.toContain('BigInt64Array');
    // Exempting a name Chromium 53 already had must not exempt its new members.
    expect(hasMember('Promise', 'any')).toBe(true); // Chrome 85
    // But an exempt interface that is itself newer stays whole: stripping its
    // members would model an engine lacking the interface entirely.
    expect(hasMember('WritableStream', 'getWriter')).toBe(false); // Chrome 59
    // The app ships its own AbortController fallback, so exempting it would
    // leave that fallback untested; only preview-only globals may be exempt.
    expect(globals).toContain('AbortController');
  });
});

describe('removeApis', () => {
  it('deletes globals, prototype methods and statics, and tolerates absent ones', () => {
    function Widget() {}
    Widget.prototype = { spin: () => 1, sit: () => 2 };
    Widget.from = () => 3;
    globalThis.LegacyGone = 2;
    globalThis.LegacyKept = 1;
    globalThis.LegacyWidget = Widget;

    try {
      removeApis({
        globals: ['LegacyGone', 'LegacyNeverExisted'],
        members: [
          ['LegacyWidget', 'spin'],
          ['LegacyWidget', 'from'],
          ['LegacyMissing', 'anything'],
        ],
      });

      expect(globalThis.LegacyGone).toBeUndefined();
      expect(globalThis.LegacyKept).toBe(1);
      expect(Widget.prototype.spin).toBeUndefined();
      expect(Widget.prototype.sit).toBeTypeOf('function');
      expect(Widget.from).toBeUndefined();
    } finally {
      delete globalThis.LegacyKept;
      delete globalThis.LegacyWidget;
    }
  });
});

describe('simulateLegacyEngine', () => {
  it('hoists a guard the engine satisfies and drops one it does not', () => {
    const out = simulateLegacyEngine(
      '.a{color:red}@supports not (inset: 0){.a{color:blue}}@supports (display:grid){.b{color:green}}',
    );
    expect(out).toBe('.a{color:red}.a{color:blue}');
  });

  // The modern half of a progressive-enhancement pair must go, or the
  // simulation would run a branch the TV never reaches — while its `not` twin
  // is hoisted, leaving both active at once.
  it('resolves every operand of an and/or condition', () => {
    expect(simulateLegacyEngine('@supports (display:flex) and (position:sticky){.a{color:red}}'))
      .toBe('');
    expect(simulateLegacyEngine('@supports (display:grid) or (display:flex){.a{color:red}}'))
      .toBe('.a{color:red}');
    expect(simulateLegacyEngine('@supports not (display:flex){.a{color:red}}')).toBe('');
  });

  it('drops a rule whose selector holds an unparsable pseudo-element', () => {
    expect(simulateLegacyEngine('.a::placeholder{color:blue}.b{color:red}')).toBe('.b{color:red}');
  });

  // Removing either would model the engine less faithfully than leaving it —
  // see the table above POST_53_PROP.
  it('keeps the two accepted divergences it deliberately does not model', () => {
    const css = '.a{overflow-anchor:none;scroll-behavior:smooth}';
    expect(simulateLegacyEngine(css)).toBe(css);
  });

  it('strips flex and grid gap in every form', () => {
    const out = simulateLegacyEngine(
      '.a{display:flex;gap:8px;color:red}.b{row-gap:4px;column-gap:2px;margin:0}',
    );
    expect(out).toBe('.a{display:flex;color:red}.b{margin:0}');
  });

  it('drops a whole rule whose selector list holds an unparsable pseudo-class', () => {
    // The engine discards the group, so a legacy selector sharing the rule dies
    // with it — the hazard this simulation exists to surface.
    const out = simulateLegacyEngine('.a.focused,.a:focus-within{outline:1px}.b{color:red}');
    expect(out).toBe('.b{color:red}');
  });

  it('keeps a legacy selector split into its own rule', () => {
    const out = simulateLegacyEngine('.a.focused{outline:1px}.a:focus-within{outline:1px}');
    expect(out).toBe('.a.focused{outline:1px}');
  });

  it('drops declarations Chromium 53 cannot parse, keeping their siblings', () => {
    const out = simulateLegacyEngine(
      '.a{display:grid;grid-template-columns:1fr;color:red}'
        + '.b{backdrop-filter:blur(4px);position:sticky;top:0}',
    );
    expect(out).toBe('.a{color:red}.b{top:0}');
  });

  it('leaves pre-53 values of the same properties alone', () => {
    const out = simulateLegacyEngine('.a{display:flex;position:absolute}');
    expect(out).toBe('.a{display:flex;position:absolute}');
  });

  it('keeps the hoisted fallback where the original block sat', () => {
    const out = simulateLegacyEngine(
      '.a{margin-left:auto}@supports not (inset: 0){.p > * + *{margin-left:32px}}.z{color:red}',
    );
    expect(out.indexOf('.p > * + *')).toBeGreaterThan(out.indexOf('margin-left:auto'));
    expect(out.indexOf('.p > * + *')).toBeLessThan(out.indexOf('.z'));
  });
});
