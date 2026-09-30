import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { canonicalJson, sha256Hex, validate, validateExtensions, index } from '../contracts/validate.js';
import { createExtensionRegistry, registerExtension, assertItemExtensions } from '../lib/extensions.js';
import { addWorkingItem, createWorkingSpec } from '../lib/working-spec.js';

const string = (maxLength = 1000) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const descriptor = (schema = object({ score: { type: 'number' }, evidence: string() }, ['score']), version = '1.0', namespace = 'x-demo.readiness') => ({ namespace, version, title: 'Synthetic analysis', schema });
const map = (data, version = '1.0', namespace = 'x-demo.readiness') => ({ [`${namespace}@${version.split('.')[0]}`]: { version, data } });
const code = (value) => ({ code: value, status: 422 });

it('(a) registers the descriptor contract and accepts bare and enveloped descriptors', () => {
  assert.equal(index.contracts.find(c => c.contract === 'aithema.extension').file, 'extension.schema.json');
  const doc = descriptor();
  assert.equal(validate('aithema.extension', doc).ok, true);
  assert.equal(validate('aithema.extension', { contract: 'aithema.extension', major: 1, minor: 0, min_reader: 0, ...doc }).ok, true);
  assert.equal(validate('aithema.extension', { contract: 'aithema.extension', ...doc }).ok, false);
  assert.throws(() => createExtensionRegistry([{ ...doc, contract: 'aithema.extension', major: 1, minor: 0, min_reader: 0 }]), code('extension_invalid'));
});

it('(a) registration is explicit, immutable and detached, with no shared state', () => {
  const original = descriptor();
  const registry = registerExtension(createExtensionRegistry(), original);
  original.schema.properties.score.type = 'boolean';
  assert.equal(registry[0].schema.properties.score.type, 'number');
  assert.ok(Object.isFrozen(registry[0].schema.properties));
  assert.equal(createExtensionRegistry().length, 0);
  assert.throws(() => assertItemExtensions(map({ score: 1 })), code('extension_unknown'));
  assert.doesNotThrow(() => assertItemExtensions(map({ score: 1 }), registry));
  assert.throws(() => registerExtension(registry, descriptor()), code('extension_invalid'));
  assert.throws(() => createExtensionRegistry({}), code('extension_invalid'));
});

const invalidDescriptors = {
  'bad namespace': { namespace: 'demo.readiness' },
  'missing namespace suffix': { namespace: 'x-demo' },
  'namespace newline': { namespace: 'x-demo.readiness\n' },
  'uppercase namespace': { namespace: 'x-Demo.readiness' },
  'bad version': { version: '1' },
  'patch version': { version: '1.0.1' },
  'padded version': { version: '01.0' },
  'unsafe version integer': { version: '9007199254740992.0' },
  'empty title': { title: '' },
  'unknown descriptor key': { arbitrary: true },
  'boolean schema': { schema: true },
  'unbounded string': { schema: { type: 'string' } },
  'unbounded array': { schema: { type: 'array', items: string() } },
  'array without items': { schema: { type: 'array', maxItems: 1 } },
  'open object': { schema: { type: 'object', properties: {} } },
  'additional properties allowed': { schema: { type: 'object', additionalProperties: true, properties: {} } },
  'required undefined property': { schema: object({}, ['absent']) },
  'negative limit': { schema: string(-1) },
  'fractional limit': { schema: string(1.5) },
  'unsafe limit': { schema: string(Number.MAX_SAFE_INTEGER + 1) },
  'empty enum': { schema: { enum: [] } },
  'enum incompatible with type': { schema: { type: 'boolean', enum: ['yes'] } },
  'enum breaches limit': { schema: { ...string(1), enum: ['long'] } },
  'union type': { schema: { type: ['string', 'boolean'], maxLength: 1 } },
  'null type': { schema: { type: 'null' } },
};
for (const keyword of ['$ref', 'allOf', 'oneOf', 'anyOf', 'pattern', 'minimum', 'maximum', 'default', 'format']) {
  invalidDescriptors[`unsupported ${keyword}`] = { schema: { ...string(), [keyword]: 'unsupported' } };
}
for (const [name, changes] of Object.entries(invalidDescriptors)) {
  it(`(a) refuses ${name}`, () => {
    assert.throws(() => createExtensionRegistry([{ ...descriptor(), ...changes }]), code('extension_invalid'));
  });
}

