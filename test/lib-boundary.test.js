import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { boundary, BOUNDARY_WRAPPED, inputWasFrozen, plainDataSnapshot } from '../lib/boundary.js';
import * as streamApi from '../lib/stream.js';
import * as exportApi from '../lib/export.js';
import * as reviewApi from '../lib/revision-review.js';
import * as portableApi from '../lib/portable.js';
import { importHandoverProposal } from '../lib/import.js';
import { importReviewedOwnFormat } from '../lib/intake.js';
import { contentDigest } from '../lib/digest.js';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';

const normalization = /plain-data snapshot:/;
const envelopeRequired = /working-spec projection requires content, content_sha256, citations and provenance/;
const contributor = { party_ref: 'party:synthetic-builder', roles: ['delivery_party'] };
const approver = { party_ref: 'party:synthetic-reviewer', roles: ['requirements_approver'] };
const at = '2026-09-30T00:00:00Z';
const sid = '00000000-0000-4000-8000-000000000000';

// Import every module, including the barrel and boundary itself. No manually
// maintained export list: a new unwrapped public API must fail this guard.
const libraryModules = await Promise.all(
  readdirSync(new URL('../lib/', import.meta.url)).filter((name) => name.endsWith('.js')).sort()
    .map(async (name) => [name, await import(new URL(`../lib/${name}`, import.meta.url))]),
);

describe('every public library function has the shared boundary', () => {
  for (const [moduleName, exports] of libraryModules) {
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn !== 'function') continue;
      it(`${moduleName}:${name} is marked and rejects caller accessors before implementation`, () => {
        const marker = Object.getOwnPropertyDescriptor(fn, BOUNDARY_WRAPPED);
        assert.deepEqual(marker, { value: true, enumerable: false, writable: false, configurable: false },
          `${moduleName}:${name} must be exported through boundary()`);
        for (const position of [0, 1, 2, 3, 4, 5]) {
          let reads = 0;
          const hostile = { get hidden() { reads++; throw new Error('caller accessor ran'); } };
          const args = Array(6).fill(undefined);
          args[position] = hostile;
          assert.throws(() => fn(...args), normalization, `argument ${position}`);
          assert.equal(reads, 0, `argument ${position}`);
        }
      });
    }
  }
});

describe('shared library boundary argument rules', () => {
  it('normalizes every object argument, including unused arguments, before entering the implementation', () => {
    let calls = 0;
    let reads = 0;
    const fn = boundary((...args) => { calls++; return args; });
    for (const position of [0, 1, 2, 5]) {
      const args = Array.from({ length: 6 }, () => ({ nested: ['synthetic'] }));
      Object.defineProperty(args[position].nested, '0', { get() { reads++; return 'synthetic'; } });
      assert.throws(() => fn(...args), normalization);
    }
    assert.equal(calls, 0);
    assert.equal(reads, 0);
  });

  it('passes primitives through unchanged and preserves default and async implementations', async () => {
    const values = [undefined, null, false, true, '', 'synthetic', 0, -0, NaN, Infinity, 1n, Symbol('synthetic')];
    const fn = boundary((...args) => args);
    const result = fn(...values);
    values.forEach((value, index) => assert.ok(Object.is(result[index], value)));
    assert.equal(boundary((value = 'default') => value)(), 'default');
    assert.equal(await boundary(async (value) => value)('synthetic'), 'synthetic');
  });

  it('only explicitly listed function arguments pass and nested functions remain forbidden', () => {
    let calls = 0;
    const callback = () => { calls++; return 'synthetic'; };
    assert.throws(() => boundary((value) => value)(callback), normalization);
    const fn = boundary((data, cb) => [data, cb()], { functionArgs: [1] });
    assert.deepEqual(fn({ nested: [1] }, callback), [{ nested: [1] }, 'synthetic']);
    assert.equal(calls, 1);
    assert.throws(() => fn(callback, callback), normalization);
    assert.throws(() => fn({ nested: callback }, callback), normalization);
    assert.throws(() => fn({}, callback, callback), normalization);
    assert.equal(calls, 1);
    assert.throws(() => boundary(callback, { functionArgs: [-1] }), /non-negative argument indices/);
  });

  it('refuses exotic, boxed, sparse and non-JSON nested data without invoking caller behavior', () => {
    const fn = boundary((value) => value);
    class Instance { constructor() { this.value = 1; } }
    for (const value of [
      new String('synthetic'), new Number(1), new Boolean(false), new Date(0),
      new Map(), new Set(), new Instance(), Array(1), [undefined], [NaN], [Infinity], [1n],
      [Symbol('synthetic')], { [Symbol('synthetic')]: 1 },
      new Proxy({}, { ownKeys() { assert.fail('proxy trap ran'); } }),
    ]) assert.throws(() => fn(value), normalization);
    let iterations = 0;
    const array = ['synthetic'];
    array[Symbol.iterator] = function* () { iterations++; yield 'changed'; };
    assert.throws(() => fn(array), normalization);
    assert.equal(iterations, 0);
    const hidden = {};
    Object.defineProperty(hidden, 'hidden', { get() { assert.fail('hidden getter ran'); } });
    assert.throws(() => fn(hidden), normalization);
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => fn(cycle), normalization);
    const decorated = [1];
    decorated.extra = 2;
    assert.throws(() => fn(decorated), normalization);
  });

  it('detaches and freezes normal JSON, preserves own __proto__ data, and never freezes callers', () => {
    const input = JSON.parse('{"a":{"value":[1]},"__proto__":{"synthetic":true}}');
    const result = boundary((value) => value)(input);
    assert.deepEqual(result, input);
    assert.notStrictEqual(result, input);
    assert.notStrictEqual(result.a.value, input.a.value);
    assert.ok(Object.isFrozen(result.a.value));
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    input.a.value.push(2);
    assert.deepEqual(result.a.value, [1]);
    assert.equal(Object.isFrozen(input), false);
  });

  it('retains input freeze state during assertions and recognizes returned immutable copies', () => {
    const input = { mutable: [], frozen: Object.freeze([]) };
    const inspect = boundary((value) => [inputWasFrozen(value), inputWasFrozen(value.mutable), inputWasFrozen(value.frozen)]);
    assert.deepEqual(inspect(input), [false, false, true]);
    const snapshot = plainDataSnapshot(input);
    assert.ok(Object.isFrozen(snapshot.mutable));
    assert.deepEqual(inspect(snapshot), [true, true, true]);
    assert.equal(Object.isFrozen(input.mutable), false);
  });
});

