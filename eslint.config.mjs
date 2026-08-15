import compat from 'eslint-plugin-compat';
import tsParser from '@typescript-eslint/parser';
import { DENYLIST } from './scripts/compat-gate.mjs';

const entryByKind = new Map(DENYLIST.map((entry) => [entry.kind, entry]));

function expressionName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return undefined;
  if (node.computed && node.property.type === 'Literal') return node.property.value;
  return !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
}

function objectProperty(node, name) {
  if (!node || node.type !== 'ObjectExpression') return undefined;
  return node.properties.find((property) =>
    property.type === 'Property'
    && ((property.key.type === 'Identifier' && property.key.name === name)
      || (property.key.type === 'Literal' && property.key.value === name)));
}

const unsupportedPatterns = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      NewExpression(node) {
        const name = expressionName(node.callee);
        const type = objectProperty(node.arguments[1], 'type');
        if ((name === 'Worker' || name === 'SharedWorker')
            && type?.value.type === 'Literal'
            && type.value.value === 'module') {
          context.report({ node, message: entryByKind.get('worker-option').message });
        }
      },
      CallExpression(node) {
        const name = expressionName(node.callee);
        if (name === 'postMessage' && objectProperty(node.arguments[1], 'transfer')) {
          context.report({ node, message: entryByKind.get('postmessage-option').message });
        }
        if (name === 'addEventListener' && objectProperty(node.arguments[2], 'signal')) {
          context.report({ node, message: entryByKind.get('listener-option').message });
        }
      },
    };
  },
};

// webOS 5 ships Chromium 68. esbuild down-levels post-68 *syntax* (optional
// chaining, etc.) but it does NOT polyfill missing *APIs*, which would silently
// fail on a real webOS 5 TV. Three rules below close that gap, all keyed to the
// "browserslist" field in package.json (shared with the CSS gate):
//   - compat/compat        — flags missing global/static APIs (structuredClone, …)
//   - no-restricted-syntax — a denylist for prototype methods compat can't see
//   - unsupported-patterns — checks unsupported constructor/call option shapes
export default [
  {
    files: ['src/**/*.ts'],
    plugins: {
      compat,
      'webos-compat': { rules: { 'unsupported-patterns': unsupportedPatterns } },
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'compat/compat': 'error',
      // eslint-plugin-compat catches global/static APIs (structuredClone,
      // Promise.allSettled, …) but NOT prototype *instance* methods, because it
      // can't infer that `arr.flat()` is Array.prototype.flat from the AST. Close
      // that blind spot with a name-based denylist of distinctive post-68 methods.
      // (If a custom object legitimately has one of these names, disable per-line.)
      'no-restricted-syntax': [
        'error',
        ...DENYLIST.filter((e) => e.kind === 'method').map((e) => ({
          selector: `CallExpression > MemberExpression[property.name='${e.name}']`,
          message: e.message,
        })),
      ],
      'webos-compat/unsupported-patterns': 'error',
    },
  },
  {
    // Tests run in Node under vitest, never on the webOS 5 WebView, so the
    // Chromium-68 compatibility gates don't apply to them.
    files: ['src/**/*.test.ts'],
    plugins: { compat },
    rules: {
      'compat/compat': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // polyfills.ts intentionally installs APIs the compat gate bans; it is the
    // one place allowed to reference them.
    files: ['src/polyfills.ts'],
    plugins: { compat },
    rules: {
      'compat/compat': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