it('(a,b) validates every supported type, recursive objects/arrays and finite enum-only schemas', () => {
  const schema = object({ strings: { type: 'array', maxItems: 2, items: string(2) }, number: { type: 'number' }, integer: { type: 'integer' }, boolean: { type: 'boolean' }, track: { enum: ['short', 'full'] } }, ['integer']);
  const registry = createExtensionRegistry([descriptor(schema)]);
  const data = { strings: ['😀😀'], number: 0.5, integer: 1, boolean: false, track: 'short' };
  assert.doesNotThrow(() => assertItemExtensions(map(data), registry));
  for (const changed of [{ ...data, integer: 1.5 }, { ...data, integer: Number.MAX_SAFE_INTEGER + 1 }, { ...data, number: '1' }, { ...data, boolean: 0 }, { ...data, track: 'unknown' }, { ...data, extra: true }, { ...data, strings: [1] }]) {
    assert.throws(() => assertItemExtensions(map(changed), registry), code('extension_invalid'));
  }
  assert.throws(() => assertItemExtensions(map({}), registry), code('extension_invalid'));
  assert.throws(() => assertItemExtensions(map({ ...data, strings: ['aaa'] }), registry), code('extension_limit'));
  assert.throws(() => assertItemExtensions(map({ ...data, strings: ['a', 'b', 'c'] }), registry), code('extension_limit'));
});

it('(b) refuses malformed maps, mismatched versions, unknown majors and unknown exact minors', () => {
  const registry = createExtensionRegistry([descriptor()]);
  for (const extensions of [null, [], { 'x-demo.readiness@1': { version: '1.0' } }, { 'x-demo.readiness@1': { version: '1.0', data: {}, extra: true } }, { 'x-demo.readiness@2': { version: '1.0', data: {} } }, { 'x-demo.readiness@01': { version: '1.0', data: {} } }, { 'x-demo.readiness@1\n': { version: '1.0', data: {} } }]) {
    assert.throws(() => assertItemExtensions(extensions, registry), code('extension_invalid'));
  }
  for (const extensions of [map({ score: 1 }, '2.0'), map({ score: 1 }, '1.1'), map({ score: 1 }, '1.0', 'x-other.readiness')]) {
    assert.throws(() => assertItemExtensions(extensions, registry), code('extension_unknown'));
  }
  assert.doesNotThrow(() => assertItemExtensions(undefined, registry));
});

it('(b) boundary rejects hostile getters, proxies and non-JSON input without calling them', () => {
  const registry = createExtensionRegistry([descriptor()]);
  let calls = 0;
  const hostile = { get namespace() { calls++; return 'x-demo.readiness'; } };
  assert.throws(() => registerExtension(registry, hostile), /plain-data snapshot/);
  const extensions = { get 'x-demo.readiness@1'() { calls++; return { version: '1.0', data: {} }; } };
  assert.throws(() => assertItemExtensions(extensions, registry), /plain-data snapshot/);
  assert.equal(calls, 0);
  for (const data of [NaN, Infinity, undefined, new Date(), new Proxy({}, {})]) {
    assert.throws(() => assertItemExtensions(map(data), registry), /plain-data snapshot/);
  }
  assert.throws(() => assertItemExtensions(map({ score: 1, evidence: '\ud800' }), registry), code('extension_invalid'));
});

