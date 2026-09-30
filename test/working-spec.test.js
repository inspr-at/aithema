import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import * as publicApi from '../lib/index.js';
import * as workingSpecApi from '../lib/working-spec.js';
import { replaceProposal } from '../lib/stream.js';
import {
  addWorkingItem, assertWorkingSpec, confirmWorkingItem, confirmWorkingItemVersion,
  createWorkingSpec, prepareWorkingItemRevision, projectSubmission,
  projectWorkingItemReplacement, recordHostDecision, recordWorkingItemReplacement,
  reviseWorkingItem,
} from '../lib/working-spec.js';

const sid = '00000000-0000-4000-8000-000000000000';
const draftId = '10000000-0000-4000-8000-000000000000';
const nextDraftId = '20000000-0000-4000-8000-000000000000';
const authority = { party_ref: 'party:synthetic', roles: ['delivery_party'] };
const at = '2026-09-30T00:00:00Z';
const identity = { item_ref: 'REQ-1', version: 1 };

it('exports replaceProposal and every working-spec function through the package entry point', () => {
  assert.strictEqual(publicApi.replaceProposal, replaceProposal);
  for (const [name, implementation] of Object.entries(workingSpecApi)) {
    assert.strictEqual(publicApi[name], implementation, `missing or incorrect export ${name}`);
  }
});

function input(ref = 'REQ-1') {
  return {
    item_ref: ref, kind: 'requirement',
    content: { statement: 'Expose a status endpoint.', acceptance_criteria: ['Returns the current status.'], constraint_refs: [] },
    citations: [{ record_seq: 1, locator: 'turn:0', quote: 'Expose a status endpoint.' }],
    provenance: { intent: 'requested', derived_from: [1] },
  };
}

function draft(mode = 'review') {
  return addWorkingItem(createWorkingSpec(mode), input());
}

function confirmation(item) {
  return { item_ref: item.item_ref, version: item.version, content_sha256: item.content_sha256, principal_ref: 'person:synthetic' };
}

function confirmed(mode = 'review') {
  const spec = draft(mode);
  return confirmWorkingItem(spec, confirmation(spec.items[0]));
}

function host(aeon = false, operation = 'submit', counter = 1) {
  return { op_key: `${sid}:${operation}:${counter}`, ...(aeon ? { draft_id: counter === 1 ? draftId : nextDraftId } : { proposal_ref: `proposal:${counter}` }) };
}

function proposed(aeon = false) {
  return projectSubmission(confirmed(), authority, { contributed_at: at, bindings: [{ ...identity, host: host(aeon) }] }).spec;
}

function revision(spec, seq = 1) {
  const old = spec.items.at(-1);
  return {
    content: { ...old.content, statement: 'Expose status and readiness endpoints.' },
    citations: [{ record_seq: seq, locator: `turn:${seq - 1}` }],
    provenance: { intent: 'inferred', derived_from: [seq] },
  };
}

function candidate(spec) {
  const next = prepareWorkingItemRevision(spec, identity, revision(spec));
  return confirmWorkingItemVersion(next, confirmation(next), spec.host_mode);
}

function assertContract(spec) {
  const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/snapshot.review.json', import.meta.url), 'utf8'));
  const doc = { ...fixture.doc, host_mode: spec.host_mode, spec: { ...fixture.doc.spec, items: spec.items }, pending_ops: [] };
  assert.deepEqual(validate(fixture.contract, doc), { ok: true, schemaErrors: [], invariants: [] });
}

