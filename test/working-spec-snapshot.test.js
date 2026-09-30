import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import {
  appendProposal, approveBaselineFromProposals, createStream, currentBaseline, replaceProposal,
} from '../lib/stream.js';

// Exercise the private authority itself, so removing its snapshot cannot hide
// behind the public entry points' snapshots. Only its export visibility changes;
// all imports still resolve to the repository's real modules, without I/O to a
// provider or host and without adding a production API for this test.
const streamUrl = new URL('../lib/stream.js', import.meta.url);
const authoritySource = readFileSync(streamUrl, 'utf8')
  .replace('function assertProjectedEnvelope(', 'export function assertProjectedEnvelope(')
  .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g,
    (_match, _quote, path) => `from ${JSON.stringify(new URL(path, streamUrl).href)}`);
const { assertProjectedEnvelope } = await import(`data:text/javascript;base64,${Buffer.from(authoritySource).toString('base64')}`);

const sid = '00000000-0000-4000-8000-000000000000';
const at = '2026-09-30T00:00:00Z';
const contributor = { party_ref: 'party:synthetic-builder', roles: ['delivery_party'] };
const approver = { party_ref: 'party:synthetic-reviewer', roles: ['requirements_approver'] };
const normalization = /plain-data snapshot:/;
const envelopeRequired = /working-spec projection requires content, content_sha256, citations and provenance/;

function proposal(ref, op, itemRef = 'REQ-1', projected = true) {
  const content = { statement: 'Expose a synthetic status endpoint.', acceptance_criteria: [], constraint_refs: [] };
  return {
    proposal_ref: ref, op_key: `${sid}:${op}`, kind: 'add_requirement',
    contributed_by: contributor.party_ref, contributed_at: at, summary: 'Synthetic requirement',
    requirement: { requirement_ref: itemRef, ...structuredClone(content) },
    ...(projected ? {
      content, content_sha256: sha256Hex(canonicalJson(content)),
      citations: [{ record_seq: 1, locator: 'turn:0' }],
      provenance: { intent: 'requested', derived_from: [1] },
    } : {}),
  };
}

function fixture() {
  return {
    ...createStream('stream:synthetic', ['new_product']),
    project_kinds: ['new_product'], baselines: [], decisions: [],
    proposals: [proposal('proposal:original', 'submit:1')],
  };
}

function ancestry() {
  const stream = fixture();
  const mid = { ...proposal('proposal:mid', 'source:2', 'REQ-1', false), supersedes_proposal_ref: 'proposal:original' };
  const far = { ...proposal('proposal:far', 'turn:3', 'REQ-1', false), supersedes_proposal_ref: mid.proposal_ref };
  mid.requirement.statement = far.requirement.statement = 'Approved without confirmation.';
  const twin = { ...structuredClone(mid), op_key: `${sid}:turn:4` };
  delete twin.supersedes_proposal_ref;
  stream.proposals.push(mid, far);
  return { stream, mid, far, twin };
}

const boundaries = {
  append: (stream) => appendProposal(stream, contributor, proposal('proposal:append', 'source:9', 'REQ-2', false)),
  replace: (stream) => replaceProposal(stream, contributor, 'proposal:original', proposal('proposal:replacement', 'replace:9')),
  approve: (stream) => approveBaselineFromProposals(stream, approver, ['proposal:original'], 'baseline:synthetic', at),
  authority: (stream) => assertProjectedEnvelope(stream, stream.proposals.at(-1)),
};