const previousSchema = object({ slot: object({ quote: string(8), kind: { type: 'string', maxLength: 8, enum: ['a', 'b'] } }, ['quote']), list: { type: 'array', maxItems: 4, items: { type: 'integer' } } }, ['slot']);
const evolutionAttacks = {
  'remove property': schema => { delete schema.properties.list; },
  'remove nested property': schema => { delete schema.properties.slot.properties.kind; },
  'add required property': schema => { schema.properties.new = { type: 'boolean' }; schema.required.push('new'); },
  'make optional property required': schema => { schema.required.push('list'); },
  'add nested required property': schema => { schema.properties.slot.required.push('kind'); },
  'narrow type': schema => { schema.properties.list.items.type = 'boolean'; },
  'narrow enum': schema => { schema.properties.slot.properties.kind.enum = ['a']; },
  'introduce enum': schema => { schema.properties.list.items.enum = [1]; },
  'lower string limit': schema => { schema.properties.slot.properties.quote.maxLength = 7; },
  'lower array limit': schema => { schema.properties.list.maxItems = 3; },
  'narrow array item string limit': schema => { schema.properties.list.items = string(1); },
};
for (const [name, attack] of Object.entries(evolutionAttacks)) {
  it(`(c) minor evolution refuses ${name}`, () => {
    const registry = createExtensionRegistry([descriptor(previousSchema)]);
    const schema = structuredClone(previousSchema);
    attack(schema);
    assert.throws(() => registerExtension(registry, descriptor(schema, '1.1')), code('extension_invalid'));
    assert.equal(registry.length, 1);
  });
}

it('(c) number-to-integer narrows while integer-to-number widens', () => {
  assert.throws(() => createExtensionRegistry([descriptor({ type: 'number' }), descriptor({ type: 'integer' }, '1.1')]), code('extension_invalid'));
  assert.doesNotThrow(() => createExtensionRegistry([descriptor({ type: 'integer' }), descriptor({ type: 'number' }, '1.1')]));
});

it('(c) additive minors preserve all older data and independent majors coexist', () => {
  const first = descriptor(previousSchema);
  const second = structuredClone(first);
  second.version = '1.1';
  second.schema.properties.optional = { type: 'boolean' };
  second.schema.properties.slot.properties.quote.maxLength = 9;
  second.schema.properties.slot.properties.kind.enum.push('c');
  second.schema.properties.list.maxItems = 5;
  second.schema.properties.list.items.type = 'number';
  second.schema.required = [];
  const third = structuredClone(second);
  third.version = '1.10';
  delete third.schema.properties.slot.properties.kind.enum;
  const nextMajor = descriptor({ type: 'boolean' }, '2.0');
  const registry = createExtensionRegistry([first, second, third, nextMajor]);
  const oldData = { slot: { quote: '12345678', kind: 'b' }, list: [0, 1, 2, 3] };
  for (const later of [first, second, third]) assert.equal(validateExtensions(map(oldData, later.version), [later]).ok, true);
  assert.doesNotThrow(() => assertItemExtensions({ ...map(oldData), ...map(true, '2.0') }, registry));
  assert.throws(() => registerExtension(registry, descriptor(previousSchema, '1.2')), code('extension_invalid'));
});

it('(c) canonical enum equality ignores object member order', () => {
  const schema = { ...object({ a: { type: 'integer' }, b: { type: 'integer' } }), enum: [{ a: 1, b: 2 }] };
  const next = { ...schema, enum: [{ b: 2, a: 1 }, { a: 2, b: 3 }] };
  const registry = createExtensionRegistry([descriptor(schema), descriptor(next, '1.1')]);
  assert.doesNotThrow(() => assertItemExtensions(map({ b: 2, a: 1 }), registry));
  assert.throws(() => createExtensionRegistry([descriptor({ enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })]), code('extension_invalid'));
});

it('(e) exactly 8 extension keys pass and 9 fail', () => {
  const descriptors = Array.from({ length: 9 }, (_, i) => descriptor({ type: 'boolean' }, '1.0', `x-demo.slot${i}`));
  const registry = createExtensionRegistry(descriptors);
  const extensions = Object.assign({}, ...descriptors.slice(0, 8).map(d => map(true, d.version, d.namespace)));
  assert.doesNotThrow(() => assertItemExtensions(extensions, registry));
  extensions['x-demo.slot8@1'] = { version: '1.0', data: true };
  assert.throws(() => assertItemExtensions(extensions, registry), code('extension_limit'));
});

