import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MODERN_SYNTAX = [
  [ts.SyntaxKind.ArrowFunction, 'arrow function'],
  [ts.SyntaxKind.ClassDeclaration, 'class declaration'],
  [ts.SyntaxKind.ClassExpression, 'class expression'],
  [ts.SyntaxKind.TemplateExpression, 'template literal'],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template literal'],
  [ts.SyntaxKind.ForOfStatement, 'for...of statement'],
  [ts.SyntaxKind.AwaitExpression, 'await expression'],
  [ts.SyntaxKind.SpreadElement, 'spread element'],
  [ts.SyntaxKind.SpreadAssignment, 'object spread'],
  [ts.SyntaxKind.ShorthandPropertyAssignment, 'shorthand property'],
  [ts.SyntaxKind.MethodDeclaration, 'method shorthand'],
  [ts.SyntaxKind.ComputedPropertyName, 'computed property name'],
  [ts.SyntaxKind.TaggedTemplateExpression, 'tagged template'],
];

const FORBIDDEN_MEMBER_APIS = new Set([
  'Buffer.alloc',
  'Buffer.allocUnsafe',
  'Buffer.from',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isSafeInteger',
  'Object.entries',
  'Object.values',
  'Promise.allSettled',
  'Promise.any',
  'crypto.randomUUID',
  'crypto.randomInt',
  'fs.copyFileSync',
  'fs.cpSync',
  'fs.rmSync',
]);

const FORBIDDEN_METHODS = new Set([
  'endsWith',
  'finally',
  'find',
  'findIndex',
  'flat',
  'flatMap',
  'includes',
  'padStart',
  'padEnd',
  'randomInt',
  'randomUUID',
  'replaceAll',
  'startsWith',
  'trimEnd',
  'trimStart',
]);

const FORBIDDEN_CONSTRUCTORS = new Set([
  'Map',
  'Set',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
]);

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyPath(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = propertyPath(expression.expression);
    return owner ? owner + '.' + expression.name.text : undefined;
  }
  return undefined;
}

function isRecursiveMkdir(node) {
  if (!ts.isCallExpression(node) ||
      propertyPath(node.expression) !== 'fs.mkdirSync' ||
      node.arguments.length < 2) return false;
  const options = node.arguments[1];
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(property =>
    ts.isPropertyAssignment(property) &&
    property.name.getText() === 'recursive' &&
    property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

export function scanServiceSource(source, fileName = 'service.js') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const violations = [];
  const isCompatFile = path.basename(fileName) === 'compat.js';

  function add(node, name) {
    violations.push({ file: fileName, line: lineOf(sourceFile, node), name });
  }

  function visit(node) {
    for (const [kind, name] of MODERN_SYNTAX) {
      if (node.kind === kind) add(node, name);
    }

    if (ts.isVariableDeclarationList(node) &&
        (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
      add(node, node.flags & ts.NodeFlags.Const ? 'const declaration' : 'let declaration');
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
         ts.isMethodDeclaration(node)) && node.asteriskToken) {
      add(node, 'generator function');
    }
    if (ts.isParameter(node) && (node.dotDotDotToken || node.initializer)) {
      add(node, node.dotDotDotToken ? 'rest parameter' : 'default parameter');
    }
    if (ts.isBindingElement(node) && node.initializer) add(node, 'default binding value');
    if ((ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))) {
      add(node, 'destructuring');
    }
    if (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      add(node, 'async function');
    }
    if (node.questionDotToken) add(node, 'optional chaining');
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      add(node, 'nullish coalescing');
    }
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
         node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)) {
      add(node, 'exponentiation operator');
    }
    if (ts.isRegularExpressionLiteral(node) && /\/[a-z]*[uy][a-z]*$/i.test(node.text)) {
      add(node, 'Unicode or sticky regular expression');
    }

    if (!isCompatFile) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          FORBIDDEN_CONSTRUCTORS.has(node.expression.text)) {
        add(node, 'unsupported constructor ' + node.expression.text);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const api = propertyPath(node.expression);
        if (api && FORBIDDEN_MEMBER_APIS.has(api)) add(node, 'unsupported API ' + api);
        if (FORBIDDEN_METHODS.has(node.expression.name.text)) {
          add(node, 'unsupported method ' + node.expression.name.text);
        }
      }
      if (isRecursiveMkdir(node)) add(node, 'recursive fs.mkdirSync option');
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function jsFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...jsFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

export function scanServiceBuild(root) {
  return jsFiles(root).flatMap(file =>
    scanServiceSource(fs.readFileSync(file, 'utf8'), path.relative(root, file)));
}

function runCli() {
  const root = path.resolve(process.argv[2] || 'build/bundled-service');
  if (!fs.existsSync(root)) {
    throw new Error('Service build directory not found: ' + root);
  }
  const violations = scanServiceBuild(root);
  if (violations.length > 0) {
    const details = violations
      .map(item => `  ${item.file}:${item.line} ${item.name}`)
      .join('\n');
    throw new Error(
      'Bundled service is not compatible with webOS 4 / Node.js 0.12.2:\n' + details,
    );
  }
  console.log('Service compatibility gate passed (Node.js 0.12.2)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
