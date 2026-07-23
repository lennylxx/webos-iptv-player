import { describe, expect, it } from 'vitest';
import { pseudoLocalize } from './pseudo';

describe('pseudoLocalize', () => {
  it('accents and expands copy while preserving placeholders', () => {
    const result = pseudoLocalize('Save {count} channels');
    expect(result).toMatch(/^\[!! /);
    expect(result).toContain('{count}');
    expect(result).toContain('Šåvé');
    expect(result.length).toBeGreaterThan('Save {count} channels'.length * 1.4);
  });

  it('keeps repeated placeholders available for interpolation', () => {
    expect(pseudoLocalize('{name} - {name}')).toContain('{name} - {name}');
  });
});