it('(e) exactly 16 KiB canonical instance bytes pass and +1 fails', () => {
  const registry = createExtensionRegistry([descriptor(object({ text: string(20000) }))]);
  const extensions = map({ text: '' });
  const instance = extensions['x-demo.readiness@1'];
  instance.data.text = 'a'.repeat(16 * 1024 - Buffer.byteLength(canonicalJson(instance)));
  assert.equal(Buffer.byteLength(canonicalJson(instance)), 16 * 1024);
  assert.doesNotThrow(() => assertItemExtensions(extensions, registry));
  instance.data.text += 'a';
  assert.throws(() => assertItemExtensions(extensions, registry), code('extension_limit'));
});

it('(e) exactly 64 KiB canonical item extensions bytes pass and +1 fails', () => {
  const descriptors = Array.from({ length: 5 }, (_, i) => descriptor(object({ text: string(20000) }), '1.0', `x-demo.slot${i}`));
  const registry = createExtensionRegistry(descriptors);
  const extensions = Object.assign({}, ...descriptors.map(d => map({ text: '' }, d.version, d.namespace)));
  let remaining = 64 * 1024 - Buffer.byteLength(canonicalJson(extensions));
  for (const instance of Object.values(extensions)) {
    const fill = Math.min(remaining, 16 * 1024 - Buffer.byteLength(canonicalJson(instance)));
    instance.data.text = 'a'.repeat(fill);
    remaining -= fill;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(canonicalJson(extensions)), 64 * 1024);
  assert.doesNotThrow(() => assertItemExtensions(extensions, registry));
  Object.values(extensions).at(-1).data.text += 'a';
  assert.throws(() => assertItemExtensions(extensions, registry), code('extension_limit'));
});

it('(e) counts UTF-8 and escaping, rather than UTF-16 or raw text length', () => {
  const registry = createExtensionRegistry([descriptor(object({ text: string(20000) }))]);
  for (const character of ['😀', 'é', '\u0000']) {
    const extensions = map({ text: '' });
    const instance = extensions['x-demo.readiness@1'];
    const overhead = Buffer.byteLength(canonicalJson(instance));
    const bytes = Buffer.byteLength(canonicalJson(character)) - 2;
    const count = Math.floor((16 * 1024 - overhead) / bytes);
    instance.data.text = character.repeat(count) + 'a'.repeat(16 * 1024 - overhead - bytes * count);
    assert.equal(Buffer.byteLength(canonicalJson(instance)), 16 * 1024);
    assert.doesNotThrow(() => assertItemExtensions(extensions, registry));
    instance.data.text += 'a';
    assert.throws(() => assertItemExtensions(extensions, registry), code('extension_limit'));
  }
});

it('(e) schema depth exactly 6 passes and 7 fails through registration and contracts', () => {
  const nested = depth => {
    let schema = string(1);
    for (let i = 1; i < depth; i++) schema = i % 2 ? object({ value: schema }) : { type: 'array', maxItems: 1, items: schema };
    return schema;
  };
  assert.doesNotThrow(() => createExtensionRegistry([descriptor(nested(6))]));
  assert.throws(() => createExtensionRegistry([descriptor(nested(7))]), code('extension_limit'));
  assert.equal(validate('aithema.extension', descriptor(nested(7))).ok, false);
});