function requirement(ref = 'REQ-new') {
  return { requirement_ref: ref, statement: 'Expose a synthetic status endpoint.', acceptance_criteria: [], constraint_refs: [] };
}

function constraint(ref = 'CON-new') {
  return { constraint_ref: ref, kind: 'technical', statement: 'Use a synthetic fixture.' };
}

function approvedStream() {
  let stream = streamApi.createStream('stream:synthetic', ['new_product']);
  stream = streamApi.proposeRequirement(stream, contributor, requirement('REQ-kept'), at);
  stream = streamApi.proposeConstraint(stream, contributor, constraint('CON-kept'), at);
  return streamApi.approveBaselineFromProposals(stream, approver, stream.proposals.map((p) => p.proposal_ref), 'baseline:kept', at);
}

function linkedStream() {
  const stream = structuredClone(approvedStream());
  const content = { statement: 'A confirmed synthetic requirement.', acceptance_criteria: [], constraint_refs: [] };
  const original = {
    proposal_ref: 'proposal:original', kind: 'add_requirement', op_key: `${sid}:submit:1`,
    contributed_by: contributor.party_ref, contributed_at: at, summary: 'Synthetic confirmed item',
    requirement: { requirement_ref: 'REQ-linked', ...structuredClone(content) },
    content, content_sha256: sha256Hex(canonicalJson(content)),
    citations: [{ record_seq: 1, locator: 'turn:0' }], provenance: { intent: 'requested', derived_from: [1] },
  };
  const stripped = (ref, previous, ordinal) => ({
    proposal_ref: ref, kind: 'add_requirement', op_key: `${sid}:turn:${ordinal}`,
    contributed_by: contributor.party_ref, contributed_at: at, summary: 'Synthetic stripped successor',
    requirement: { ...requirement('REQ-linked'), statement: 'Approved without confirmation.' },
    supersedes_proposal_ref: previous,
  });
  stream.proposals.push(original, stripped('proposal:mid', original.proposal_ref, 2), stripped('proposal:far', 'proposal:mid', 3));
  return stream;
}

function approveFar(stream) {
  return streamApi.approveBaselineFromProposals(stream, approver, ['proposal:far'], 'baseline:laundered', at);
}

// The gate's laundering attack deletes its own accessor, installs a marker-free
// successor and returns ordinary data. A snapshot taken after any walk is late.
function selfErasingAccessor(stream, target, field) {
  const original = target[field];
  const far = structuredClone(stream.proposals.at(-1));
  delete far.supersedes_proposal_ref;
  let reads = 0;
  Object.defineProperty(target, field, {
    configurable: true, enumerable: true,
    get() {
      reads++;
      Object.defineProperty(target, field, { value: original, enumerable: true, writable: true, configurable: true });
      stream.proposals = [far];
      return target[field];
    },
  });
  return () => reads;
}

