import { it } from 'node:test';
import assert from 'node:assert/strict';
import { canExecute, canonicalJson, contractEntry, loadContractFile, sha256Hex, validate } from '../contracts/validate.js';
import { VOCABULARY_V1, lintScreen, validateScreen, validateTokens, renderStoredDesign } from '../runtime/design/index.js';
import { errorCode, fixtureJson, screen, stored, tokens } from './fixtures/design/helpers.mjs';

it('(a) all 22 vocabulary kinds are accepted by the contract and lint', () => {
  const doc = screen();
  const stack = [...doc.nodes];
  const found = new Set();
  while (stack.length) { const node = stack.pop(); found.add(node.kind); stack.push(...(node.children ?? [])); }
  assert.equal(VOCABULARY_V1.length, 22);
  assert.deepEqual([...found].sort(), [...VOCABULARY_V1].sort());
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.deepEqual(lintScreen(doc), { ok: true, errors: [], warnings: [] });
  assert.equal(validate(tokens().contract, tokens()).ok, true);
});

for (const [name, mutate, code] of [
  ['unknown component', (s) => { s.nodes[0].kind = 'script'; }, 'design_ir_invalid'],
  ['freeform HTML', (s) => { s.nodes[0].html = '<div>'; }, 'design_ir_invalid'],
  ['inline style', (s) => { s.nodes[0].style = 'color:red'; }, 'design_ir_invalid'],
  ['event handler', (s) => { s.nodes[0].onclick = 'alert(1)'; }, 'design_ir_invalid'],
  ['unsafe id', (s) => { s.nodes[0].id = 'x" onclick="x'; }, 'design_ir_invalid'],
  ['duplicate id', (s) => { s.nodes[0].children[0].id = 'root'; }, 'design_duplicate_id'],
  ['external link target', (s) => { s.nodes[0].children[1].children[1].target = 'https://example.invalid'; }, 'design_ir_invalid'],
  ['unresolved link target', (s) => { s.nodes[0].children[1].children[1].target = 'missing'; }, 'design_reference_invalid'],
  ['table row width', (s) => { s.nodes[0].children.find((n) => n.kind === 'table').rows[0].pop(); }, 'design_ir_invalid'],
  ['unknown envelope key', (s) => { s.brand = 'other'; }, 'design_ir_invalid'],
  ['unsupported vocabulary', (s) => { s.vocabulary = 2; }, 'design_ir_invalid'],
  ['unsupported major', (s) => { s.major = 2; }, 'contract_too_new'],
  ['unsupported reader', (s) => { s.minor = 2; s.min_reader = 2; }, 'contract_too_new'],
  ['lone surrogate', (s) => { s.title = '\ud800'; }, 'design_ir_invalid'],
  ['trailing newline in id', (s) => { s.nodes[0].id += '\n'; }, 'design_ir_invalid'],
  ['trailing newline in renderer version', (s) => { s.renderer_version += '\n'; }, 'design_ir_invalid'],
]) {
  it(`(a) rejects ${name} with a stable code`, () => {
    const doc = screen(); mutate(doc);
    assert.throws(() => validateScreen(doc), errorCode(code));
    assert.equal(lintScreen(doc).ok, false);
    assert.ok(lintScreen(doc).errors.some((e) => e.code === code));
  });
}

it('(a) node/depth/byte bounds refuse adversarial IR before recursive schema traversal', () => {
  const doc = screen();
  let node = { kind: 'text', id: 'leaf', text: 'Leaf' };
  for (let i = 0; i < 17; i++) node = { kind: 'stack', id: `stack${i}`, children: [node] };
  doc.nodes = [node];
  assert.throws(() => validateScreen(doc), errorCode('design_limit'));
  assert.equal(validate(doc.contract, doc).ok, false);
  for (let i = 0; i < 200; i++) node = { kind: 'stack', id: `deep${i}`, children: [node] };
  doc.nodes = [node];
  assert.ok(validate(doc.contract, doc).schemaErrors[0].startsWith('design_limit:'));
  const many = screen();
  many.nodes = Array.from({ length: 2000 }, (_, i) => ({ kind: 'stack', id: `container${i}`, children: [{ kind: 'text', id: `text${i}`, text: 'x' }] }));
  assert.throws(() => validateScreen(many), errorCode('design_limit'));
  const large = screen(); large.nodes = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', id: `large${i}`, text: '🧪'.repeat(1000) }));
  assert.throws(() => validateScreen(large), errorCode('design_limit'));
  const cyclic = screen(); cyclic.nodes[0].children.push(cyclic.nodes[0]);
  assert.equal(validate(cyclic.contract, cyclic).ok, false);
  assert.throws(() => validateScreen(cyclic), errorCode('design_ir_invalid'));
});

it('(a) blank labels produce deterministic lint warnings without rejecting text', () => {
  const doc = screen(); doc.nodes = [{ kind: 'button', id: 'blank', label: '  ', variant: 'primary' }];
  assert.deepEqual(lintScreen(doc), { ok: true, errors: [], warnings: [{ code: 'design_label_blank', path: 'blank', message: 'Visible label is blank' }] });
});

it('(a) shared JSON subvalues remain valid, while component ids remain unique', () => {
  const doc = screen();
  const row = ['Repeated', 'Draft'];
  const table = doc.nodes[0].children.find((node) => node.kind === 'table');
  table.rows = [row, row];
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.equal(lintScreen(doc).ok, true);
});

