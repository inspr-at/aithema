import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import ts from 'typescript';
import { MANIFEST_SCHEMA, PLUGIN_KINDS } from '@inspr/aithema-core';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
test('every consumer-guide import resolves through a real package export', async () => {
  const guide = readFileSync(new URL('../docs/embedding.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```js\n([\s\S]*?)```/gu)]; assert.ok(examples.length >= 3);
  let imports = 0;
  for (const [, example] of examples) {
    for (const match of example.matchAll(/import\s+(?:\{([^}]+)\}\s+from\s+)?['"]([^'"]+)['"]/gu)) {
      const module = await import(match[2]); imports++;
      for (const field of (match[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const symbol = field.split(/\s+as\s+/u)[0]; assert.ok(Object.hasOwn(module, symbol), `${match[2]} exports ${symbol}`);
      }
    }
  }
  assert.ok(imports >= 5); await window.happyDOM.close();
});

function contractSource(text) {
  return ts.createSourceFile('plugin-contract.d.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function contractSymbols(source) {
  return source.statements.flatMap(node => {
    if (ts.isExportDeclaration(node)) return node.exportClause.elements.map(item => item.name.text);
    return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && node.name ? [node.name.text] : [];
  }).sort();
}
const printer = ts.createPrinter({ removeComments: true });
function declarationShapes(source) {
  return new Map(source.statements.filter(node => node.name).map(node => [node.name.text,
    printer.printNode(ts.EmitHint.Unspecified, node, source)]));
}
test('plugin guide tracks every contract symbol and exact operation/consent/reasoning shapes', () => {
  const guide = readFileSync(new URL('../docs/plugins.md', import.meta.url), 'utf8');
  const source = contractSource(readFileSync(new URL('../packages/core/src/plugin-contract.d.ts', import.meta.url), 'utf8'));
  const inventory = guide.split('<!-- contract-symbols:start -->')[1].split('<!-- contract-symbols:end -->')[0];
  const documented = [...inventory.matchAll(/^- `([A-Za-z0-9]+)`$/gmu)].map(match => match[1]).sort();
  assert.deepEqual(documented, contractSymbols(source), 'update the guide when a contract symbol changes');
  const snapshots = declarationShapes(contractSource([...guide.matchAll(/```ts\n([\s\S]*?)```/gu)].map(match => match[1]).join('\n')));
  const actual = declarationShapes(source);
  assert.deepEqual([...snapshots.keys()].sort(), ['ConsentGrant', 'ConsentPort', 'Health', 'OperationOptions', 'ProcessingScope', 'Reasoning', 'Terminal', 'Usage'].sort());
  for (const [symbol, shape] of snapshots) assert.equal(shape, actual.get(symbol), `${symbol} shape drifted; update docs/plugins.md`);
  // Both additions and member/type changes must be detectable, not just renames.
  assert.notDeepEqual(contractSymbols(contractSource('export interface NewPort {}\n' + source.text)), documented);
  assert.notEqual(declarationShapes(contractSource(source.text.replace('deadlineAt: number', 'deadlineAt: string'))).get('OperationOptions'), snapshots.get('OperationOptions'));
  for (const kind of PLUGIN_KINDS) assert.ok(guide.includes(`| \`${kind}\` |`), `document kind ${kind}`);
  for (const field of [...Object.keys(MANIFEST_SCHEMA.properties), ...Object.keys(MANIFEST_SCHEMA.properties.models.items.properties)]) {
    assert.ok(guide.includes(`\`${field}\``), `document manifest field ${field}`);
  }
  const embedding = readFileSync(new URL('../docs/embedding.md', import.meta.url), 'utf8');
  assert.ok(embedding.includes('(plugins.md#adding-a-model)'));
});
