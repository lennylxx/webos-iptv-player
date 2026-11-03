import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { focusRules, pointerEventRule } from './eslint-focus-rules.mjs';
import { FOCUS_RULES } from '../eslint.config.mjs';

function lint(code, rule) {
  const linter = new Linter({ cwd: '/repo' });
  return linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, sourceType: 'module' },
    plugins: { focus: { rules: focusRules } },
    rules: { [`focus/${rule}`]: 'error' },
  }], '/repo/src/components/example.ts').map((m) => m.message);
}

function lintWith(code, rules, rule) {
  const linter = new Linter({ cwd: '/repo' });
  return linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, sourceType: 'module' },
    plugins: { rules: { rules } },
    rules: { [`rules/${rule}`]: 'error' },
  }], '/repo/src/navigation/example.ts').map((m) => m.message);
}

describe('focus ESLint rules', () => {
  it('rejects each use of a ring writer or the input-mode switch', () => {
    expect(lint(`
      import { setRing, hasRing } from '../navigation/focus-ring';
      import { ringsIn as rings } from './focus-ring';
      import { InputMode, setInputMode } from '../navigation/input-mode';
      setRing(a, true); setRing(b, false); rings(c); hasRing(d);
    `, 'no-ring-writer')).toEqual([
      // An unused import counts once, at the import.
      expect.stringContaining('setInputMode()'),
      expect.stringContaining('setRing()'),
      expect.stringContaining('setRing()'),
      expect.stringContaining('ringsIn()'),
    ]);
    expect(lint(`
      import { hasRing } from '../navigation/focus-ring';
      import { InputMode } from '../navigation/input-mode';
      import { setRing } from './other';
      setRing(a); hasRing(b);
    `, 'no-ring-writer')).toEqual([]);
  });

  it('sees through namespace imports and re-exports', () => {
    expect(lint(`
      import * as R from '../navigation/focus-ring';
      import * as M from '../navigation/input-mode';
      R.setRing(a, true); R['ringsIn'](b); R.hasRing(c);
      M.setInputMode('keys'); M.InputMode.current;
      const alias = R;
    `, 'no-ring-writer')).toEqual([
      expect.stringContaining('setRing()'),
      expect.stringContaining('ringsIn()'),
      expect.stringContaining('setInputMode()'),
      expect.stringContaining('R.*()'),
    ]);
    expect(lint(`
      export { setRing as paint } from '../navigation/focus-ring';
      export * from '../navigation/input-mode';
      export { hasRing } from '../navigation/focus-ring';
    `, 'no-ring-writer')).toHaveLength(2);
  });

  it('rejects raw pointer listeners, however the name is spelled', () => {
    expect(lint(`
      const MOVE = 'mouse' + 'move';
      const kind = 'over';
      el.addEventListener('mouseover', a);
      document['addEventListener']('wheel', b, { passive: false });
      root.addEventListener(\`mouseleave\`, c);
      root.addEventListener(\`mouse\${kind}\`, d);
      root.addEventListener(MOVE, e);
      root[\`addEventListener\`]('mouseout' as const, f);
    `, 'no-raw-pointer-listener')).toHaveLength(6);
    expect(lint(`
      let later = 'mouseover';
      el.addEventListener('nav:hover', a);
      el.addEventListener('click', b);
      el.addEventListener(type, c);
      el.addEventListener(later, d);
    `, 'no-raw-pointer-listener')).toEqual([]);
  });

  it('points a raw pointer listener at the nav:* events', () => {
    expect(lint("el.addEventListener('mousemove', a);", 'no-raw-pointer-listener'))
      .toEqual([expect.stringContaining('nav:pointermove')]);
  });

  it('rejects every pointer event Chromium 53 never fires, but not pointer lock', () => {
    const messages = lintWith(`
      const MOVE = 'pointer' + 'move';
      document.addEventListener(MOVE, a);
      el.addEventListener('pointerdown', b);
      el.addEventListener('pointerup', c);
      el.addEventListener('pointercancel', d);
      el.addEventListener('pointerenter', e);
      el.addEventListener('gotpointercapture', f);
    `, pointerEventRule, 'no-pointer-event');
    expect(messages).toHaveLength(6);
    expect(messages[0]).toBe("Chromium 53 (webOS 4) never fires 'pointermove'; use the mouse equivalent.");
    expect(lintWith(`
      document.addEventListener('pointerlockchange', a);
      el.addEventListener('mousemove', b);
      el.addEventListener('nav:pointermove', c);
    `, pointerEventRule, 'no-pointer-event')).toEqual([]);
  });

  it('gates pointer events in src/navigation too, where KeyHandler listens', async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintText("document.addEventListener('pointermove', () => {});\n",
      { filePath: 'src/navigation/example.ts' });
    expect(result.messages.map((m) => m.ruleId)).toContain('webos-compat/no-pointer-event');
  });

  it('rejects scrollIntoView calls', () => {
    expect(lint(`
      el.scrollIntoView({ block: 'nearest' });
      el.scrollIntoView();
      el[\`scrollIntoView\`]();
    `, 'no-scroll-into-view')).toHaveLength(3);
    expect(lint('const scrollIntoView = 1;', 'no-scroll-into-view')).toEqual([]);
  });

});

describe('focus ESLint suppressions', () => {
  const SUPPRESSION = /eslint-disable-next-line (focus\/[\w-]+(?:, focus\/[\w-]+)*) -- (.*)$/;

  it('name a known rule and the surface that still owns each legacy site', () => {
    const files = readdirSync('src', { recursive: true })
      .filter((f) => f.endsWith('.ts')).map((f) => path.join('src', f));
    const sites = [];
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('eslint-disable') || !line.includes('focus/')) continue;
        const match = SUPPRESSION.exec(line);
        expect(match, `${file}: ${line.trim()}`).not.toBeNull();
        for (const rule of match[1].split(', ')) expect(FOCUS_RULES).toContain(rule.slice('focus/'.length));
        sites.push({ file: file.split(path.sep).join('/'), rules: match[1].split(', '), reason: match[2] });
      }
    }
    expect(sites.length).toBeGreaterThan(0);
    const KIND = {
      'focus/no-ring-writer': 'ring writer',
      'focus/no-raw-pointer-listener': 'pointer listener',
      'focus/no-scroll-into-view': 'scrollIntoView call',
    };
    for (const { file, rules, reason } of sites) {
      if (file === 'src/components/player-osd.ts') continue;
      expect(rules, file).toHaveLength(1);
      expect(reason, file).toMatch(new RegExp(`^legacy ${KIND[rules[0]]} until .+ moves to a focus scope$`));
    }
  });

  it('fail lint once the site they cover is gone', async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintText(
      '// eslint-disable-next-line focus/no-scroll-into-view -- legacy scrollIntoView call until the example moves to a focus scope\nexport const a = 1;\n',
      { filePath: 'src/components/example.ts' },
    );
    expect(result.messages.map((m) => m.message)).toEqual([
      expect.stringContaining('Unused eslint-disable directive'),
    ]);
    const [covered] = await eslint.lintText(
      '// eslint-disable-next-line focus/no-scroll-into-view -- legacy scrollIntoView call until the example moves to a focus scope\nel.scrollIntoView();\n',
      { filePath: 'src/components/example.ts' },
    );
    expect(covered.messages).toEqual([]);
  });
});
