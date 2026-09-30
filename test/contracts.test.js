import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canExecute,
  canonicalJson,
  sha256Hex,
  checkInvariants,
  index,
  loadContractFile,
  readerSupport,
  validate,
  validateSchema,
} from '../contracts/validate.js';

const fixtures = fileURLToPath(new URL('../contracts/fixtures/', import.meta.url));

/** @param {string} dir */
function load(dir) {
  return readdirSync(join(fixtures, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, ...JSON.parse(readFileSync(join(fixtures, dir, f), 'utf8')) }));
}

describe('AIT-35 foundation contracts: fixtures', () => {
  const valid = load('valid');
  const invalid = load('invalid');

  it('covers every contract with at least one valid fixture', () => {
    const covered = new Set(valid.map((f) => f.contract));
    for (const c of index.contracts) assert.ok(covered.has(c.contract), `no valid fixture for ${c.contract}`);
  });

  for (const f of valid) {
    it(`accepts ${f.name}`, () => {
      const result = validate(f.contract, f.doc);
      assert.deepEqual(result.schemaErrors, [], `schema: ${result.schemaErrors.join('; ')}`);
      assert.deepEqual(result.invariants, []);
      assert.deepEqual(canExecute(f.doc), { ok: true });
    });
  }

  for (const f of invalid) {
    it(`refuses ${f.name}`, () => {
      if (f.expect.schema) {
        const errors = validateSchema(f.contract, f.doc);
        assert.ok(errors.some((e) => e.includes(f.expect.schema)), `expected "${f.expect.schema}" in: ${errors.join('; ')}`);
      } else if (f.expect.invariant) {
        assert.deepEqual(validateSchema(f.contract, f.doc), [], 'fixture must be structurally valid');
        assert.ok(checkInvariants(f.contract, f.doc).includes(f.expect.invariant), `expected invariant ${f.expect.invariant}`);
      } else if (f.expect.execute) {
        assert.deepEqual(validate(f.contract, f.doc).ok, true, 'fixture must be valid');
        assert.deepEqual(canExecute(f.doc), { ok: false, code: f.expect.execute });
      } else {
        assert.fail(`fixture ${f.name} has no expectation`);
      }
    });
  }
});

