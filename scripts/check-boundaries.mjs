import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Shared with docs/architecture.md; the unit test rejects stale rendered tables.
// AIT-205 hook: add its host layer here when PR #173 lands; do not scan demo twice.
export const layers = [
  { layer: 'core', path: 'packages/core', allows: [], role: 'Headless domain, contracts and shared engine primitives' },
  { layer: 'ui', path: 'packages/ui', allows: ['core'], role: 'Web components and browser presentation' },
  { layer: 'server', path: 'packages/server', allows: ['core', 'plugin'], role: 'Fetch handlers, persistence and public adapter compatibility' },
  { layer: 'plugin', path: 'plugins/*', allows: ['core', 'ui', 'server', 'plugin'], role: 'Exchangeable provider adapters' },
];
export function renderLayerTable() {
  return ['| Layer | Sources | Allowed cross-module edges (public exports only) | Responsibility |',
    '| --- | --- | --- | --- |', ...layers.map(row => `| ${row.layer} | \`${row.path}\` | ${row.allows.join(', ') || 'none'} | ${row.role} |`)].join('\n');
}
const code = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
export function sourceFiles(root, dirs) {
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Never read configuration or env files, dependencies, or symlinks.
      if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (code.has(extname(path))) files.push(path);
    }
  }
  for (const dir of dirs) walk(resolve(root, dir));
  return files.sort();
}
export function parseSource(path, source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`${path}: cannot parse: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, ' ')}`);
  return ast;
}
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
export function importSpecifiers(ast) {
  const imports = [];
  function visit(node) {
    let expression;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) expression = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) expression = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node)) expression = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      expression = node.arguments[0];
      if (!expression) imports.push({ specifier: undefined, position: node.getStart(ast) });
    }
    if (expression) imports.push({ specifier: literal(expression), position: expression.getStart(ast) });
    ts.forEachChild(node, visit);
  }
  visit(ast); return imports;
}
const development = path => /(?:^|\/)(?:test|tests|dev)(?:\/|$)/u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
function exportEntries(value) {
  if (typeof value === 'string') return [['.', value]];
  if (!value || typeof value !== 'object') return [];
  if (!Object.keys(value).some(key => key.startsWith('.'))) return [['.', value]];
  return Object.entries(value);
}
function targets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(targets);
}
export function checkBoundaries(root) {
  root = resolve(root);
  const modules = [];
  for (const group of ['packages', 'plugins']) {
    if (!existsSync(resolve(root, group))) continue;
    for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = `${group}/${entry.name}`, manifest = resolve(root, path, 'package.json');
      const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
      const layer = layers.find(row => row.path === path || row.path === `${group}/*`);
      if (!layer) throw new Error(`Undeclared layer: ${path}`);
      modules.push({ path, layer, name: pkg.name, exports: exportEntries(pkg.exports), testOnly: path === 'plugins/fake-voice' });
    }
  }
  const errors = [];
  const owner = path => modules.find(module => path.startsWith(module.path + '/'));
  for (const file of sourceFiles(root, ['packages', 'plugins'])) {
    const path = relative(root, file).split(sep).join('/'), from = owner(path);
    const ast = parseSource(path, readFileSync(file, 'utf8'));
    for (const item of importSpecifiers(ast)) {
      const line = ast.getLineAndCharacterOfPosition(item.position).line + 1;
      const fail = message => errors.push(`${path}:${line}: ${message}`);
      const spec = item.specifier;
      if (spec === undefined) { fail('Non-literal import specifier; use a finite set of literal imports'); continue; }
      // Tests/dev deliberately exercise private implementation and host fixtures.
      // Nonliteral specifiers still fail above, including in these entry points.
      if (development(path)) continue;
      let to, target, subpath;
      if (spec.startsWith('.')) {
        target = resolve(dirname(file), spec.split(/[?#]/u)[0]);
        if (existsSync(target)) target = realpathSync(target);
        const targetPath = relative(root, target).split(sep).join('/');
        to = owner(targetPath);
        if (!to) { fail(`Import escapes declared modules: ${spec}`); continue; }
        if (development(targetPath)) { fail(`Production imports dev/test entry: ${spec}`); continue; }
      } else {
        to = modules.find(module => module.name && (spec === module.name || spec.startsWith(module.name + '/')));
        if (!to) {
          if (spec.startsWith('@inspr/aithema-')) fail(`Unknown workspace package: ${spec}`);
          continue;
        }
        subpath = spec === to.name ? '.' : '.' + spec.slice(to.name.length);
      }
      if (from === to && target) continue;
      if (to.testOnly) { fail(`Test-only fake-voice dependency: ${spec}`); continue; }
      if (from !== to && !from.layer.allows.includes(to.layer.layer)) { fail(`Forbidden ${from.layer.layer} → ${to.layer.layer}: ${spec}`); continue; }
      const exported = to.exports.some(([key, value]) => (!subpath || key === subpath) && targets(value).some(value =>
        value.startsWith('./') && !development(value) && existsSync(resolve(root, to.path, value)) &&
        (!target || realpathSync(resolve(root, to.path, value)) === target)));
      if (!exported) fail(`Unexported target in ${to.path}: ${spec}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const errors = checkBoundaries(root);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Module boundaries: OK');
}
