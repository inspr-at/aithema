import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { sourceFiles, parseSource } from './check-boundaries.mjs';

const ambient = /^(?:CI$|GITHUB_|RUNNER_|CONTINUOUS_INTEGRATION$|BUILD_(?:ID|NUMBER|TAG)$|TF_BUILD$|JENKINS_|GITLAB_CI$|CIRCLECI$|TRAVIS$|BUILDKITE$|TEAMCITY_VERSION$)/u;
const property = node => ts.isPropertyAccessExpression(node) ? node.name.text :
  ts.isElementAccessExpression(node) && node.argumentExpression &&
  (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) ? node.argumentExpression.text : undefined;
const access = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
export function ciEnvReads(ast) {
  const reads = [], processes = new Set(['process']), environments = new Set();
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const isProcess = node => {
    node = unwrap(node);
    return ts.isIdentifier(node) && processes.has(node.text) || access(node) && property(node) === 'process' &&
      ts.isIdentifier(node.expression) && node.expression.text === 'globalThis';
  };
  const isEnvironment = node => {
    node = unwrap(node);
    return ts.isIdentifier(node) && environments.has(node.text) || access(node) && property(node) === 'env' && isProcess(node.expression);
  };
  // Resolve direct aliases before counting reads, including imported process/env.
  function aliases(node) {
    if (ts.isImportDeclaration(node) && ['node:process', 'process'].includes(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) processes.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) processes.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === 'env') environments.add(item.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isProcess(node.initializer)) processes.add(node.name.text);
      if (isEnvironment(node.initializer)) environments.add(node.name.text);
    }
    ts.forEachChild(node, aliases);
  }
  aliases(ast);
  function visit(node) {
    if ((access(node) || ts.isIdentifier(node)) && isEnvironment(node) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !ts.isImportSpecifier(node.parent)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      const key = access(parent) && parent.expression === node ? property(parent) : undefined;
      if (key && ambient.test(key)) reads.push(key);
      else if (!key) {
        // Computed reads and whole-environment forwarding also carry CI values.
        // Pin their exact expression and count; aliases must be declared as well.
        reads.push((access(parent) && parent.expression === node ? parent : node).getText(ast));
      }
    }
    // Destructuring/aliasing node:process can otherwise hide ambient reads.
    if (ts.isImportDeclaration(node) && ['node:process', 'process'].includes(node.moduleSpecifier.text)) reads.push('import node:process');
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === 'process') reads.push('alias process');
    ts.forEachChild(node, visit);
  }
  visit(ast); return reads.sort();
}
// Pin the containing statement for computed reads: changing a forwarding key list
// must not slip through merely because process.env[key] still appears twice.
export function computedCiEnvContexts(ast) {
  const contexts = [];
  function visit(node) {
    if (ts.isElementAccessExpression(node) && property(node) === undefined && access(node.expression) &&
      property(node.expression) === 'env' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process') {
      let context = node;
      while (context.parent && !ts.isVariableDeclaration(context) && !ts.isStatement(context)) context = context.parent;
      contexts.push(context.getText(ast).replace(/\s+/gu, ' '));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); return contexts.sort();
}
export function renderCiEnvTable(declarations) {
  return ['| Test or helper | Ambient reads / forwarding (occurrences) | Deliberate purpose |', '| --- | --- | --- |',
    ...Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b)).map(([path, { reads, reason }]) => {
      const counts = new Map();
      for (const read of reads) counts.set(read, (counts.get(read) ?? 0) + 1);
      return `| \`${path}\` | ${[...counts].map(([key, count]) => `\`${key}\` ×${count}`).join(', ')} | ${reason} |`;
    })].join('\n');
}
export function checkCiEnv(root, declarations) {
  const errors = [], seen = new Set();
  const files = sourceFiles(root, ['packages', 'plugins', 'test', 'demo/test']).filter(path => /(?:^|\/)(?:test|tests)(?:\/|$)/u.test(path));
  for (const file of files) {
    const path = relative(root, file).split(sep).join('/');
    const ast = parseSource(path, readFileSync(file, 'utf8'));
    const reads = ciEnvReads(ast), computedContexts = computedCiEnvContexts(ast);
    if (reads.length || declarations[path]) {
      seen.add(path);
      const declaration = declarations[path];
      if (!declaration?.reason || JSON.stringify(reads) !== JSON.stringify([...declaration.reads].sort()) ||
        JSON.stringify(computedContexts) !== JSON.stringify([...(declaration.computedContexts ?? [])].sort())) errors.push(`${path}: undeclared or changed ambient CI reads: ${JSON.stringify(reads)}`);
    }
  }
  for (const path of Object.keys(declarations)) if (!seen.has(path)) errors.push(`${path}: stale CI environment declaration`);
  return errors;
}