describe('AIT-35 foundation contracts: canonical digests', () => {
  it('refuses lone UTF-16 surrogates in values and keys at every depth', () => {
    for (const text of ['\ud800', '\udfff', 'x\ud800y', '\udc00\ud800']) {
      for (const value of [text, { value: [text] }, { [text]: 1 }]) {
        assert.throws(() => canonicalJson(value), /lone UTF-16 surrogates/);
      }
    }
    assert.equal(canonicalJson({ '\ud83d\ude00': '\ud83d\ude00' }), '{"😀":"😀"}');
  });

  it('refuses non-finite numbers instead of hashing null', () => {
    for (const number of [NaN, Infinity, -Infinity]) {
      for (const value of [number, [number], { nested: { number } }]) {
        assert.throws(() => canonicalJson(value), /finite numbers/);
      }
    }
  });

  it('refuses non-JSON values and cycles without rejecting shared children', () => {
    for (const value of [undefined, [undefined], Array(1), { x: undefined }, 1n, () => {}, Symbol(), new Date()]) {
      assert.throws(() => canonicalJson(value), /JSON values|plain objects/);
    }
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJson(cyclic), /cycles/);
    const child = { a: 1 };
    assert.equal(canonicalJson([child, child]), '[{"a":1},{"a":1}]');
  });

  it('encodes objects with sorted keys and no whitespace', () => {
    assert.equal(canonicalJson({ b: [2, { d: 1, c: 'x' }], a: null }), '{"a":null,"b":[2,{"c":"x","d":1}]}');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('reproduces the RFC 8785 golden vector byte for byte', () => {
    const golden = JSON.parse(readFileSync(join(fixtures, 'canonical/rfc8785-golden.json'), 'utf8'));
    const canonical = canonicalJson(JSON.parse(golden.input_json));
    assert.equal(canonical, golden.canonical);
    assert.equal(Buffer.from(canonical, 'utf8').toString('hex'), golden.canonical_utf8_hex);
    assert.equal(sha256Hex(canonical), golden.sha256);
    assert.ok(canonical.includes('<>&') && canonical.includes('\u2028'), 'no HTML escaping, U+2028 literal');
    assert.ok(canonical.indexOf('\u{1F600}') < canonical.indexOf('\uE000'), 'UTF-16 key order');
    assert.ok(canonical.includes('[1e+21,1e-7,0.1,0]'), 'ECMAScript numbers, -0 → 0');
  });
});

it('repairing only the denied budget reason makes the authority-reason fixture valid', () => {
  const fixture = JSON.parse(readFileSync(join(fixtures, 'invalid/budget.denied-with-authority-reason.json'), 'utf8'));
  assert.equal(validate(fixture.contract, fixture.doc).ok, false);
  const repaired = structuredClone(fixture.doc);
  repaired.body.denied = 'session_cap';
  assert.equal(validate(fixture.contract, repaired).ok, true);
});

describe('AIT-35 foundation contracts: compatibility (§9.7)', () => {
  it('refuses an unsupported major and a min_reader above the reader minor', () => {
    const doc = { contract: 'aithema.spec.snapshot', major: 1, min_reader: 1 };
    assert.deepEqual(canExecute(doc, { 'aithema.spec.snapshot': { major: 1, minor: 0 } }), { ok: false, code: 'contract_too_new' });
    assert.deepEqual(canExecute({ ...doc, major: 2, min_reader: 0 }, readerSupport()), { ok: false, code: 'contract_too_new' });
    assert.deepEqual(canExecute({ ...doc, min_reader: 0 }, readerSupport()), { ok: true });
  });

  it('accepts early-year dates and refuses leap seconds per the stated profile', () => {
    const f = load('valid').find((x) => x.name === 'record.turn.json');
    assert.ok(f);
    assert.deepEqual(validateSchema(f.contract, { ...f.doc, recorded_at: '0099-01-01T00:00:00Z' }), []);
    assert.notDeepEqual(validateSchema(f.contract, { ...f.doc, recorded_at: '2016-12-31T23:59:60Z' }), []);
  });

  it('rejects any unknown key, policy-relevant or cosmetic', () => {
    const f = load('valid').find((x) => x.name === 'session.create-working-spec-only.json');
    assert.ok(f);
    assert.notDeepEqual(validateSchema(f.contract, { ...f.doc, color: 'blue' }), []);
  });
});

describe('AIT-35 foundation contracts: tables stay consistent', () => {
  const errorCodes = loadContractFile('error-codes.json').codes.map((/** @type {any} */ c) => c.code);
  const common = loadContractFile('common.schema.json');
  const transitions = loadContractFile('transitions.json');
  const capabilities = loadContractFile('capabilities.json');
  const item = loadContractFile('working-item.schema.json');

  it('error-code enum and catalog agree', () => {
    assert.deepEqual([...common.$defs.error_code.enum].sort(), [...errorCodes].sort());
  });

  it('every mode state is an item state; working-spec-only never proposes', () => {
    const states = item.$defs.item.properties.state.enum;
    for (const [name, mode] of Object.entries(transitions.modes)) {
      for (const s of /** @type {any} */ (mode).states) assert.ok(states.includes(s), `${name}: ${s}`);
      for (const t of /** @type {any} */ (mode).transitions) {
        assert.ok(/** @type {any} */ (mode).states.includes(t.from) && /** @type {any} */ (mode).states.includes(t.to), `${name}: ${t.from}→${t.to}`);
      }
    }
    const wso = transitions.modes.working_spec_only;
    assert.equal(wso.submits, false);
    for (const s of ['proposed', 'accepted', 'rejected', 'invalidated']) assert.ok(!wso.states.includes(s));
  });

  it('accepted, superseded, rejected and invalidated have no outgoing transition', () => {
    for (const mode of Object.values(transitions.modes)) {
      for (const t of /** @type {any} */ (mode).transitions) assert.ok(!transitions.closed_states.includes(t.from), `${t.from} is closed`);
    }
  });

  it('port results map to catalogued codes with matching HTTP status', () => {
    const catalog = new Map(loadContractFile('error-codes.json').codes.map((/** @type {any} */ c) => [c.code, c.http]));
    for (const r of loadContractFile('error-codes.json').port_results) {
      if (r.code === null) assert.equal(r.http, 200);
      else assert.equal(catalog.get(r.code), r.http, r.code);
    }
  });

  it('arbitration results are ok, the original result, or a catalogued code', () => {
    for (const row of transitions.arbitration) {
      assert.ok(['ok', 'original result'].includes(row.result) || errorCodes.includes(row.result), row.result);
    }
  });

  it('acceptance is never a delegated capability and the route matrix uses only allowed capabilities', () => {
    for (const cap of capabilities.never_in_token) assert.ok(!capabilities.delegated_allowed.includes(cap));
    for (const route of capabilities.routes) {
      if (route.class === 'person-only') assert.ok(capabilities.never_in_token.includes(route.capability), route.route);
      else if (route.class !== 'host-to-service') assert.ok(capabilities.delegated_allowed.includes(route.capability), route.route);
    }
  });

  it('every delegated route checks expiry; writes and controls are fenced; intake writes need the LiveGrant', () => {
    for (const route of capabilities.routes) {
      if (!['read', 'write', 'control'].includes(route.class)) continue;
      assert.ok(route.checks.includes('exp'), `${route.route}: exp`);
      assert.ok(route.checks.includes('epoch') || route.capability === 'aithema.authority.read', `${route.route}: epoch`);
      if (route.class !== 'read') assert.ok(route.checks.some((/** @type {string} */ c) => c.startsWith('gen')), `${route.route}: gen`);
      if (route.capability === 'intake.write') assert.ok(route.checks.includes('ephemeral LiveGrant'), route.route);
    }
  });

  it('the stated revocation bounds follow from the authority timings', () => {
    const a = capabilities.authority;
    assert.ok(a.poll_interval_seconds + a.request_deadline_seconds + a.stop_allowance_seconds <= a.revocation_healthy_max_seconds);
    assert.ok(2 * a.poll_interval_seconds + a.request_deadline_seconds + a.stop_allowance_seconds <= a.revocation_outage_max_seconds);
  });

  it('every contract in the index resolves to a root schema', () => {
    for (const c of index.contracts) {
      const schema = loadContractFile(c.file);
      const root = c.root.split('/').filter(Boolean).reduce((/** @type {any} */ n, /** @type {string} */ k) => n?.[k], schema);
      assert.ok(root, `${c.contract} root ${c.root}`);
      assert.equal(root.properties.contract.const, c.contract);
      assert.equal(root.properties.major.const, c.major);
    }
  });
});