// The valid fixtures that existed when extensions landed (AIT-79). Their bytes are
// pinned; fixtures added later are validated below but not pinned here.
const PRE_EXTENSION_VALID_FIXTURES = [
  'authz.record.json',
  'budget.admit-denied.json',
  'budget.admit-idempotency-conflict.json',
  'budget.admit-ok.json',
  'budget.admit-request.json',
  'budget.admit-revoked.json',
  'budget.claim-after-void.json',
  'budget.claim-already-claimed.json',
  'budget.claim-ok.json',
  'budget.claim-request.json',
  'budget.holds-list.json',
  'budget.recover-fenced.json',
  'budget.recover-request.json',
  'budget.recover-response.json',
  'budget.recover-unknown.json',
  'budget.recover-void.json',
  'budget.settle-actual.json',
  'budget.settle-unknown.json',
  'element.ended.json',
  'element.error.json',
  'element.state.json',
  'element.submitted.json',
  'record.audit-restart.json',
  'record.authz-epoch.json',
  'record.budget-claim.json',
  'record.budget-hold.json',
  'record.budget-settle-actual.json',
  'record.budget-settle-void.json',
  'record.design-input.json',
  'record.op-result.json',
  'record.reaction-partial.json',
  'record.session-end-export.json',
  'record.session-end-working-spec-only.json',
  'record.session-purge.json',
  'record.source.json',
  'record.turn.json',
  'record.ui-confirm.json',
  'session.create-working-spec-only.json',
  'settings.executable.json',
  'snapshot.persisted.json',
  'snapshot.review.json',
  'snapshot.working-spec-only.json',
  'token.delegated.json',
  'token.session.json',
];

it('(f) all existing valid fixtures retain their canonical digests and validity; golden vector bytes remain unchanged', () => {
  const dir = new URL('../contracts/fixtures/valid/', import.meta.url);
  const fixtures = PRE_EXTENSION_VALID_FIXTURES.map(name => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8'))]);
  assert.equal(sha256Hex(canonicalJson(fixtures)), '8432f397c341123467fc8b083694627c308ff8c1b25d12f2db66823643dbadbe');
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const fixture = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(validate(fixture.contract, fixture.doc).ok, true, name);
  }
  assert.equal(sha256Hex(readFileSync(new URL('../contracts/fixtures/canonical/rfc8785-golden.json', import.meta.url), 'utf8')), 'd40f1ed836d9b286ee03b94c56fe410922fa92019aeaf018357f0d362337cb3a');
});

it('(f) contracts import only their own modules and Node built-ins', () => {
  for (const name of readdirSync(new URL('../contracts/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(`../contracts/${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('node:') || /^\.\/[^/]+$/.test(match[1]), `${name}: ${match[1]}`);
    }
  }
});

it('(e) descriptor string and array limits pass exactly at their bounds and fail at +1', () => {
  const schema = object({ text: string(2), list: { type: 'array', maxItems: 2, items: { type: 'boolean' } } });
  const registry = createExtensionRegistry([descriptor(schema)]);
  assert.doesNotThrow(() => assertItemExtensions(map({ text: '😀😀', list: [true, false] }), registry));
  assert.throws(() => assertItemExtensions(map({ text: '😀😀a', list: [true, false] }), registry), code('extension_limit'));
  assert.throws(() => assertItemExtensions(map({ text: '😀😀', list: [true, false, true] }), registry), code('extension_limit'));
});

it('(a) registration and instance checks perform no lazy file I/O', () => {
  const moduleUrl = new URL('../lib/extensions.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createExtensionRegistry, assertItemExtensions } from '${moduleUrl}';
    const original = fs.readFileSync;
    fs.readFileSync = () => { throw new Error('registration performed file I/O'); };
    syncBuiltinESMExports();
    try {
      const registry = createExtensionRegistry([{namespace:'x-demo.readiness',version:'1.0',title:'Synthetic',schema:{type:'boolean'}}]);
      assertItemExtensions({'x-demo.readiness@1':{version:'1.0',data:true}},registry);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }), '');
});

it('(e) classifies extension_limit only from maxLength and maxItems, not from error text', () => {
  const schema = object({
    note: { type: 'string', maxLength: 100, enum: ['ok'] },
    list: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 100, enum: ['ok'] } },
    text: string(2),
  });
  const registry = createExtensionRegistry([descriptor(schema)]);
  assert.throws(() => assertItemExtensions(map({ note: 'longer than 5', list: ['ok'], text: 'ab' }), registry), code('extension_invalid'));
  assert.throws(() => assertItemExtensions(map({ note: 'ok', list: ['more than 2 items'], text: 'ab' }), registry), code('extension_invalid'));
  assert.throws(() => assertItemExtensions(map({ note: 'longer than 5', list: ['ok'], text: 'abcdef' }), registry), code('extension_limit'));
  assert.throws(() => assertItemExtensions(map({ note: 'ok', list: ['ok', 'ok', 'ok', 'ok', 'ok'], text: 'ab' }), registry), code('extension_limit'));
});