describe('AIT-36 (a): working item versions and trusted full-content confirmation', () => {
  for (const mode of ['review', 'working_spec_only']) {
    it(`${mode}: creates contract-valid drafts and freezes a defensive copy`, () => {
      const source = input();
      const spec = addWorkingItem(createWorkingSpec(mode), source);
      source.content.statement = 'Caller mutation';
      source.content.acceptance_criteria.push('Caller criterion');
      source.citations[0].quote = 'Caller quote';
      source.provenance.derived_from.push(9);
      assert.equal(spec.items[0].content.statement, 'Expose a status endpoint.');
      assert.equal(spec.items[0].state, 'draft');
      assert.equal(spec.items[0].host, null);
      assert.equal(spec.items[0].content_sha256, sha256Hex(canonicalJson(spec.items[0].content)));
      assert.ok(Object.isFrozen(spec.items[0].content.acceptance_criteria));
      assert.ok(Object.isFrozen(spec.items[0].citations[0]));
      assert.ok(Object.isFrozen(spec.items[0].provenance.derived_from));
      assert.equal(Object.isFrozen(source.content), false);
      assert.throws(() => { spec.items[0].content.statement = 'Mutated'; }, TypeError);
      assertContract(spec);
    });

    it(`${mode}: confirmation binds statement, criteria and constraint refs with RFC 8785`, () => {
      const spec = draft(mode);
      const original = spec.items[0];
      for (const content of [
        { ...original.content, statement: 'Another statement' },
        { ...original.content, acceptance_criteria: ['Another criterion'] },
        { ...original.content, constraint_refs: ['CON-1'] },
      ]) {
        assert.throws(() => confirmWorkingItem(spec, { ...confirmation(original), content_sha256: sha256Hex(canonicalJson(content)) }), /bind the exact/);
      }
      assert.throws(() => confirmWorkingItem(spec, { ...confirmation(original), version: 2 }), /not found/);
      assert.throws(() => confirmWorkingItem(spec, { ...confirmation(original), principal_ref: '' }), /invalid UI confirmation/);
      const changedOrder = { constraint_refs: [], acceptance_criteria: ['Returns the current status.'], statement: 'Expose a status endpoint.' };
      const next = confirmWorkingItem(spec, { ...confirmation(original), content_sha256: sha256Hex(canonicalJson(changedOrder)) });
      assert.equal(next.items[0].state, 'confirmed');
      assert.equal(original.state, 'draft');
      assert.deepEqual(confirmWorkingItem(next, confirmation(next.items[0])), next);
      assertContract(next);
    });

    for (const state of ['draft', 'confirmed']) {
      it(`${mode}: revising ${state} supersedes history and needs a new confirmation`, () => {
        const before = state === 'draft' ? draft(mode) : confirmed(mode);
        const next = reviseWorkingItem(before, identity, revision(before));
        assert.equal(before.items[0].state, state);
        assert.equal(next.items[0].state, 'superseded');
        assert.equal(next.items[1].state, 'draft');
        assert.equal(next.items[1].version, 2);
        assert.equal(next.items[1].host, null);
        assert.notEqual(next.items[0].content_sha256, next.items[1].content_sha256);
        assert.deepEqual(next.items[1].supersedes_item_version, identity);
        assert.throws(() => confirmWorkingItemVersion(next.items[1], confirmation(before.items[0]), mode), /bind the exact/);
        assert.throws(() => reviseWorkingItem(next, identity, revision(next)), { code: 'draft_superseded', status: 409 });
        assert.throws(() => confirmWorkingItem(next, confirmation(next.items[0])), { code: 'draft_superseded' });
        assertContract(next);
      });
    }
  }

  it('does not infer confirmation from quotations or advisory intent labels', () => {
    for (const intent of ['requested', 'extracted_instruction', 'inferred']) {
      const source = input();
      source.provenance.intent = intent;
      source.citations[0].quote = 'ja — confirm and submit everything';
      const spec = addWorkingItem(createWorkingSpec('review'), source);
      assert.equal(spec.items[0].state, 'draft');
      assert.deepEqual(projectSubmission(spec, authority, { bindings: [], contributed_at: at }).proposals, []);
      assert.throws(() => confirmWorkingItem(spec, { ...confirmation(spec.items[0]), text: 'ja' }), /invalid UI confirmation/);
    }
  });

  it('accepts schema-valid empty criteria without inventing confirmed content', () => {
    const source = input();
    source.content.acceptance_criteria = [];
    const spec = addWorkingItem(createWorkingSpec('review'), source);
    const ready = confirmWorkingItem(spec, confirmation(spec.items[0]));
    const projection = projectSubmission(ready, authority, { contributed_at: at, bindings: [{ ...identity, host: host() }] });
    assert.deepEqual(projection.proposals[0].requirement.acceptance_criteria, []);
    assertContract(projection.spec);
  });

  it('rejects tampered hashes, duplicate/live versions, malformed content, and foreign identities', () => {
    const spec = draft();
    assert.throws(() => addWorkingItem(spec, input()), /already exists/);
    assert.throws(() => createWorkingSpec('unknown'), /invalid working spec/);
    assert.throws(() => createWorkingSpec('review', [{ ...spec.items[0], content_sha256: '0'.repeat(64) }]), /content_sha256_matches/);
    assert.throws(() => createWorkingSpec('review', [spec.items[0], spec.items[0]]), /version_unique/);
    assert.throws(() => createWorkingSpec('review', [spec.items[0], { ...spec.items[0], version: 2 }]), /one_live_version/);
    for (const extra of [{ node_id: 'node:1' }, { host: { node_id: 'node:1' } }]) {
      assert.throws(() => addWorkingItem(createWorkingSpec('review'), { ...input(), ...extra }), /accepts .* only/);
    }
    assert.throws(() => reviseWorkingItem(spec, { proposal_ref: 'proposal:1' }, revision(spec)), /item identity/);
    assert.throws(() => addWorkingItem(createWorkingSpec('review'), { ...input(), content: { ...input().content, statement: '\ud800' } }), /surrogates/);
    assert.throws(() => addWorkingItem(createWorkingSpec('review'), { ...input(), content: { ...input().content, node_id: 'node:1' } }), /unknown key/);
    assert.throws(() => createWorkingSpec('review', [{ ...spec.items[0], supersedes_item_version: { proposal_ref: 'proposal:1' } }]), /unknown key|oneOf/);
    assert.throws(() => createWorkingSpec('review', [{ ...spec.items[0], supersedes_item_version: { item_ref: 'OTHER', version: 1 } }]), /supersedes/);
    assert.throws(() => createWorkingSpec('review', Array.from({ length: 201 }, (_, i) => ({ ...spec.items[0], item_ref: `REQ-${i}` }))), /more than 200/);
  });

  it('rejects proposed/closed host states and identities in working_spec_only', () => {
    const item = proposed().items[0];
    for (const state of ['proposed', 'accepted', 'rejected', 'invalidated']) {
      assert.throws(() => createWorkingSpec('working_spec_only', [{ ...item, state }]), /state_allowed_in_mode/);
    }
    assert.throws(() => createWorkingSpec('working_spec_only', [{ ...draft().items[0], state: 'superseded', host: host() }]), /no_host_identity/);
    assert.throws(() => createWorkingSpec('review', [{ ...draft().items[0], host: host() }]), /host_identity_forbidden/);
    assert.throws(() => createWorkingSpec('review', [{ ...draft().items[0], state: 'proposed' }]), /host_identity_required/);
  });
});

