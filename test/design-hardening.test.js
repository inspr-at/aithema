import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../contracts/validate.js';
import { screenBounds } from '../contracts/design-invariants.js';
import { lintScreen, validateScreen, renderScreen } from '../runtime/design/index.js';
import { errorCode, fixtureText, input, screen, submission } from './fixtures/design/helpers.mjs';

for (const [name, mutate] of [
  ['empty sparse nodes', (doc) => { doc.nodes = new Array(1); }],
  ['leading node hole', (doc) => { doc.nodes.unshift(undefined); delete doc.nodes[0]; }],
  ['trailing node hole', (doc) => { doc.nodes.length++; }],
  ['undefined node', (doc) => { doc.nodes.push(undefined); }],
  ['null node', (doc) => { doc.nodes.push(null); }],
  ['sparse children', (doc) => { doc.nodes[0].children = new Array(1); }],
  ['interior child hole', (doc) => { delete doc.nodes[0].children[1]; }],
  ['undefined child', (doc) => { doc.nodes[0].children.push(undefined); }],
  ['null child', (doc) => { doc.nodes[0].children.push(null); }],
]) {
  it(`AIT-92 (a) refuses ${name} with design_ir_invalid before walking components`, () => {
    const doc = screen(); mutate(doc);
    assert.match(screenBounds(doc)[0], /^design_ir_invalid:/);
    const contract = validate(doc.contract, doc);
    assert.equal(contract.ok, false);
    assert.match(contract.schemaErrors[0], /^design_ir_invalid:/);
    const lint = lintScreen(doc);
    assert.equal(lint.ok, false);
    assert.equal(lint.errors[0].code, 'design_ir_invalid');
    assert.throws(() => validateScreen(doc), errorCode('design_ir_invalid'));
    assert.throws(() => renderScreen({ ...input(), screen_ir: doc }), errorCode('design_ir_invalid'));
    assert.throws(() => submission('a', { screen_ir: doc }), errorCode('design_ir_invalid'));
  });
}

it('AIT-92 (b) selects are disabled in preview and export golden HTML', () => {
  for (const [exporting, golden] of [[false, 'golden-preview.html'], [true, 'golden-export.html']]) {
    const { html } = renderScreen(input(), { exporting });
    const selects = html.match(/<select\b[^>]*>/g);
    assert.equal(selects.length, 1);
    assert.deepEqual(selects, ['<select disabled>']);
    assert.match(html, /<option>A &amp; B<\/option>/);
    assert.match(fixtureText(golden), /<select disabled>/);
  }
});

for (const [name, disagree] of [
  ['outer model_id', (data) => { data.generator_id = { ...data.generator_id, model_id: 'other-model' }; }],
  ['outer prompt_version', (data) => { data.generator_id = { ...data.generator_id, prompt_version: 'other-prompt' }; }],
  ['IR model_id', (data) => { data.screen_ir.generator_id = { ...data.generator_id, model_id: 'other-model' }; }],
  ['IR prompt_version', (data) => { data.screen_ir.generator_id = { ...data.generator_id, prompt_version: 'other-prompt' }; }],
  ['IR renderer_version', (data) => { data.screen_ir.renderer_version = '2'; }],
]) {
  it(`AIT-92 (c) refuses disagreeing ${name} in rendering and submission`, () => {
    const data = input(); disagree(data);
    assert.equal(validate(data.screen_ir.contract, data.screen_ir).ok, true);
    for (const exporting of [false, true]) {
      assert.throws(() => renderScreen(data, { exporting }), errorCode('design_input_invalid'));
    }
    assert.throws(() => submission('a', data), errorCode('design_input_invalid'));
  });
}

it('AIT-92 (c) accepts equal independent identities regardless of generator key order', () => {
  const data = input();
  data.generator_id = { prompt_version: data.generator_id.prompt_version, model_id: data.generator_id.model_id };
  assert.notEqual(data.generator_id, data.screen_ir.generator_id);
  assert.deepEqual(renderScreen(data), renderScreen(input()));
  assert.deepEqual(submission('a', data), submission());
});

const renderingValues = [
  [{ kind: 'input', id: 'field', label: 'Field', value: '', input_type: 'text' }, 'input_type', ['text', 'email', 'number', 'search']],
  [{ kind: 'button', id: 'button', label: 'Button', variant: 'primary' }, 'variant', ['primary', 'secondary']],
  [{ kind: 'alert', id: 'alert', text: 'Notice', variant: 'info' }, 'variant', ['info', 'success', 'warning', 'error']],
  [{ kind: 'heading', id: 'heading', text: 'Heading', level: 1 }, 'level', [1, 2, 3, 4, 5, 6]],
  [{ kind: 'grid', id: 'grid', children: [], columns: 1 }, 'columns', [1, 2, 3, 4]],
];

for (const [node, field, values] of renderingValues) {
  it(`AIT-92 (d) renders every permitted ${node.kind}.${field} value`, () => {
    for (const value of values) {
      const data = input(); data.screen_ir.nodes = [{ ...node, [field]: value }];
      const { html } = renderScreen(data);
      if (field === 'level') assert.match(html, new RegExp(`<h${value} [^>]+>Heading</h${value}>`));
      else if (field === 'input_type') assert.ok(html.includes(`<input type="${value}" value="" readonly>`));
      else if (field === 'columns') assert.ok(html.includes(`class="grid columns-${value}"`));
      else assert.ok(html.includes(`class="${node.kind} ${value}"`));
    }
  });

  it(`AIT-92 (d) refuses hostile ${node.kind}.${field} even after schema validation`, () => {
    for (const attack of ['"><svg onload="attack()">', '1 onmouseover=attack()', '</h1><script>attack()</script>',
      '__proto__', 'constructor', 'toString', '', null, 0, 7, true, '1', '2']) {
      const invalid = input(); invalid.screen_ir.nodes = [{ ...node, [field]: attack }];
      assert.equal(validate(invalid.screen_ir.contract, invalid.screen_ir).ok, false);
      assert.throws(() => renderScreen(invalid), errorCode('design_ir_invalid'));
      for (const exporting of [false, true]) {
        const data = input(); const candidate = { ...node };
        const children = [candidate];
        data.screen_ir.nodes = [{ kind: 'stack', id: 'container', children }];
        let reachedRenderer = false;
        // JSON validation ignores array methods. This borrowed map changes a
        // previously valid node only when the renderer walks these children,
        // isolating the renderer's own boundary from the schema's protection.
        children.map = (...args) => {
          reachedRenderer = true;
          candidate[field] = attack;
          return Array.prototype.map.apply(children, args);
        };
        assert.equal(validate(data.screen_ir.contract, data.screen_ir).ok, true);
        assert.throws(() => renderScreen(data, { exporting }), errorCode('design_ir_invalid'));
        assert.equal(reachedRenderer, true);
      }
    }
  });
}

it('AIT-92 (e) ordered lists match golden HTML with ol tags and unordered lists retain ul tags', () => {
  const data = input();
  data.screen_ir.nodes[0].children.find((node) => node.kind === 'list').ordered = true;
  const ordered = renderScreen(data).html;
  const golden = fixtureText('golden-ordered-preview.html');
  assert.equal(ordered, golden);
  assert.match(golden, /<ol id="list" class="list" data-element-ref="list">\n<li>[\s\S]*?<\/li>\n<\/ol>/);
  assert.doesNotMatch(ordered, /<ul\b/);
  assert.match(renderScreen(data, { exporting: true }).html, /<ol id="list"[\s\S]*?<\/ol>/);
  assert.match(renderScreen(input()).html, /<ul id="list"[\s\S]*?<\/ul>/);
});
