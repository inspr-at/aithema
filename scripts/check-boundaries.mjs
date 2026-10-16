import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Shared with docs/architecture.md; the unit test rejects stale rendered tables.
// AIT-202 + AIT-205: one policy and one AST scan, including demo hosts.
export const layers = [
  { layer: 'core', path: 'packages/core', allows: [], role: 'Headless domain, contracts and shared engine primitives' },
  { layer: 'ui', path: 'packages/ui', allows: ['core'], role: 'Web components and browser presentation' },
  { layer: 'server', path: 'packages/server', allows: ['core'], role: 'Fetch handlers and persistence; #173 pins the legacy bridge' },
  { layer: 'host', path: 'demo', allows: ['core', 'ui', 'server', 'plugin'], role: 'Reference host; package imports except named browser sources' },
  { layer: 'plugin', path: 'plugins/*', allows: ['core', 'ui', 'server', 'plugin'], role: 'Exchangeable provider adapters' },
];
export function renderLayerTable() {
  return ['| Layer | Sources | Allowed cross-module edges (public exports only) | Responsibility |',
    '| --- | --- | --- | --- |', ...layers.map(row => `| ${row.layer} | \`${row.path}\` | ${row.allows.join(', ') || 'none'} | ${row.role} |`)].join('\n');
}
// Exact source -> package target allowances, never a blanket server -> plugin rule.
export const edgeExceptions = [
  { from: 'packages/server/elevenlabs-compat.js', targets: ['plugins/elevenlabs/src/provider.js', 'plugins/elevenlabs/src/callbacks.js'], reason: '#173: frozen legacy root exports' },
];
// #173's unpublished proof composes adapters that are deliberately not packed.
export const proofEdges = [
  { from: 'demo/server.js', target: 'plugins/composed-voice/ops/qualification-server.mjs', reason: 'AIT-160: explicitly flagged source-only qualification host' },
  { from: 'plugins/composed-voice/src/server.js', target: 'packages/server/src/composed-voice.js' },
  { from: 'plugins/composed-voice/src/qualification.js', target: 'packages/server/src/composed-voice.js' },
  { from: 'packages/server/src/composed-voice.js', target: 'packages/core/src/voice-components.js' },
  { from: 'plugins/composed-voice/src/component.js', target: 'packages/core/src/voice-components.js' },
  { from: 'plugins/elevenlabs/src/components.js', target: 'packages/core/src/voice-components.js' },
  { from: 'plugins/voxtral/src/index.js', target: 'packages/core/src/voice-components.js' },
  { from: 'plugins/composed-voice/src/configuration.js', target: 'plugins/elevenlabs/src/components.js' },
  { from: 'plugins/composed-voice/src/configuration.js', target: 'plugins/voxtral/src/index.js' },
];
// Explicit host-supplied entrypoints; pin the complete expressions, not all import().
export const hostImports = [...['VOICE', 'IMAGE'].map(kind =>
  `(await import('node:url')).pathToFileURL(resolve(process.env.AITHEMA_${kind}_HOST_MODULE)).href`),
  'pathToFileURL(resolve(process.env.AITHEMA_COMPOSED_QUALIFICATION_MODULE)).href'];