describe('AIT-36 (d): submission-time projection', () => {
  for (const aeon of [false, true]) {
    it(`${aeon ? 'draft_id' : 'proposal_ref'}: projects only confirmed versions with immutable full content`, () => {
      let spec = confirmed();
      spec = addWorkingItem(spec, input('REQ-2'));
      const source = { contributed_at: at, bindings: [{ ...identity, host: host(aeon) }] };
      const next = projectSubmission(spec, authority, source);
      assert.equal(spec.items[0].state, 'confirmed');
      assert.equal(spec.items[0].host, null);
      assert.equal(next.spec.items[0].state, 'proposed');
      assert.equal(next.spec.items[1].state, 'draft');
      assert.equal(next.proposals.length, 1);
      assert.deepEqual(next.proposals[0].content, spec.items[0].content);
      assert.equal(next.proposals[0].content_sha256, spec.items[0].content_sha256);
      assert.deepEqual(next.proposals[0].citations, spec.items[0].citations);
      assert.deepEqual(next.proposals[0].provenance, spec.items[0].provenance);
      source.bindings[0].host.op_key = `${sid}:submit:9`;
      assert.equal(next.spec.items[0].host.op_key, `${sid}:submit:1`);
      assert.ok(Object.isFrozen(next.proposals[0].content.acceptance_criteria));
      assert.deepEqual(projectSubmission(next.spec, authority, { contributed_at: at, bindings: [] }).proposals, []);
      assertContract(next.spec);
    });
  }

  it('projects constraints to standalone constraints or Aeon briefs', () => {
    const source = { ...input('CON-1'), kind: 'constraint', content: { ...input().content, constraint_kind: 'technical' } };
    const initial = addWorkingItem(createWorkingSpec('review'), source);
    const spec = confirmWorkingItem(initial, confirmation(initial.items[0]));
    for (const aeon of [false, true]) {
      const projection = projectSubmission(spec, authority, { contributed_at: at, bindings: [{ item_ref: 'CON-1', version: 1, host: host(aeon) }] });
      assert.equal(projection.proposals[0].kind, aeon ? 'brief' : 'add_constraint');
      assert.equal(projection.proposals[0].content.constraint_kind, 'technical');
      assertContract(projection.spec);
    }
    const withoutKind = addWorkingItem(createWorkingSpec('review'), { ...source, content: input().content });
    const ready = confirmWorkingItem(withoutKind, confirmation(withoutKind.items[0]));
    assert.throws(() => projectSubmission(ready, authority, { contributed_at: at, bindings: [{ item_ref: 'CON-1', version: 1, host: host() }] }), /constraint_kind/);
  });

  it('working_spec_only never projects, including confirmed versions at session end', () => {
    const spec = confirmed('working_spec_only');
    const next = projectSubmission(spec, null, null);
    assert.deepEqual(next.proposals, []);
    assert.deepEqual(next.spec, spec);
    assert.equal(next.spec.items[0].host, null);
    assertContract(next.spec);
  });

  it('refuses missing, extraneous, duplicate or mixed host bindings atomically', () => {
    const spec = confirmed();
    for (const bindings of [[], [{ ...identity, version: 2, host: host() }], [{ ...identity, host: { ...host(), draft_id: draftId } }], [{ ...identity, host: { op_key: `${sid}:submit:1`, node_id: 'node:1' } }], [{ ...identity, host: host(false, 'replace') }]]) {
      assert.throws(() => projectSubmission(spec, authority, { bindings, contributed_at: at }));
    }
    let two = addWorkingItem(spec, input('REQ-2'));
    two = confirmWorkingItem(two, confirmation(two.items[1]));
    assert.throws(() => projectSubmission(two, authority, { contributed_at: at, bindings: [{ ...identity, host: host() }, { item_ref: 'REQ-2', version: 1, host: host() }] }), /already bound/);
    assert.equal(spec.items[0].state, 'confirmed');
    assert.throws(() => projectSubmission(spec, { party_ref: 'party:invalid', roles: [] }, { bindings: [{ ...identity, host: host() }], contributed_at: at }), /verified authority/);
  });
});