const writers = {
  proposeRequirement: (s, authority, payload = requirement()) => streamApi.proposeRequirement(s, authority, payload, at),
  proposeRequirementUpdate: (s, authority, payload = requirement('REQ-kept')) => streamApi.proposeRequirementUpdate(s, authority, payload, at),
  proposeConstraint: (s, authority, payload = constraint()) => streamApi.proposeConstraint(s, authority, payload, at),
  proposeConstraintUpdate: (s, authority, payload = constraint('CON-kept')) => streamApi.proposeConstraintUpdate(s, authority, payload, at),
  proposeImport: (s, authority, payload = requirement()) => streamApi.proposeImport(s, authority, [payload], [], at),
};

function assertNotWalked(stream, reads, before, invoke) {
  assert.throws(invoke, normalization);
  assert.equal(reads(), 0, 'caller accessor must not execute, even once');
  assert.equal(Object.getOwnPropertyDescriptor(before.target, before.field).get, before.getter);
  assert.equal(stream.proposals.at(-1).supersedes_proposal_ref, 'proposal:mid');
  assert.deepEqual(stream.decisions, before.decisions);
}

describe('round-6 stream writers and currentBaseline normalize before any walk', () => {
  for (const [name, invoke] of Object.entries({ ...writers, currentBaseline: streamApi.currentBaseline })) {
    for (const field of ['proposals', 'baselines']) {
      it(`${name} refuses self-erasing ${field} before it can remove confirmation ancestry`, () => {
        const stream = linkedStream();
        assert.throws(() => approveFar(JSON.parse(JSON.stringify(stream))), envelopeRequired);
        const decisions = structuredClone(stream.decisions);
        const reads = selfErasingAccessor(stream, stream, field);
        const getter = Object.getOwnPropertyDescriptor(stream, field).get;
        assert.throws(() => invoke(stream, contributor), normalization);
        assert.equal(reads(), 0);
        assert.equal(Object.getOwnPropertyDescriptor(stream, field).get, getter);
        assert.deepEqual(stream.decisions, decisions);
        if (field !== 'proposals') assert.equal(stream.proposals.at(-1).supersedes_proposal_ref, 'proposal:mid');
      });
    }
  }

  for (const [name, invoke] of Object.entries(writers)) {
    it(`${name} refuses self-erasing authority party_ref and payload statement accessors`, () => {
      for (const variant of ['authority', 'payload']) {
        const stream = linkedStream();
        const authority = structuredClone(contributor);
        const payload = name.includes('Constraint') ? constraint(name.endsWith('Update') ? 'CON-kept' : 'CON-new')
          : requirement(name.endsWith('Update') ? 'REQ-kept' : 'REQ-new');
        const target = variant === 'authority' ? authority : payload;
        const field = variant === 'authority' ? 'party_ref' : 'statement';
        const reads = selfErasingAccessor(stream, target, field);
        assertNotWalked(stream, reads, {
          target, field, getter: Object.getOwnPropertyDescriptor(target, field).get,
          decisions: structuredClone(stream.decisions),
        }, () => invoke(stream, authority, payload));
      }
    });
  }
});

const readerCases = [
  ['exportHandoverJson', 'decisions', (s) => exportApi.exportHandoverJson(s, at)],
  ['exportHandoverCsv', 'decisions', (s) => exportApi.exportHandoverCsv(s, undefined, at)],
  ['buildRevisionReview', 'proposals', (s) => reviewApi.buildRevisionReview(s)],
  ['acceptRevisionReview', 'proposals', (s) => reviewApi.acceptRevisionReview(s, ['proposal:far'], `sha256:${'0'.repeat(64)}`)],
  ['findApprovedBaseline', 'baselines', (s) => portableApi.findApprovedBaseline(s, { baseline_ref: 'baseline:kept', revision: 1 })],
  ['exportReviewedHandover', 'baselines', (s) => portableApi.exportReviewedHandover(s, { baseline_ref: 'baseline:kept', revision: 1 }, at)],
  ['exportReviewedCsv', 'baselines', (s) => portableApi.exportReviewedCsv(s, { baseline_ref: 'baseline:kept', revision: 1 }, undefined, at)],
  ['importHandoverProposal', 'stream_ref', (s) => importHandoverProposal(s, contributor, {
    handover_version: 'aithema.handover/0.1', stream_ref: 'stream:synthetic', exported_at: at,
    baseline: null, pending_proposals: [], decisions: [],
  })],
  ['importReviewedOwnFormat', 'baselines', (s) => {
    const handover = portableApi.exportReviewedHandover(approvedStream(), { baseline_ref: 'baseline:kept', revision: 1 }, at);
    const baseline = structuredClone(handover.baseline);
    // Matching digest and different ids: the honest import would successfully
    // propose content, which previously laundered the stream through intake.
    baseline.requirements[0].requirement_ref = 'REQ-imported';
    return importReviewedOwnFormat(s, contributor, { ...handover, baseline: {
      ...baseline, content_digest: contentDigest(baseline.requirements, baseline.constraints),
    } }, at);
  }],
];