export const browserSources = ['demo/host.js', 'demo/consent-page.js', 'demo/admin-view.js', 'demo/fake-voice.js'];
export function renderExceptionTable() {
  return ['| Source | Exact exception | Owner / reason |', '| --- | --- | --- |',
    ...edgeExceptions.map(row => `| \`${row.from}\` | \`${row.targets.join('`, `')}\` | ${row.reason} |`),
    ...proofEdges.map(row => `| \`${row.from}\` | \`${row.target}\` | ${row.reason ?? '#173: unpublished composition proof'} |`),
    '| `demo/server.js` | Exact VOICE/IMAGE/COMPOSED_QUALIFICATION host-module expressions | #173 / AIT-160: injected host entrypoints |',
    ...browserSources.map(path => `| \`${path}\` | Relative public source URLs | AIT-205: native browser loading |`),
    '| `packages/server/src/voice-provider.js` | `packages/server/src/dev/local-voice-manifest.js` | AIT-218: private simulator manifest |',
    '| `plugins/fake-voice/src/manifest.js` | `packages/server/src/dev/local-voice-manifest.js` | Test-only manifest forwarder |',
    '| `plugins/fake-voice/src/server.js` | `packages/server/src/dev/local-voice.js` | Test-only compatibility forwarder |',
    '| `demo/fake-voice.js` | `plugins/fake-voice/src/client.js` | Test-only browser simulator forwarder |',
    '| `demo/server.js` | `@inspr/aithema-server/dev/local-voice` | Explicit simulator factory with production guard |'].join('\n');
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
  const imports = [], factories = new Set(), namespaces = new Set(), requires = new Set(['require']);
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const isFactory = node => {
    node = unwrap(node);
    return ts.isIdentifier(node) && factories.has(node.text) ||
      ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) && node.name.text === 'createRequire';
  };
  const isRequire = node => {
    node = unwrap(node);
    return ts.isIdentifier(node) && requires.has(node.text) || ts.isCallExpression(node) && isFactory(node.expression);
  };
  function bindings(node) {
    if (ts.isImportDeclaration(node) && ['node:module', 'module'].includes(literal(node.moduleSpecifier))) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const item of named.elements)
        if ((item.propertyName ?? item.name).text === 'createRequire') factories.add(item.name.text);
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      if (node.importClause?.name) namespaces.add(node.importClause.name.text);
    }
    const name = ts.isVariableDeclaration(node) ? node.name :
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.left : undefined;
    const value = ts.isVariableDeclaration(node) ? node.initializer : name && node.right;
    if (name && ts.isIdentifier(name) && value && isRequire(value)) requires.add(name.text);
    ts.forEachChild(node, bindings);
  }
  // Resolve aliases to a fixed point, including assignments and reversed chains.
  let size;
  do { size = factories.size + namespaces.size + requires.size; bindings(ast); }
  while (size !== factories.size + namespaces.size + requires.size);
  function visit(node) {
    let expression;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) expression = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) expression = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node)) expression = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      isRequire(node.expression))) {
      expression = node.arguments[0];
      if (!expression) imports.push({ specifier: undefined, position: node.getStart(ast) });
    }
    if (expression) imports.push({ specifier: literal(expression), expression: expression.getText(ast), position: expression.getStart(ast) });
    ts.forEachChild(node, visit);
  }
  visit(ast); return imports;
}
const development = path => /(?:^|\/)(?:test|tests)(?:\/|$)/u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
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
  modules.push({ path: 'demo', layer: layers.find(row => row.layer === 'host') });
  const errors = [], usedBrowserSources = new Set();
  const owner = path => modules.find(module => path.startsWith(module.path + '/'));
  for (const file of sourceFiles(root, ['packages', 'plugins', 'demo'])) {
    const path = relative(root, file).split(sep).join('/'), from = owner(path);
    if (path.startsWith('demo/test/')) continue; // AIT-205 scans non-test demo modules.
    const ast = parseSource(path, readFileSync(file, 'utf8'));
    for (const item of importSpecifiers(ast)) {
      const line = ast.getLineAndCharacterOfPosition(item.position).line + 1;
      const fail = message => errors.push(`${path}:${line}: ${message}`);
      const spec = item.specifier;
      if (spec === undefined && path === 'demo/server.js' && hostImports.includes(item.expression)) continue;
      if (spec === undefined) { fail('Non-literal import specifier; use a finite set of literal imports'); continue; }
      // Only the frozen simulator implementation can cross the dev boundary.
      if (development(path) || path === 'packages/server/src/dev/local-voice.js') continue;
      let to, target, subpath, targetPath;
      if (spec.startsWith('.')) {
        target = resolve(dirname(file), spec.split(/[?#]/u)[0]);
        if (existsSync(target)) target = realpathSync(target);
        targetPath = relative(root, target).split(sep).join('/');
        to = owner(targetPath);
        if (!to && targetPath.startsWith('node_modules/')) continue;
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
      if (to.path === 'packages/server' && subpath === './dev/local-voice') targetPath = 'packages/server/src/dev/local-voice.js';
      const simulator = targetPath === 'packages/server/src/dev/local-voice.js';
      if (simulator && !['demo/server.js', 'plugins/fake-voice/src/server.js'].includes(path)) { fail(`Production imports dev/test entry: ${spec}`); continue; }
      if (path === 'packages/server/src/voice-provider.js' && targetPath === 'packages/server/src/dev/local-voice-manifest.js') continue;
      if (path === 'plugins/fake-voice/src/manifest.js' && targetPath === 'packages/server/src/dev/local-voice-manifest.js') continue;
      if (/(?:^|\/)dev\//u.test(targetPath ?? '') && !simulator) { fail(`Production imports dev/test entry: ${spec}`); continue; }
      if (from === to && target) continue;
      if (proofEdges.some(edge => edge.from === path && edge.target === targetPath)) continue;
      if (from.layer.layer === 'host' && target && !simulator) {
        if (!browserSources.includes(path)) { fail(`Demo must import a package export: ${spec}`); continue; }
        usedBrowserSources.add(path);
      }
      // The fake-voice forwarder is the sole source-layout exception.
      if (simulator && path === 'plugins/fake-voice/src/server.js') continue;
      if (path === 'demo/fake-voice.js' && targetPath === 'plugins/fake-voice/src/client.js') continue;
      if (to.testOnly) { fail(`Test-only fake-voice dependency: ${spec}`); continue; }
      const exactCycle = edgeExceptions.some(edge => edge.from === path &&
        (edge.targets.includes(targetPath) || (to.exports ?? []).some(([key, value]) => key === subpath && targets(value).some(value => edge.targets.includes(`${to.path}/${value.slice(2)}`)))));
      if (from !== to && !from.layer.allows.includes(to.layer.layer) && !exactCycle) { fail(`Forbidden ${from.layer.layer} → ${to.layer.layer}: ${spec}`); continue; }
      const exported = (to.exports ?? []).some(([key, value]) => (!subpath || key === subpath) && targets(value).some(value =>
        value.startsWith('./') && !development(value) && (!/(?:^|\/)dev\//u.test(value) || simulator) && existsSync(resolve(root, to.path, value)) &&
        (!target || realpathSync(resolve(root, to.path, value)) === target)));
      if (!exported) fail(`Unexported target in ${to.path}: ${spec}`);
    }
  }
  for (const path of browserSources) if (existsSync(resolve(root, path)) && !usedBrowserSources.has(path)) errors.push(`${path}: stale browser source exception`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const errors = checkBoundaries(root);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Module boundaries: OK');
}
