import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import { routePath } from './host-kit/index.js';
import { confirm, fixture, item, record, snapshot, validDocuments } from './host-kit/fixtures.js';

function submit(f, candidate = item(), n = 1) {
  confirm(f, candidate);
  const doc = snapshot(f.sid, [candidate]);
  const response = f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:${n}` });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  validDocuments(response.body);
  return { doc, response, id: response.body.result.data.host_ids.draft_id };
}

function replacement(f, old, n = 1) {
  const previous = old.response.body.snapshot.spec.items.at(-1);
  const content = { ...previous.content, statement: `${previous.content.statement} Revised ${n}.` };
  const candidate = item({ item_ref: previous.item_ref, version: previous.version + 1, content,
    content_sha256: sha256Hex(canonicalJson(content)), supersedes_item_version: { item_ref: previous.item_ref, version: previous.version } });
  confirm(f, candidate);
  return { candidate, doc: snapshot(f.sid, [{ ...previous, state: 'superseded' }, candidate]),
    extras: { path: routePath('intake', f.sid, 'replace', old.id), opKey: `${f.sid}:replace:${n}` } };
}

function accept(f, id, extras = {}) {
  return f.host.request({ method: 'POST', path: routePath('intake', f.sid, 'accept', id),
    person: f.host.personSession(f.sid, 'person-1'), ...extras });
}

describe('host kit intake arbitration (AIT-44b/c)', () => {
  it('sources and transcript turns return stable host IDs on exact retries, including alternate operation keys', () => {
    const f = fixture();
    for (const [action, kind, verb, idField] of [['sources', 'source', 'source', 'source_id'],
      ['transcript-turns', 'turn', 'turn', 'turn_id']]) {
      const doc = record(f.sid, kind);
      const extra = { opKey: `${f.sid}:${verb}:1` };
      const first = f.request('intake', action, doc, extra);
      assert.equal(first.status, 200);
      assert.ok(first.body.result.data.host_ids[idField]);
      assert.deepEqual(f.request('intake', action, doc, extra), first);
      const alternate = f.request('intake', action, doc, { opKey: `${f.sid}:${verb}:2` });
      assert.equal(alternate.body.result.data.host_ids[idField], first.body.result.data.host_ids[idField]);
      assert.equal(alternate.body.record.seq, first.body.record.seq);
      const changed = f.request('intake', action, `${JSON.stringify(doc)}\n`, extra);
      assert.equal(changed.status, 409);
      assert.equal(changed.body.code, 'idempotency_conflict');
      validDocuments(first.body);
      validDocuments(changed.body);
      assert.equal(f.request('journal', 'op.result', first.body.result).status, 200);
    }
    const intake = f.request('intake', '');
    assert.equal(intake.body.sources.length, 1);
    assert.equal(intake.body.turns.length, 1);
    validDocuments(intake.body);
  });

  it('atomic replace wins before accept: old is superseded, new links it, and stale acceptance fails', () => {
    const f = fixture();
    const old = submit(f);
    const next = replacement(f, old);
    const replaced = f.request('intake', 'replace', next.doc, next.extras);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.supersedes_draft_id, old.id);
    assert.deepEqual(replaced.body.snapshot.spec.items.map((i) => i.state), ['superseded', 'proposed']);
    assert.equal(replaced.body.snapshot.spec.items[1].supersedes_item_version.version, 1);
    assert.equal(accept(f, old.id).body.code, 'draft_superseded');
    assert.equal(accept(f, old.id).status, 409);
    const newId = replaced.body.result.data.host_ids.draft_id;
    const accepted = accept(f, newId);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.origin_draft_id, newId);
    assert.ok(accepted.body.node_id);
    assert.deepEqual(accepted.body.snapshot.spec.items.map((i) => i.state), ['superseded', 'accepted']);
    assert.deepEqual(accept(f, newId), accepted, 'repeat person acceptance returns its original result');
    validDocuments(replaced.body);
    validDocuments(accepted.body);
  });

  it('accept wins before replace: accepted item is terminal and no replacement is inserted', () => {
    const f = fixture();
    const old = submit(f);
    const next = replacement(f, old);
    assert.equal(accept(f, old.id).status, 200);
    const response = f.request('intake', 'replace', next.doc, next.extras);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'already_accepted');
    assert.deepEqual(f.request('intake', '').body.snapshot.spec.items.map((i) => i.state), ['accepted']);
    assert.equal(f.request('intake', 'drafts', snapshot(f.sid, [item({ version: 2 })]), { opKey: `${f.sid}:submit:2` }).status, 409);
  });

  it('replace versus replace refuses the loser; exact op retries return the original result even after acceptance', () => {
    const f = fixture();
    const old = submit(f);
    const a = replacement(f, old, 1);
    const b = replacement(f, old, 2);
    const first = f.request('intake', 'replace', a.doc, a.extras);
    assert.equal(first.status, 200);
    const loser = f.request('intake', 'replace', b.doc, b.extras);
    assert.equal(loser.body.code, 'draft_superseded');
    assert.equal(accept(f, first.body.result.data.host_ids.draft_id).status, 200);
    assert.deepEqual(f.request('intake', 'replace', a.doc, a.extras), first);
    assert.deepEqual(f.request('intake', 'drafts', old.doc, { opKey: `${f.sid}:submit:1` }), old.response);
    assert.equal(f.request('intake', 'replace', `${JSON.stringify(a.doc)}\n`, a.extras).body.code, 'idempotency_conflict');
  });

  it('authorization/fencing precedes op-key replay/conflict, which precedes lifecycle arbitration', () => {
    const f = fixture();
    const old = submit(f);
    const next = replacement(f, old);
    const first = f.request('intake', 'replace', next.doc, next.extras);
    assert.equal(first.status, 200);
    const changed = `${JSON.stringify(next.doc)}\n`;
    assert.equal(f.request('intake', 'replace', changed, next.extras).body.code, 'idempotency_conflict', 'conflict precedes superseded lifecycle');
    assert.equal(f.request('intake', 'replace', next.doc, { ...next.extras, opKey: `${f.sid}:replace:9` }).body.code, 'draft_superseded');
    assert.equal(f.request('intake', 'replace', changed, { ...next.extras, token: f.token({ capabilities: ['intake.read'] }) }).status, 403);
    f.host.takeover(f.sid);
    assert.equal(f.request('intake', 'replace', next.doc, next.extras).body.code, 'fenced_generation');
    assert.equal(f.request('intake', 'replace', changed, next.extras).body.code, 'fenced_generation');
    const current = { ...next.extras, token: f.token({ gen: 2 }), liveGrant: f.host.liveGrant(f.sid) };
    assert.deepEqual(f.request('intake', 'replace', next.doc, current), first, 'current-generation authority may retry the old payload byte-exact');
    f.host.revoke(f.sid);
    assert.equal(f.request('intake', 'replace', changed, current).body.code, 'revoked');
  });

  it('tokens of either type cannot accept, nor can forged person-session metadata', () => {
    const f = fixture();
    const old = submit(f);
    const path = routePath('intake', f.sid, 'accept', old.id);
    const noDecision = f.host.personSession(f.sid, 'person-1', ['intake.write']);
    for (const extras of [{ token: f.token() }, { person: randomUUID() }, { person: noDecision },
      { person: { role: 'person', capabilities: ['intake.decide'] } }]) {
      assert.equal(f.host.request({ method: 'POST', path, ...extras }).status, 403);
    }
    const other = randomUUID();
    f.host.createSession({ ...f.authz, sid: other });
    assert.equal(f.host.request({ method: 'POST', path, person: f.host.personSession(other, 'person-1') }).status, 403);
    assert.equal(accept(f, old.id, { token: f.token() }).status, 403, 'a bearer cannot override the person-only outer gate');
    assert.equal(accept(f, old.id).status, 200);
  });

  it('requires an ephemeral LiveGrant and full-item confirmation, never quoted or forged confirmation', () => {
    const f = fixture();
    const doc = snapshot(f.sid, [item()]);
    assert.equal(f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1`, liveGrant: undefined }).status, 403);
    assert.equal(f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1` }).status, 403);
    confirm(f, item({ content_sha256: sha256Hex('different version') }));
    assert.equal(f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1` }).status, 403);
    const candidate = item();
    confirm(f, candidate);
    const first = f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1` });
    assert.equal(first.status, 200);
    f.advance(900);
    assert.equal(f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1` }).status, 403, 'expired grant also blocks replay');
  });

  it('citation_invalid rejects missing records, assistant chains, wrong locators and invented quotations', () => {
    const f = fixture();
    const person = f.request('journal', 'records', record(f.sid)).body;
    const assistant = f.request('journal', 'records', record(f.sid, 'turn', {
      speaker: 'assistant', participant_ref: 'assistant-1', channel: 'text', trust: 'assistant', lang: 'en', body: 'Untrusted synthetic suggestion.',
    })).body;
    const source = f.request('journal', 'records', record(f.sid, 'source')).body;
    const cases = [
      { citations: [{ record_seq: 999, locator: 'turn:0' }] },
      { citations: [{ record_seq: assistant.seq, locator: 'turn:1' }] },
      { citations: [{ record_seq: person.seq, locator: 'turn:9' }] },
      { citations: [{ record_seq: source.seq, locator: 'seg:missing' }] },
      { citations: [{ record_seq: source.seq, locator: 'turn:0' }] },
      { citations: [{ record_seq: person.seq, locator: 'turn:0', quote: 'invented' }] },
      { provenance: { intent: 'requested', derived_from: [assistant.seq] } },
    ];
    for (const [n, overrides] of cases.entries()) {
      const candidate = item(overrides);
      confirm(f, candidate);
      const response = f.request('intake', 'drafts', snapshot(f.sid, [candidate]), { opKey: `${f.sid}:submit:${n}` });
      assert.equal(response.status, 422);
      assert.equal(response.body.code, 'citation_invalid');
      validDocuments(response.body);
    }
    const good = item({ citations: [{ record_seq: person.seq, locator: 'turn:0', quote: 'synthetic export' },
      { record_seq: source.seq, locator: 'seg:s1', quote: 'Synthetic' }], provenance: { intent: 'requested', derived_from: [person.seq, source.seq] } });
    assert.equal(submit(f, good, 100).response.status, 200);
  });

  it('keeps working_spec_only free of submissions and person acceptance', () => {
    const f = fixture({ session: { hostMode: 'working_spec_only' } });
    const candidate = item();
    confirm(f, candidate);
    const doc = snapshot(f.sid, [candidate], { host_mode: 'working_spec_only' });
    assert.equal(f.request('journal', 'snapshots', doc).status, 200);
    assert.equal(f.request('intake', 'drafts', doc, { opKey: `${f.sid}:submit:1` }).status, 403);
    assert.equal(accept(f, randomUUID()).status, 403);
    assert.equal(f.request('intake', '').body.snapshot, null);
  });

  it('rejects foreign, malformed, unconfirmed and mismatched replacements with no partial effects', () => {
    const f = fixture();
    const old = submit(f);
    const next = replacement(f, old);
    const badContent = { ...next.doc, spec: { ...next.doc.spec, items: next.doc.spec.items.map((i) => ({ ...i, extra: true })) } };
    assert.equal(f.request('intake', 'replace', badContent, next.extras).status, 400);
    assert.equal(f.request('intake', 'replace', next.doc, { ...next.extras, path: routePath('intake', f.sid, 'replace', randomUUID()) }).status, 404);
    const other = item({ item_ref: 'REQ-other' });
    assert.equal(f.request('intake', 'replace', snapshot(f.sid, [other]), next.extras).status, 400);
    assert.equal(f.request('intake', 'drafts', snapshot(f.sid, [item({ item_ref: 'REQ-other', state: 'draft' })]), { opKey: `${f.sid}:submit:2` }).status, 400);
    assert.equal(f.request('intake', 'sources', record(f.sid), { opKey: `${f.sid}:source:1` }).status, 400);
    assert.equal(f.request('intake', 'drafts', old.doc, { opKey: `${randomUUID()}:submit:1` }).status, 400);
    assert.equal(f.request('intake', 'drafts', old.doc, { opKey: `${f.sid}:source:1` }).status, 400);
    assert.equal(f.request('intake', '').body.snapshot.spec.items.length, 1);
    assert.equal(accept(f, old.id, { body: '{}' }).status, 400);
    f.host.revoke(f.sid, { tombstone: false });
    assert.equal(accept(f, old.id).body.code, 'revoked');
  });
});
