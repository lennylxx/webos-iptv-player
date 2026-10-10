import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import { noMixedLegacySelectorPlugin } from '../stylelint.config.mjs';
import {
  isPost53Selector,
  postTargetApis,
  postTargetSelectors,
  removeApis,
  simulateLegacyEngine,
  splitSelectorList,
  unclassifiedSelectorFeatures,
} from './chromium-53-simulation.mjs';

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

// The stylelint rule in stylelint.config.mjs enforces statically what the
// simulation above models: a post-53 selector drops its whole rule.
// Selectors Chromium 53 cannot parse: post-53 pseudo-classes and elements
// (Chrome 54 through 119), never-shipped ones, any letter case, and new
// grammar inside selectors it otherwise supports.
const POST_53_EXAMPLES = [
  '.x:focus-within',
  'input::placeholder',
  ':is(.a) .b',
  '.a:where(.b)',
  '.a:has(.b)',
  'x-el:defined',
  'input::file-selector-button',
  'dialog:modal',
  '.field:user-invalid',
  '.x:has-slotted',
  '.x:FOCUS-WITHIN',
  'input::PlaceHolder',
  ':IS(.a) .b',
  '.a:not(.b, .c)',
  'li:nth-child(2 of .item)',
  'li:NTH-LAST-CHILD(odd OF .item)',
  'p:lang(l1, l2)',
  'p:lang(*-x)',
  '[data-a="b" s]',
];

describe('isPost53Selector', () => {
  it('matches every post-53 example and the simulation drops its rule', () => {
    for (const modern of POST_53_EXAMPLES) {
      expect(isPost53Selector(modern), modern).toBe(true);
      expect(simulateLegacyEngine(`.legacy, ${modern} { color: red; }`)).not.toContain('color');
    }
  });

  it('leaves selectors Chromium 53 supports alone', () => {
    for (const legacy of [
      '.a:focus',
      'a:hover',
      '.a:not(.b)',
      'li:nth-child(2n)',
      'li:nth-child(2n + 1)',
      'p::before',
      'p::selection',
      'input:placeholder-shown',
      'input:read-only',
      ':-webkit-any(.a)',
      '::-webkit-scrollbar',
      'p:lang(l1)',
      '[data-a="b" i]',
      '[data-a="x s"]',
      '.a:not([data-x="1,2"])',
    ]) {
      expect(isPost53Selector(legacy), legacy).toBe(false);
    }
  });

  it('classifies every selector feature BCD says the target lacks', () => {
    expect(unclassifiedSelectorFeatures()).toEqual([]);
    expect(postTargetSelectors()).toEqual(expect.arrayContaining([':has-slotted', ':target-before']));
  });
});

describe('iptv/no-mixed-legacy-selector', () => {
  const lint = async (code) => {
    const { results } = await stylelint.lint({
      code,
      config: {
        plugins: [noMixedLegacySelectorPlugin],
        rules: { 'iptv/no-mixed-legacy-selector': true },
      },
    });
    return results[0].warnings.map((w) => w.text);
  };

  it('rejects a modern selector sharing a rule with a legacy one', async () => {
    const warnings = await lint('.x.focused, .x:focus-within { color: red; }');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.x:focus-within');
  });

  it('flags each post-53 selector form', async () => {
    for (const modern of POST_53_EXAMPLES) {
      expect(await lint(`.legacy, ${modern} { color: red; }`)).toHaveLength(1);
      expect(await lint(`${modern}, ${modern} .y { color: red; }`)).toEqual([]);
    }
  });

  it('allows modern-only and legacy-only rules', async () => {
    expect(await lint('.x:focus-within, .y:focus-within { color: red; }')).toEqual([]);
    expect(await lint('.x.focused, .y:focus { color: red; }')).toEqual([]);
  });

  it('checks rules nested in at-rules', async () => {
    expect(await lint('@supports not (display: grid) { .a, .b:focus-within { color: red; } }')).toHaveLength(1);
  });

  it('splits selector lists on top-level commas only', () => {
    expect(splitSelectorList('.a:not(.b, .c), [data-x="1,2"], .d')).toEqual([
      '.a:not(.b, .c)',
      '[data-x="1,2"]',
      '.d',
    ]);
  });

  it('does not split on escaped commas or parentheses', async () => {
    expect(splitSelectorList('.a\\,b, .c\\(d, .e')).toEqual(['.a\\,b', '.c\\(d', '.e']);
    expect(await lint('.old\\,name:focus-within, .other:focus-within { color: red; }')).toEqual([]);
  });
});