describe('AIT-36 round 4: plain-data snapshot at every stream boundary', () => {
  for (const [boundary, invoke] of Object.entries(boundaries)) {
    it(`${boundary} rejects an ancestry getter before it can splice a marker-free twin`, () => {
      const { stream, mid, far, twin } = ancestry();
      let reads = 0;
      Object.defineProperty(mid, 'supersedes_proposal_ref', {
        enumerable: true, get() {
          reads++;
          stream.proposals.splice(1, 0, twin);
          return 'proposal:original';
        },
      });
      assert.throws(() => invoke(stream), normalization);
      assert.equal(reads, 0, 'normalization must inspect descriptors without reading getters');
      assert.equal(stream.proposals.length, 3);
      assert.equal(far.supersedes_proposal_ref, 'proposal:mid');
      assert.deepEqual(stream.decisions, []);
      assert.deepEqual(stream.baselines, []);
    });

    it(`${boundary} rejects divergent proposals getters and iterators without invoking either`, () => {
      for (const variant of ['getter', 'iterator']) {
        const { stream, mid, far, twin } = ancestry();
        const unique = stream.proposals;
        let reads = 0;
        if (variant === 'getter') {
          Object.defineProperty(stream, 'proposals', {
            enumerable: true, get() { return ++reads === 1 ? unique : [unique[0], twin, mid, far]; },
          });
        } else {
          unique.splice(1, 0, twin);
          Object.defineProperty(unique, Symbol.iterator, {
            value: function* () { reads++; yield unique[0]; yield mid; yield far; },
          });
        }
        // Supply the proposal directly; reading a hostile proposals getter in
        // the test must not precede the authority's own normalization.
        const call = boundary === 'authority' ? () => assertProjectedEnvelope(stream, far) : () => invoke(stream);
        assert.throws(call, normalization, variant);
        assert.equal(reads, 0, variant);
        assert.deepEqual(stream.baselines, []);
      }
    });

    it(`${boundary} rejects boxed proposal, decision, supersedes and operation-key references`, () => {
      for (const field of ['proposal_ref', 'supersedes_proposal_ref', 'decision.proposal_ref', 'op_key', 'decision.op_key']) {
        const { stream, mid, far, twin } = ancestry();
        if (field === 'proposal_ref') {
          mid.proposal_ref = new String(mid.proposal_ref);
          stream.proposals.splice(1, 0, twin);
        } else if (field === 'supersedes_proposal_ref') {
          far.supersedes_proposal_ref = new String(mid.proposal_ref);
        } else if (field.startsWith('decision.')) {
          delete far.supersedes_proposal_ref;
          stream.decisions.push({ proposal_ref: 'proposal:original', op_key: far.op_key, outcome: 'withdrawn' });
          const key = field.slice('decision.'.length);
          stream.decisions[0][key] = new String(stream.decisions[0][key]);
        } else {
          mid.op_key = new String(`${sid}:submit:2`);
        }
        assert.throws(() => invoke(stream), normalization, field);
        assert.deepEqual(stream.baselines, []);
      }
    });

    it(`${boundary} requires strings even for otherwise JSON-compatible reference values`, () => {
      for (const value of [null, false, 1, [], {}]) {
        for (const field of ['proposal_ref', 'supersedes_proposal_ref', 'op_key', 'decision.proposal_ref', 'decision.op_key']) {
          const { stream, far } = ancestry();
          if (field.startsWith('decision.')) {
            const key = field.slice('decision.'.length);
            stream.decisions.push({ proposal_ref: 'proposal:original', op_key: far.op_key, outcome: 'withdrawn', [key]: value });
          } else far[field] = value;
          assert.throws(() => invoke(stream), /plain-data snapshot: stream .* primitive string required/, `${field}: ${typeof value}`);
        }
      }
    });

    it(`${boundary} rejects sparse arrays at every nesting depth`, () => {
      for (const location of ['proposals', 'decisions', 'baselines', 'project_kinds', 'criteria', 'citations', 'trailing']) {
        const stream = fixture();
        if (location === 'criteria') stream.proposals[0].requirement.acceptance_criteria = Array(1);
        else if (location === 'citations') stream.proposals[0].citations = Array(1);
        else if (location === 'trailing') stream.proposals.length++;
        else stream[location] = Array(1);
        const call = boundary === 'authority' ? () => assertProjectedEnvelope(stream, proposal('proposal:original', 'submit:1')) : () => invoke(stream);
        assert.throws(call, /plain-data snapshot: sparse arrays/, location);
      }
    });

    it(`${boundary} rejects non-JSON values, non-plain prototypes, accessors and cycles`, () => {
      class Instance { constructor() { this.value = 1; } }
      for (const value of [
        undefined, () => 1, Symbol('synthetic'), 1n, NaN, Infinity, -Infinity,
        new String('synthetic'), new Number(1), new Boolean(false), new Map(), new Set(),
        new Date(0), new Instance(), new Proxy({}, {}),
      ]) {
        const stream = { ...fixture(), extra: { nested: value } };
        assert.throws(() => invoke(stream), normalization, typeof value);
        assert.equal(Object.isFrozen(stream.extra), false);
        const hidden = fixture();
        Object.defineProperty(hidden, 'extra', { value });
        assert.throws(() => invoke(hidden), normalization, 'non-enumerable invalid data');
      }
      for (const descriptor of [{ get() { assert.fail('getter was invoked'); } }, { set() { assert.fail('setter was invoked'); } }]) {
        const stream = fixture();
        Object.defineProperty(stream, 'hidden', descriptor);
        assert.throws(() => invoke(stream), /plain-data snapshot: accessors/);
      }
      const cyclic = fixture();
      cyclic.extra = cyclic;
      assert.throws(() => invoke(cyclic), /plain-data snapshot: cycles/);
      const symbolic = fixture();
      symbolic.extra = { [Symbol('synthetic')]: 'value' };
      assert.throws(() => invoke(symbolic), /plain-data snapshot: symbol properties/);
      const decorated = fixture();
      decorated.proposals.extra = 1;
      assert.throws(() => invoke(decorated), /plain-data snapshot: extra array properties/);
      const subclass = fixture();
      subclass.proposals = new (class extends Array {})(...subclass.proposals);
      assert.throws(() => invoke(subclass), /plain-data snapshot: plain objects and arrays/);
    });
  }

  for (const boundary of ['append', 'replace', 'approve']) {
    it(`${boundary} uses a detached snapshot before authorization and returns no caller-owned data`, () => {
      const stream = fixture();
      const original = JSON.parse(JSON.stringify(stream));
      let reads = 0;
      const trustedAuthority = {
        roles: boundary === 'approve' ? approver.roles : contributor.roles,
        get party_ref() {
          reads++;
          stream.proposals[0].requirement.statement = 'Caller mutation during authorization.';
          stream.proposals[0].content.statement = 'Caller mutation during authorization.';
          return boundary === 'approve' ? approver.party_ref : contributor.party_ref;
        },
      };
      let result;
      if (boundary === 'append') result = appendProposal(stream, trustedAuthority, proposal('proposal:append', 'source:9', 'REQ-2', false));
      else if (boundary === 'replace') result = replaceProposal(stream, trustedAuthority, 'proposal:original', proposal('proposal:replacement', 'replace:9'));
      else result = approveBaselineFromProposals(stream, trustedAuthority, ['proposal:original'], 'baseline:synthetic', at);
      assert.ok(reads > 0, 'the authorized adapter runs after the snapshot');
      assert.deepEqual(result.proposals[0], original.proposals[0]);
      assert.notStrictEqual(result.proposals[0], stream.proposals[0]);
      assert.ok(Object.isFrozen(result.proposals[0].content));
      assert.ok(Object.isFrozen(result.proposals[0].requirement.acceptance_criteria));
      assert.equal(Object.isFrozen(stream.proposals[0]), false);
      stream.proposals[0].requirement.acceptance_criteria.push('Later mutation.');
      assert.deepEqual(result.proposals[0].requirement.acceptance_criteria, []);
      if (boundary === 'approve') assert.equal(currentBaseline(result).requirements[0].statement, original.proposals[0].requirement.statement);
    });
  }

  it('the projection authority snapshots its proposal before reading an accessor', () => {
    const stream = fixture();
    const candidate = structuredClone(stream.proposals[0]);
    let reads = 0;
    Object.defineProperty(candidate, 'supersedes_proposal_ref', {
      enumerable: true, get() { reads++; stream.proposals.push(candidate); return 'proposal:original'; },
    });
    assert.throws(() => assertProjectedEnvelope(stream, candidate), normalization);
    assert.equal(reads, 0);
    assert.equal(stream.proposals.length, 1);
  });

  it('normalizes incoming append and replacement proposals before any request getter runs', () => {
    for (const boundary of ['append', 'replace']) {
      const stream = fixture();
      const candidate = proposal('proposal:new', boundary === 'append' ? 'submit:9' : 'replace:9');
      let reads = 0;
      Object.defineProperty(candidate, 'op_key', { enumerable: true, get() { reads++; return `${sid}:replace:9`; } });
      const call = boundary === 'append'
        ? () => appendProposal(stream, contributor, candidate)
        : () => replaceProposal(stream, contributor, 'proposal:original', candidate);
      assert.throws(call, normalization);
      assert.equal(reads, 0);
      assert.deepEqual(stream.decisions, []);
    }
  });

  it('normalizes first even when authorization is invalid, at all public boundaries', () => {
    for (const boundary of ['append', 'replace', 'approve']) {
      const stream = fixture();
      Object.defineProperty(stream, 'proposals', { enumerable: true, get() { assert.fail('stream getter was invoked'); } });
      const call = boundary === 'append' ? () => appendProposal(stream, null, null)
        : boundary === 'replace' ? () => replaceProposal(stream, null, 'proposal:original', null)
          : () => approveBaselineFromProposals(stream, null, [], 'baseline:synthetic', at);
      assert.throws(call, normalization);
    }
  });

  it('requires primitive references in operation arguments and on all stored records', () => {
    const stream = fixture();
    const request = proposal('proposal:replacement', 'replace:9');
    assert.throws(() => replaceProposal(stream, contributor, new String('proposal:original'), request), /primitive string/);
    for (const refs of [[new String('proposal:original')], [42], Array(1)]) {
      assert.throws(() => approveBaselineFromProposals(stream, approver, refs, 'baseline:synthetic', at), /plain-data snapshot|primitive strings/);
    }
    for (const location of ['proposal', 'decision']) {
      const corrupt = fixture();
      if (location === 'proposal') delete corrupt.proposals[0].proposal_ref;
      else corrupt.decisions.push({ outcome: 'withdrawn' });
      assert.throws(() => boundaries.append(corrupt), /stream proposal_ref is invalid/);
    }
  });

  it('accepts JSON-rehydrated and frozen normal streams through append, replace, approval and the authority', () => {
    const source = JSON.parse(JSON.stringify(fixture()));
    const frozen = appendProposal(source, contributor, proposal('proposal:append', 'source:9', 'REQ-2', false));
    for (const stream of [source, frozen, JSON.parse(JSON.stringify(frozen))]) {
      assert.equal(assertProjectedEnvelope(stream, stream.proposals[0]), undefined);
      const next = replaceProposal(stream, contributor, 'proposal:original', proposal('proposal:replacement', 'replace:9'));
      assert.equal(next.decisions[0].outcome, 'withdrawn');
      const accepted = approveBaselineFromProposals(next, approver, ['proposal:replacement'], 'baseline:synthetic', at);
      assert.equal(currentBaseline(accepted).requirements[0].statement, source.proposals[0].requirement.statement);
      const retry = replaceProposal(accepted, contributor, 'proposal:original', structuredClone(next.proposals.at(-1)));
      assert.deepEqual(retry, accepted);
      assert.notStrictEqual(retry, accepted);
      assert.notStrictEqual(retry.proposals[0], accepted.proposals[0]);
      assert.notStrictEqual(retry.baselines[0].requirements[0], accepted.baselines[0].requirements[0]);
      assert.throws(() => { retry.baselines[0].requirements[0].statement = 'Mutation'; }, TypeError);
      assert.throws(() => replaceProposal(accepted, contributor, 'proposal:original', { ...next.proposals.at(-1), summary: 'Changed bytes' }), { code: 'idempotency_conflict' });
    }
  });

  it('copies null-prototype objects and own __proto__ data without inheritance or caller mutation', () => {
    const stream = fixture();
    const data = Object.create(null);
    data.value = ['synthetic'];
    Object.defineProperty(data, '__proto__', { enumerable: true, value: { synthetic: true } });
    Object.defineProperty(data, 'hidden', { value: 'not enumerable' });
    stream.extra = { left: data, right: data };
    const result = boundaries.append(stream);
    assert.equal(Object.getPrototypeOf(result.extra.left), Object.prototype);
    assert.equal(Object.hasOwn(result.extra.left, '__proto__'), true);
    assert.deepEqual(result.extra.left.__proto__, { synthetic: true });
    assert.equal(Object.hasOwn(result.extra.left, 'hidden'), false);
    assert.notStrictEqual(result.extra.left, result.extra.right);
    data.value.push('Caller mutation');
    assert.deepEqual(result.extra.left.value, ['synthetic']);
    assert.equal(Object.isFrozen(data), false);
  });

  it('rehydrated ancestry still requires full confirmation and rejects plain duplicate twins', () => {
    const { stream, far, twin } = ancestry();
    const approve = (input) => approveBaselineFromProposals(input, approver, [far.proposal_ref], 'baseline:synthetic', at);
    assert.throws(() => approve(JSON.parse(JSON.stringify(stream))), envelopeRequired);
    stream.proposals.splice(1, 0, twin);
    assert.throws(() => approve(JSON.parse(JSON.stringify(stream))), /duplicate stream proposal_ref/);
  });
});