describe('round-6 export, review, portable, import and intake normalize before any walk', () => {
  for (const [name, field, invoke] of readerCases) {
    it(`${name} refuses the self-erasing ${field} laundering path`, () => {
      const stream = linkedStream();
      assert.throws(() => approveFar(JSON.parse(JSON.stringify(stream))), envelopeRequired);
      const reads = selfErasingAccessor(stream, stream, field);
      const getter = Object.getOwnPropertyDescriptor(stream, field).get;
      const decisions = field === 'decisions' ? null : structuredClone(stream.decisions);
      assert.throws(() => invoke(stream), normalization);
      assert.equal(reads(), 0);
      assert.equal(Object.getOwnPropertyDescriptor(stream, field).get, getter);
      if (field !== 'proposals') assert.equal(stream.proposals.at(-1).supersedes_proposal_ref, 'proposal:mid');
      if (decisions) assert.deepEqual(stream.decisions, decisions);
    });
  }
});

describe('createStream projectKinds and immutable-baseline semantics', () => {
  it('refuses a divergent own projectKinds iterator without running either pass', () => {
    const kinds = ['new_product'];
    let iterations = 0;
    kinds[Symbol.iterator] = function* () {
      yield 'new_product';
      if (++iterations > 1) yield 'smuggled';
    };
    assert.throws(() => streamApi.createStream('stream:synthetic', kinds), normalization);
    assert.equal(iterations, 0);
  });

  it('iterates projectKinds exactly once on the snapshot and keeps a detached frozen copy', () => {
    const input = ['new_product', 'iteration'];
    const original = Array.prototype[Symbol.iterator];
    let iterations = 0;
    // Observe the normal built-in iteration of the detached array, then restore
    // immediately. The callback does not alter data or iteration behavior.
    Array.prototype[Symbol.iterator] = function () {
      if (this.length === 2 && this[0] === 'new_product' && this[1] === 'iteration') {
        iterations++;
        assert.notStrictEqual(this, input);
      }
      return original.call(this);
    };
    let stream;
    try { stream = streamApi.createStream('stream:synthetic', input); }
    finally { Array.prototype[Symbol.iterator] = original; }
    assert.equal(iterations, 1);
    assert.deepEqual(stream.project_kinds, input);
    assert.ok(Object.isFrozen(stream.project_kinds));
    input.push('integration');
    assert.deepEqual(stream.project_kinds, ['new_product', 'iteration']);
  });

  it('does not launder mutable baselines or children into an immutable-baseline assertion', () => {
    const baseline = streamApi.currentBaseline(approvedStream());
    assert.doesNotThrow(() => streamApi.assertApprovedBaselineImmutable(baseline));
    assert.throws(() => streamApi.assertApprovedBaselineImmutable(structuredClone(baseline)), /approved baseline must be frozen/);
    assert.throws(() => streamApi.assertApprovedBaselineImmutable(Object.freeze({ ...baseline, requirements: [...baseline.requirements] })),
      /approved baseline collections must be frozen/);
    const keptRequirement = baseline.requirements[0];
    for (const key of ['acceptance_criteria', 'constraint_refs']) {
      const thawed = Object.freeze({ ...keptRequirement, [key]: [...keptRequirement[key]] });
      assert.throws(() => streamApi.assertApprovedBaselineImmutable(Object.freeze({
        ...baseline, requirements: Object.freeze([thawed]),
      })), /approved requirement must be frozen/);
    }
    assert.throws(() => streamApi.assertApprovedBaselineImmutable(Object.freeze({
      ...baseline, constraints: Object.freeze([{ ...baseline.constraints[0] }]),
    })), /approved constraint must be frozen/);
    const rehydrated = structuredClone(approvedStream());
    const appended = streamApi.proposeRequirement(rehydrated, contributor, requirement(), at);
    assert.doesNotThrow(() => streamApi.assertApprovedBaselineImmutable(streamApi.currentBaseline(appended)));
  });
});
