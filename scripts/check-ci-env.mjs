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
  const reads = [];
  function visit(node) {
    if (access(node) && property(node) === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
      const parent = node.parent;
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
    const reads = ciEnvReads(parseSource(path, readFileSync(file, 'utf8')));
    if (reads.length || declarations[path]) {
      seen.add(path);
      const declaration = declarations[path];
      if (!declaration?.reason || JSON.stringify(reads) !== JSON.stringify([...declaration.reads].sort())) errors.push(`${path}: undeclared or changed ambient CI reads: ${JSON.stringify(reads)}`);
    }
  }
  for (const path of Object.keys(declarations)) if (!seen.has(path)) errors.push(`${path}: stale CI environment declaration`);
  return errors;
}
