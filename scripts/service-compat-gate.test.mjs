import { describe, expect, it } from 'vitest';
import { scanServiceSource } from './service-compat-gate.mjs';

describe('service compatibility gate', () => {
  it('rejects syntax that Node.js 0.12 cannot parse', () => {
    const violations = scanServiceSource(`
      const run = async ({ value = 1 }) => \`\${value}\`;
      for (const item of items) run(item);
    `);

    expect(violations.map(item => item.name)).toEqual(expect.arrayContaining([
      'const declaration',
      'arrow function',
      'destructuring',
      'default binding value',
      'template literal',
      'for...of statement',
    ]));
  });

  it('rejects unsupported runtime APIs outside the compatibility module', () => {
    const violations = scanServiceSource(`
      Buffer.from('a');
      crypto_1.randomInt(0, 10);
      value.padStart(2, '0');
      fs.mkdirSync(dir, { recursive: true });
      new Map();
    `);

    expect(violations.map(item => item.name)).toEqual([
      'unsupported API Buffer.from',
      'unsupported method randomInt',
      'unsupported method padStart',
      'recursive fs.mkdirSync option',
      'unsupported constructor Map',
    ]);
  });

  it('allows ES5 output and guarded native APIs in compat.js', () => {
    expect(scanServiceSource(`
      var nativeFrom = Buffer.from;
      var output = nativeFrom ? nativeFrom(value) : new Buffer(value);
      fs.mkdirSync(dir, { recursive: true });
    `, 'compat.js')).toEqual([]);
  });
});