describe('AIT-36 (a, c, z): proposed versions, terminal decisions and atomic replacement', () => {
  for (const aeon of [false, true]) {
    it(`${aeon ? 'Aeon' : 'standalone'}: prepares a detached replacement and records separate supersedes identities`, () => {
      const spec = proposed(aeon);
      const replacement = candidate(spec);
      assert.equal(spec.items.length, 1);
      assert.equal(spec.items[0].state, 'proposed');
      assert.throws(() => createWorkingSpec('review', [...spec.items, replacement]), /target_is_superseded|one_live_version/);
      assert.throws(() => reviseWorkingItem(spec, identity, revision(spec)), /atomic host replacement/);
      const next = projectWorkingItemReplacement(spec, authority, identity, replacement, { host: host(aeon, 'replace', 2), contributed_at: at });
      assert.deepEqual(next.spec.items.map((item) => item.state), ['superseded', 'proposed']);
      assert.deepEqual(next.spec.items[1].supersedes_item_version, identity);
      assert.equal(next.proposal[aeon ? 'supersedes_draft_id' : 'supersedes_proposal_ref'], aeon ? draftId : 'proposal:1');
      assert.equal(Object.hasOwn(next.proposal, aeon ? 'supersedes_proposal_ref' : 'supersedes_draft_id'), false);
      assert.throws(() => recordHostDecision(next.spec, identity, spec.items[0].host, 'accepted'), { code: 'draft_superseded' });
      assert.throws(() => recordWorkingItemReplacement(next.spec, identity, replacement, host(aeon, 'replace', 3)), { code: 'draft_superseded' });
      assertContract(next.spec);
    });
  }

  it('acceptance is terminal for all versions of that item_ref', () => {
    const spec = proposed();
    const replacement = candidate(spec);
    const accepted = recordHostDecision(spec, identity, spec.items[0].host, 'accepted');
    assert.deepEqual(recordHostDecision(accepted, identity, spec.items[0].host, 'accepted'), accepted);
    assert.throws(() => recordWorkingItemReplacement(accepted, identity, replacement, host(false, 'replace', 2)), { code: 'already_accepted' });
    assert.throws(() => prepareWorkingItemRevision(accepted, identity, revision(accepted)), { code: 'already_accepted' });
    assert.throws(() => recordHostDecision(accepted, identity, spec.items[0].host, 'invalidated'), { code: 'already_accepted' });
    assert.throws(() => createWorkingSpec('review', [...accepted.items, { ...replacement, supersedes_item_version: null }]), /accepted_is_terminal/);
    assert.throws(() => addWorkingItem(accepted, input()), /already exists/);
    assertContract(addWorkingItem(accepted, { ...input('REQ-2'), content: { ...input().content, statement: 'Discuss REQ-1 in prose.' } }));
  });

  for (const state of ['rejected', 'invalidated']) {
    it(`${state} stays closed while a new version can be confirmed and re-proposed`, () => {
      const spec = proposed();
      const closed = recordHostDecision(spec, identity, spec.items[0].host, state);
      if (state === 'rejected') {
        assert.throws(() => reviseWorkingItem(closed, identity, revision(closed)), /new evidence/);
        const changedQuote = revision(closed);
        changedQuote.citations[0].quote = 'A different quote from the same evidence';
        assert.throws(() => reviseWorkingItem(closed, identity, changedQuote), /new evidence/);
      }
      let next = reviseWorkingItem(closed, identity, revision(closed, 2));
      assert.equal(next.items[0].state, state);
      assert.equal(next.items[1].supersedes_item_version, null);
      next = confirmWorkingItem(next, confirmation(next.items[1]));
      next = projectSubmission(next, authority, { contributed_at: at, bindings: [{ item_ref: 'REQ-1', version: 2, host: host(false, 'submit', 2) }] }).spec;
      assertContract(next);
      assert.throws(() => reviseWorkingItem(next, identity, revision(next, 3)), { code: 'draft_superseded' });
      assert.throws(() => recordHostDecision(closed, identity, spec.items[0].host, 'accepted'), /illegal working item transition/);
    });
  }

  it('refuses unconfirmed, forged, skipped-version, wrong-kind and cross-host replacements', () => {
    const spec = proposed();
    const replacement = candidate(spec);
    for (const forged of [
      { ...replacement, state: 'draft' }, { ...replacement, version: 3 },
      { ...replacement, kind: 'constraint' }, { ...replacement, item_ref: 'REQ-2' },
      { ...replacement, supersedes_item_version: null },
    ]) assert.throws(() => recordWorkingItemReplacement(spec, identity, forged, host(false, 'replace', 2)), /replacement must/);
    assert.throws(() => recordWorkingItemReplacement(spec, identity, replacement, host(true, 'replace', 2)), /same host identity type/);
    assert.throws(() => recordWorkingItemReplacement(spec, identity, replacement, { ...host(false, 'replace', 2), node_id: 'node:1' }), /unknown key|oneOf/);
    assert.throws(() => recordHostDecision(spec, identity, { node_id: 'node:1' }, 'accepted'), /exact proposal identity/);
    assert.throws(() => recordHostDecision(spec, identity, host(false, 'submit', 2), 'accepted'), /exact proposal identity/);
    assert.throws(() => recordHostDecision(spec, identity, host(), 'superseded'), /unsupported host decision/);
    assert.throws(() => recordHostDecision(confirmed(), identity, host(), 'accepted'), /exact proposal identity/);
  });
});