it('(a) a cyclic descriptor schema is extension_invalid', () => {
  const schema = object({ child: string(1) });
  schema.properties.child = schema;
  const described = descriptor(schema);
  const registered = validate('aithema.extension', described);
  assert.equal(registered.ok, false);
  assert.deepEqual(registered.schemaErrors, ['extension_invalid: cyclic schema']);
  assert.equal(validateExtensions(map({}), [described]).code, 'extension_invalid');
  const items = { type: 'array', maxItems: 1, items: string(1) };
  items.items = items;
  assert.equal(validate('aithema.extension', descriptor(items)).schemaErrors[0], 'extension_invalid: cyclic schema');
});

it('(b) an instance version above MAX_SAFE_INTEGER is extension_invalid', () => {
  const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
  const safe = String(Number.MAX_SAFE_INTEGER);
  for (const version of [`${unsafe}.0`, `1.${unsafe}`, '9007199254740993.0']) {
    const major = version.split('.')[0];
    const result = validateExtensions({ [`x-demo.readiness@${major}`]: { version, data: true } });
    assert.equal(result.ok, false, version);
    assert.equal(result.code, 'extension_invalid', version);
  }
  assert.equal(validateExtensions({ [`x-demo.readiness@${safe}`]: { version: `${safe}.0`, data: true } }).ok, true);
});

it('(c) a snapshot carrying item extensions requires minor >= 1 and the working-spec shell stamps it', () => {
  const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/extension-snapshot.json', import.meta.url), 'utf8'));
  const stale = structuredClone(fixture.doc);
  stale.minor = 0;
  const rejected = validate('aithema.spec.snapshot', stale);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.invariants.includes('snapshot.extensions_require_minor'));
  assert.equal(validate('aithema.spec.snapshot', fixture.doc).ok, true);
  const newer = structuredClone(fixture.doc);
  newer.minor = 2;
  newer.min_reader = 0;
  assert.equal(validate('aithema.spec.snapshot', newer).ok, true);
  const cleared = structuredClone(fixture.doc);
  cleared.minor = 0;
  for (const item of cleared.spec.items) delete item.extensions;
  assert.equal(validate('aithema.spec.snapshot', cleared).ok, true);
  const empty = structuredClone(cleared);
  empty.spec.items[0].extensions = {};
  assert.ok(validate('aithema.spec.snapshot', empty).invariants.includes('snapshot.extensions_require_minor'));
  empty.minor = 1;
  empty.min_reader = 0;
  assert.equal(validate('aithema.spec.snapshot', empty).ok, true);

  const registry = createExtensionRegistry([descriptor({ type: 'boolean' })]);
  const item = {
    item_ref: 'REQ-1', kind: 'requirement',
    content: { statement: 'Expose a synthetic status endpoint.', acceptance_criteria: [], constraint_refs: [] },
    citations: [], provenance: { intent: 'inferred', derived_from: [] },
    extensions: { 'x-demo.readiness@1': { version: '1.0', data: true } },
  };
  assert.equal(addWorkingItem(createWorkingSpec('review'), item, registry).items[0].extensions['x-demo.readiness@1'].data, true);
  const plain = { ...item };
  delete plain.extensions;
  assert.equal(Object.hasOwn(addWorkingItem(createWorkingSpec('review'), plain).items[0], 'extensions'), false);
});

it('(a,b) the contracts authority refuses unvalidated descriptor schemas supplied directly', () => {
  const result = validateExtensions(map({ arbitrary: true }), [{ ...descriptor(), schema: {} }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_invalid');
});