it('(a) table-heavy IR and exact node/depth boundaries remain executable within the byte limit', () => {
  const doc = screen();
  doc.nodes = Array.from({ length: 1800 }, (_, i) => ({ kind: 'table', id: `table${i}`, label: 'T', columns: ['C'], rows: Array.from({ length: 6 }, () => ['']) }));
  assert.ok(Buffer.byteLength(canonicalJson(doc)) < 512 * 1024);
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.equal(lintScreen(doc).ok, true);
  doc.nodes = Array.from({ length: 2000 }, (_, i) => ({ kind: 'divider', id: `node${i}` }));
  assert.equal(validate(doc.contract, doc).ok, true);
  doc.nodes.push({ kind: 'divider', id: 'overflow' });
  assert.throws(() => validateScreen(doc), errorCode('design_limit'));
  let node = { kind: 'text', id: 'leaf', text: 'Leaf' };
  for (let i = 0; i < 15; i++) node = { kind: 'stack', id: `level${i}`, children: [node] };
  doc.nodes = [node];
  assert.equal(lintScreen(doc).ok, true);
  doc.nodes = [{ kind: 'stack', id: 'overflow', children: [node] }];
  assert.throws(() => validateScreen(doc), errorCode('design_limit'));
});

it('(a) every vocabulary branch closes its properties and rejects missing fields', () => {
  const nodes = [];
  const stack = [...screen().nodes];
  while (stack.length) { const node = stack.pop(); nodes.push(node); stack.push(...(node.children ?? [])); }
  for (const kind of VOCABULARY_V1) {
    const node = structuredClone(nodes.find((candidate) => candidate.kind === kind));
    const doc = screen(); doc.nodes = [{ ...node, onclick: 'execute()' }];
    assert.throws(() => validateScreen(doc), errorCode('design_ir_invalid'), kind);
    const missing = { ...node }; delete missing.id; doc.nodes = [missing];
    assert.throws(() => validateScreen(doc), errorCode('design_ir_invalid'), kind);
  }
});

for (const attack of fixtureJson('hostile.json').tokens) {
  it(`(a) rejects hostile CSS token ${JSON.stringify(attack)}`, () => {
    for (const apply of [(t) => { t.color.primary = attack; }, (t) => { t.font_family = attack; }, (t) => { t.space = attack; }]) {
      const doc = tokens(); apply(doc);
      assert.equal(validate(doc.contract, doc).ok, false);
      assert.throws(() => validateTokens(doc), errorCode('design_tokens_invalid'));
    }
  });
}

it('(a) rejects oversized, nonfinite, negative and unknown tokens', () => {
  const large = tokens(); large.color.primary = 'x'.repeat(64 * 1024);
  assert.throws(() => validateTokens(large), errorCode('design_limit'));
  for (const value of [-1, 65, NaN, Infinity]) {
    const doc = tokens(); doc.space = value;
    assert.throws(() => validateTokens(doc), errorCode('design_tokens_invalid'));
    assert.equal(validate(doc.contract, doc).ok, false);
  }
  const unknown = tokens(); unknown.url = 'https://example.invalid';
  assert.throws(() => validateTokens(unknown), errorCode('design_tokens_invalid'));
  const newline = tokens(); newline.color.primary += '\n';
  assert.throws(() => validateTokens(newline), errorCode('design_tokens_invalid'));
});

it('(d) screen minor 1 records are strict, self-contained and refuse unsafe older execution', () => {
  assert.equal(contractEntry('aithema.journal.record').minor, 1);
  assert.equal(contractEntry('aithema.screen').minor, 1);
  const doc = stored().document;
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.deepEqual(canExecute(doc.data.screen_ir, { 'aithema.screen': { major: 1, minor: 0 } }), { ok: false, code: 'contract_too_new' });
  for (const field of ['renderer_version', 'generator_id']) {
    const broken = structuredClone(doc); delete broken.data.screen_ir[field];
    assert.equal(validate('aithema.screen', broken.data.screen_ir).ok, false);
  }
  for (const field of ['minor', 'min_reader']) {
    const broken = structuredClone(doc); broken.data.screen_ir[field] = 0;
    assert.equal(validate('aithema.screen', broken.data.screen_ir).ok, false);
  }
  const broken = structuredClone(doc); broken.data.screen_ir.nodes[0].html = '<script>';
  broken.data.screen_ir_sha256 = sha256Hex(canonicalJson(broken.data.screen_ir));
  // The foundation journal deliberately stores opaque IR, including P13's
  // legacy fixtures. Its semantics stay unchanged; the real renderer executes
  // only the new, separately validated screen and tokens contracts.
  assert.equal(validate(broken.contract, broken).ok, true);
  const { seq, ...submission } = broken;
  assert.throws(() => renderStoredDesign({ bytes: Buffer.from(canonicalJson(submission)), document: broken }), errorCode('design_ir_invalid'));
});

it('(a) every lint/error code is in the canonical catalogue', () => {
  const catalog = new Set(loadContractFile('error-codes.json').design_diagnostics.map((row) => row.code));
  for (const code of ['design_ir_invalid','design_tokens_invalid','design_limit','design_duplicate_id','design_reference_invalid','design_label_blank']) assert.ok(catalog.has(code));
});
