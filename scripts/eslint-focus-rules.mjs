// ESLint rules that keep focus handling inside src/navigation/: a surface
// requests its ring through its focus scope.

const RING_WRITERS = new Set(['setRing', 'ringsIn']);
const MODE_WRITERS = new Set(['setInputMode']);
const POINTER_EVENTS = new Set(['mouseover', 'mouseenter', 'mousemove', 'mouseleave', 'mouseout', 'wheel']);
// Pointer Events shipped in Chrome 55; pointer lock is older and unrelated.
const POST_53_POINTER_EVENT =
  /^(?:pointer(?:over|enter|down|move|rawupdate|up|cancel|out|leave)|(?:got|lost)pointercapture)$/;
const GUARDED_MODULES = [
  { module: 'focus-ring', names: RING_WRITERS, message: (name) =>
    `Request focus through a focus scope (navigation/focus-scope) instead of painting it with ${name}().` },
  { module: 'input-mode', names: MODE_WRITERS, message: (name) =>
    `Only KeyHandler switches the input mode; read InputMode instead of calling ${name}().` },
];

function guarded(source) {
  return typeof source === 'string' ? GUARDED_MODULES.find((g) => source.endsWith(g.module)) : undefined;
}

// Resolves a string a rule can know without running the code: literals,
// templates and `+` of those, and consts initialized to them.
function staticString(node, sourceCode, depth = 0) {
  if (!node || depth > 8) return undefined;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'TemplateLiteral': {
      let out = node.quasis[0].value.cooked;
      for (let i = 0; i < node.expressions.length; i++) {
        const part = staticString(node.expressions[i], sourceCode, depth + 1);
        if (part === undefined) return undefined;
        out += part + node.quasis[i + 1].value.cooked;
      }
      return out;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined;
      const left = staticString(node.left, sourceCode, depth + 1);
      const right = left === undefined ? undefined : staticString(node.right, sourceCode, depth + 1);
      return right === undefined ? undefined : left + right;
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return staticString(node.expression, sourceCode, depth + 1);
    case 'Identifier': {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name);
        if (!variable) continue;
        const def = variable.defs[0];
        const decl = def?.parent;
        if (def?.type !== 'Variable' || decl?.kind !== 'const') return undefined;
        return staticString(def.node.init, sourceCode, depth + 1);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function memberName(member, sourceCode) {
  if (member.type !== 'MemberExpression') return undefined;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  return member.computed ? staticString(member.property, sourceCode) : undefined;
}

function reporter(context) {
  return (node, message) => context.report({ node, message });
}

const noRingWriter = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const sourceCode = context.sourceCode;
    const hit = reporter(context);
    return {
      ImportDeclaration(node) {
        const guard = guarded(node.source.value);
        if (!guard) return;
        for (const spec of node.specifiers) {
          const [variable] = sourceCode.getDeclaredVariables(spec);
          const refs = variable ? variable.references : [];
          if (spec.type === 'ImportSpecifier') {
            if (!guard.names.has(spec.imported.name)) continue;
            const message = guard.message(spec.imported.name);
            if (!refs.length) hit(spec, message);
            for (const ref of refs) hit(ref.identifier, message);
            continue;
          }
          // A namespace or default import reaches the writers by member access.
          for (const ref of refs) {
            const parent = ref.identifier.parent;
            const name = parent.type === 'MemberExpression' && parent.object === ref.identifier
              ? memberName(parent, sourceCode) : undefined;
            if (name !== undefined && !guard.names.has(name)) continue;
            hit(ref.identifier, guard.message(name ?? `${ref.identifier.name}.*`));
          }
        }
      },
      ExportNamedDeclaration(node) {
        const guard = node.source && guarded(node.source.value);
        if (!guard) return;
        for (const spec of node.specifiers) {
          const name = spec.local.name ?? spec.local.value;
          if (guard.names.has(name)) hit(spec, guard.message(name));
        }
      },
      ExportAllDeclaration(node) {
        const guard = guarded(node.source.value);
        if (guard) hit(node, guard.message([...guard.names][0]));
      },
    };
  },
};

const noRawPointerListener = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const sourceCode = context.sourceCode;
    const hit = reporter(context);
    return {
      CallExpression(node) {
        if (memberName(node.callee, sourceCode) !== 'addEventListener') return;
        const type = staticString(node.arguments[0], sourceCode);
        if (type === undefined || !POINTER_EVENTS.has(type)) return;
        hit(node, `Listen for nav:hover/nav:unhover, nav:pointermove, or InputMode, not raw '${type}'; `
          + 'KeyHandler owns pointer input.');
      },
    };
  },
};

const noPointerEvent = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const sourceCode = context.sourceCode;
    const hit = reporter(context);
    return {
      CallExpression(node) {
        if (memberName(node.callee, sourceCode) !== 'addEventListener') return;
        const type = staticString(node.arguments[0], sourceCode);
        if (type === undefined || !POST_53_POINTER_EVENT.test(type)) return;
        hit(node, `Chromium 53 (webOS 4) never fires '${type}'; use the mouse equivalent.`);
      },
    };
  },
};

// A compat gate, not a focus rule: it covers src/navigation/ too.
export const pointerEventRule = { 'no-pointer-event': noPointerEvent };

const noScrollIntoView = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const sourceCode = context.sourceCode;
    const hit = reporter(context);
    return {
      CallExpression(node) {
        if (memberName(node.callee, sourceCode) !== 'scrollIntoView') return;
        hit(node, 'Let the focus scope reveal its key; the reconcile pass keeps the ring in view.');
      },
    };
  },
};

export const focusRules = {
  'no-ring-writer': noRingWriter,
  'no-raw-pointer-listener': noRawPointerListener,
  'no-scroll-into-view': noScrollIntoView,
};
