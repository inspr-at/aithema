import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canExecute, canonicalJson, loadContractFile, pendingContentReference, pendingContentReferenceMaxLength, sha256Hex, validate } from '../contracts/validate.js';
import { journalChunkBytes } from '../runtime/journal/pending-content.js';
import { SqliteJournal, JournalClient, hydrateSnapshot } from '../runtime/journal/index.js';
import { AeonHttp, AeonIntake, AeonJournal } from '../runtime/hosts/aeon/index.js';
import { fixture, item, record, snapshot } from './host-kit/fixtures.js';

const bytes = (doc) => Buffer.from(canonicalJson(doc), 'utf8');
const invalid = (error) => error.status === 422 && error.code === 'citation_invalid';

/** No sockets or providers: the real HTTP parser consumes in-process responses. */
function setup(t, type = 'mock', transform) {
  const f = fixture({ sid: '11111111-1111-4111-8111-111111111111' });
  const authority = { sid: f.sid, tid: f.authz.tid, pid: f.authz.pid, gen: 1, auth_epoch: 1,
    writer_kind: 'worker', capabilities: [...loadContractFile('capabilities.json').delegated_allowed], exp: f.now() + 900 };
  const requests = [];
  let liveGrant = f.liveGrant;
  const http = new AeonHttp({ baseUrl: 'https://host.example', scope: authority,
    credentials: (a) => ({ token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch }), liveGrant }),
    fetchImpl: async (url, init) => {
      const request = { method: init.method, path: new URL(url).pathname + new URL(url).search,
        token: init.headers.authorization.slice(7), liveGrant: init.headers['x-live-grant'],
        opKey: init.headers['idempotency-key'], intakeMetadata: init.headers['x-aithema-intake'],
        ...(init.body === undefined ? {} : { body: Buffer.from(init.body).toString('utf8') }) };
      requests.push(request);
      let response = f.host.request(request);
      if (transform) response = transform(response, request) ?? response;
      return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
    },
  });
  let path;
  const journal = type === 'sqlite' ? (() => {
    path = join(mkdtempSync(join(tmpdir(), 'aithema-pending-')), 'journal.sqlite');
    const port = new SqliteJournal(path, { now: () => f.now() * 1000 });
    port.createSession(bytes({ contract: 'aithema.session.create', major: 1, minor: 0, min_reader: 0,
      sid: f.sid, tid: f.authz.tid, pid: f.authz.pid, host_mode: 'review', preset_ref: 'local-l1',
      lang: 'en', authz_epoch: 1, submission: { auto: false } }));
    t.after(() => port.close());
    const takeover = port.takeover.bind(port);
    port.takeover = (a) => {
      const cursor = takeover(a);
      f.host.takeover(f.sid);
      liveGrant = f.host.liveGrant(f.sid);
      return cursor;
    };
    return port;
  })() : new AeonJournal({ http, recordFormat: 'chunked', takeoverAuthority: (a) => {
    const gen = f.host.takeover(f.sid);
    liveGrant = f.host.liveGrant(f.sid);
    return { ...a, gen };
  } });
  const intake = new AeonIntake({ http, journal, supportsReplace: true, now: () => f.now() * 1000 });
  return { f, http, journal, intake, authority, requests, path };
}

function pendingSnapshot(s, ops, overrides = {}) {
  return snapshot(s.f.sid, [], { minor: 2, min_reader: 2, pending_ops: ops, ...overrides });
}

function contentRecord(s, canonical, overrides = {}) {
  return record(s.f.sid, 'pending_op.content', { canonical, sha256: sha256Hex(canonical), size: Buffer.byteLength(canonical) },
    { minor: 2, min_reader: 2, ...overrides });
}

function referencedOp(s, seq, canonical, overrides = {}) {
  const payload = canonicalJson({ kind: 'pending_op.content', record_seq: seq, sha256: sha256Hex(canonical), size: Buffer.byteLength(canonical) });
  return { op_key: `${s.f.sid}:source:1`, op: 'post_source', payload_kind: 'pending_op.content',
    payload, payload_sha256: sha256Hex(payload), ...overrides };
}

function extensions(fill = 'a') {
  const map = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`x-synthetic.slot${n}@1`,
    { version: '1.0', data: { text: '' } }]));
  let remaining = 64 * 1024 - Buffer.byteLength(canonicalJson(map));
  for (const instance of Object.values(map)) {
    const width = Buffer.byteLength(canonicalJson(fill)) - 2;
    const amount = Math.min(remaining, 16 * 1024 - Buffer.byteLength(canonicalJson(instance)));
    instance.data.text = fill.repeat(Math.floor(amount / width)) + 'a'.repeat(amount % width);
    remaining -= amount;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(canonicalJson(map)), 64 * 1024);
  return map;
}

function registerExtensions(s) {
  for (let n = 0; n < 8; n++) s.f.host.registerExtension(s.f.sid, { namespace: `x-synthetic.slot${n}`, version: '1.0',
    title: 'Synthetic extension', schema: { type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', maxLength: 16384 } } } });
}

async function confirm(s, candidate) {
  const result = s.f.request('journal', 'records', record(s.f.sid, 'ui.confirm', { item_ref: candidate.item_ref,
    version: candidate.version, content_sha256: candidate.content_sha256, principal_ref: 'person-1' }));
  assert.equal(result.status, 200);
}

for (const type of ['sqlite', 'mock']) {
  it(`(a,b) ${type}: eight extensions totalling exactly 64 KiB prepare, persist and execute`, async (t) => {
    const s = setup(t, type);
    registerExtensions(s);
    const candidate = item({ extensions: extensions() });
    await confirm(s, candidate);
    const input = bytes(snapshot(s.f.sid, [candidate], { minor: 1 }));
    const op = await s.intake.prepare({ op: 'submit', n: Number.MAX_SAFE_INTEGER, bytes: input, authority: s.authority });
    assert.ok(op.payload.length <= pendingContentReferenceMaxLength);
    assert.equal(Object.hasOwn(JSON.parse(op.payload), 'document_bytes'), false);
    const saved = await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
    assert.ok(pendingContentReference(op.payload).record_seq < saved.document.seq);
    const result = await s.intake.execute(op, s.authority);
    assert.deepEqual(result.snapshot.spec.items[0].extensions, candidate.extensions);
    assert.equal(s.requests.find((r) => r.opKey === op.op_key).body, type === 'mock' ? op.payload : input.toString());
    const second = await s.intake.retryOp({ ...op, payload_bytes: Buffer.from(op.payload) }, s.authority);
    assert.deepEqual(second, result.result.data.host_ids);
  });

  it(`(a,b) ${type}: a contract-valid 13 MB snapshot lives in immutable content, with a bounded pending op`, async (t) => {
    const s = setup(t, type);
    registerExtensions(s);
    const map = extensions();
    const items = Array.from({ length: 200 }, (_, n) => item({ item_ref: `REQ-${n}`, state: n === 0 ? 'confirmed' : 'draft', extensions: map }));
    const input = bytes(snapshot(s.f.sid, items, { minor: 1 }));
    assert.ok(input.length >= 13_000_000);
    assert.equal(validate('aithema.spec.snapshot', JSON.parse(input)).ok, true);
    await confirm(s, items[0]);
    const op = await s.intake.prepare({ op: 'submit', n: 1, bytes: input, authority: s.authority });
    assert.ok(op.payload.length <= pendingContentReferenceMaxLength);
    const [stored] = await s.journal.recordsByDigests([pendingContentReference(op.payload).sha256], s.authority);
    assert.ok(stored.document.data.size > input.length);
    assert.equal(JSON.parse(stored.document.data.canonical).document_bytes, input.toString());
    assert.equal(validate(stored.document.contract, stored.document).ok, true);
    const complete = { ...JSON.parse(input), client_event_id: randomUUID(), minor: 2, min_reader: 2, pending_ops: [op] };
    const committed = await s.journal.append(bytes(complete), s.authority);
    const hydrated = await hydrateSnapshot(s.journal, committed, s.authority);
    assert.equal(hydrated.get(stored.document.seq).document.data.sha256, stored.document.data.sha256);
    const result = await s.intake.execute(op, s.authority);
    assert.deepEqual(result.snapshot.spec.items[0].extensions, map);
    assert.equal(s.requests.find((r) => r.opKey === op.op_key).body, type === 'mock' ? op.payload : input.toString());
    if (type === 'mock') {
      const chunks = s.requests.filter((r) => r.path.includes('offset='));
      assert.ok(chunks.length > 50, 'large content uses bounded transport pages');
      assert.ok(chunks.every((r) => new URL(r.path, 'https://host.example').searchParams.get('length') === String(journalChunkBytes)));
      assert.ok(s.requests.every((r) => Buffer.byteLength(r.body ?? '') <= 1024 * 1024), 'all writes respect the original HTTP request cap');
      assert.ok(s.requests.some((r) => r.path.includes('upload=')), 'large journal writes use bounded chunks');
    }
    const fresh = new AeonIntake({ http: s.http, journal: s.journal });
    const resumed = await new JournalClient({ port: s.journal, authority: s.authority, now: () => s.f.now() * 1000 })
      .resume({ retryOp: fresh.retryOp.bind(fresh) });
    assert.deepEqual(resumed.completedOps.get(op.op_key), result.result.data.host_ids);
    assert.deepEqual(s.requests.filter((r) => r.opKey === op.op_key).map((r) => r.body),
      Array(2).fill(type === 'mock' ? op.payload : input.toString()));
  });

  it(`(a,c) ${type}: crash after the content write leaves no op; retry reuses the same content address`, async (t) => {
    const s = setup(t, type);
    const original = Buffer.from(`\n${JSON.stringify(record(s.f.sid, 'source'), null, 2)}\n`);
    const crashing = new AeonIntake({ http: s.http, now: () => s.f.now() * 1000,
      journal: {
        recordsByIds: (...args) => s.journal.recordsByIds(...args),
        recordsByDigests: (...args) => s.journal.recordsByDigests(...args),
        async append(...args) { await s.journal.append(...args); throw new Error('synthetic crash after durable record'); },
      } });
    await assert.rejects(crashing.prepare({ op: 'post_source', n: 1, bytes: original, authority: s.authority }), /synthetic crash/);
    const cursor = await s.journal.cursor(s.authority);
    assert.equal(cursor.snapshot, null);
    const records = await s.journal.recordsAfter(0, s.authority);
    assert.deepEqual(records.map((r) => r.document.kind), ['pending_op.content']);
    const fresh = new AeonIntake({ http: s.http, journal: s.journal });
    const op = await fresh.prepare({ op: 'post_source', n: 1, bytes: original, authority: s.authority });
    assert.equal(pendingContentReference(op.payload).record_seq, records[0].document.seq);
    assert.equal((await s.journal.recordsAfter(0, s.authority)).length, 1);
    await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
    await fresh.execute(op, s.authority);
    assert.equal(s.requests.find((r) => r.opKey === op.op_key).body, type === 'mock' ? op.payload : original.toString());
  });

  it(`(c) ${type}: quote-heavy bytes and metadata survive lost intake acknowledgement and fresh-adapter resume`, async (t) => {
    const s = setup(t, type);
    registerExtensions(s);
    const candidate = item({ extensions: extensions('"'), citations: [{ record_seq: 1, locator: 'turn:0', quote: '"\\\n😀' }],
      provenance: { intent: 'requested', derived_from: [1] } });
    const turnDoc = record(s.f.sid, 'turn', { speaker: 'person', participant_ref: 'person-1', channel: 'text',
      trust: 'authenticated_person', lang: 'en', body: '"\\\n😀' });
    // Source/turn host IDs are acknowledged separately from the journal record.
    const sourceDoc = record(s.f.sid, 'source');
    const hostSource = s.f.request('intake', 'sources', bytes(sourceDoc).toString(), { opKey: `${s.f.sid}:source:9` });
    const conversationSourceId = hostSource.body.result.data.host_ids.source_id;
    const hostTurn = s.f.request('intake', 'transcript-turns', bytes(turnDoc).toString(), { opKey: `${s.f.sid}:turn:9`,
      intakeMetadata: Buffer.from(canonicalJson({ conversation_source_id: conversationSourceId })).toString('base64url') });
    await s.journal.append(bytes(sourceDoc), s.authority);
    const journalTurn = await s.journal.append(bytes(turnDoc), s.authority);
    candidate.citations[0].record_seq = journalTurn.document.seq;
    candidate.provenance.derived_from = [journalTurn.document.seq];
    // Mock host journal seqs include the intake source; use its acknowledged
    // turn identity in evidence and keep the standalone journal seq explicit.
    if (type === 'mock') {
      candidate.citations[0].record_seq = hostTurn.body.record.seq;
      candidate.provenance.derived_from = [hostTurn.body.record.seq];
    }
    s.intake.bindHostSource({ ...turnDoc, seq: candidate.citations[0].record_seq }, hostTurn.body.result.data.host_ids,
      { conversationSourceId });
    await confirm(s, candidate);
    const input = Buffer.from(`\n${JSON.stringify(snapshot(s.f.sid, [candidate], { minor: 1 }), null, 2)}\n`);
    const op = await s.intake.prepare({ op: 'submit', n: 1, bytes: input, authority: s.authority,
      context: { sid: s.f.sid, records: [{ ...turnDoc, seq: candidate.citations[0].record_seq }],
        turnOrdinals: new Map([[candidate.citations[0].record_seq, 0]]) } });
    await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
    const first = await s.intake.execute(op, s.authority); // response is discarded before op.result
    const client = new JournalClient({ port: s.journal, authority: s.authority, now: () => s.f.now() * 1000 });
    const fresh = new AeonIntake({ http: s.http, journal: s.journal });
    const resumed = await client.resume({ retryOp: fresh.retryOp.bind(fresh) });
    assert.deepEqual(resumed.completedOps.get(op.op_key), first.result.data.host_ids);
    const sends = s.requests.filter((r) => r.opKey === op.op_key);
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body, type === 'mock' ? op.payload : input.toString());
    assert.equal(sends[1].body, sends[0].body);
    assert.equal(sends[1].intakeMetadata, sends[0].intakeMetadata);
    assert.equal(resumed.closure.get(pendingContentReference(op.payload).record_seq).document.kind, 'pending_op.content');
  });

  it(`(a,d) ${type}: content cannot be updated, and its digest address deduplicates new event IDs`, async (t) => {
    const s = setup(t, type);
    const canonical = canonicalJson({ document_bytes: '{}', metadata: {} });
    const doc = contentRecord(s, canonical);
    const first = await s.journal.append(bytes(doc), s.authority);
    const duplicate = await s.journal.append(bytes({ ...doc, client_event_id: randomUUID() }), s.authority);
    assert.equal(duplicate.document.seq, first.document.seq);
    assert.deepEqual(duplicate.bytes, first.bytes);
    first.bytes.fill(0);
    first.document.data.canonical = 'mutated';
    const [again] = await s.journal.recordsByIds([duplicate.document.seq], s.authority);
    assert.equal(again.document.data.canonical, canonical);
    if (type === 'sqlite') {
      const db = new DatabaseSync(s.path);
      t.after(() => db.close());
      assert.throws(() => db.prepare('UPDATE journal_records SET original_bytes = ? WHERE sid = ? AND seq = ?').run('{}', s.f.sid, duplicate.document.seq), /immutable/);
      assert.throws(() => db.prepare('DELETE FROM journal_records WHERE sid = ? AND seq = ?').run(s.f.sid, duplicate.document.seq), /immutable/);
    }
  });

  it(`(a,c) ${type}: a deduplicated event ID remains reserved for byte-exact retry`, async (t) => {
    const s = setup(t, type);
    const canonical = canonicalJson({ document_bytes: '{}', metadata: {} });
    const firstDoc = contentRecord(s, canonical);
    const first = await s.journal.append(bytes(firstDoc), s.authority);
    const aliasDoc = { ...firstDoc, client_event_id: randomUUID() };
    const aliasBytes = bytes(aliasDoc);
    const duplicate = await s.journal.append(aliasBytes, s.authority);
    assert.equal(duplicate.document.seq, first.document.seq);
    const retried = await s.journal.append(aliasBytes, s.authority);
    assert.deepEqual(retried.bytes, first.bytes);
    const changed = contentRecord(s, canonicalJson({ document_bytes: '{"changed":true}', metadata: {} }),
      { client_event_id: aliasDoc.client_event_id });
    for (const input of [bytes(changed), Buffer.from(aliasBytes.toString() + '\n'),
      bytes(record(s.f.sid, 'source', null, { client_event_id: aliasDoc.client_event_id }))]) {
      await assert.rejects(async () => s.journal.append(input, s.authority), { status: 409, code: 'idempotency_conflict' });
    }
    if (type === 'sqlite') {
      const reopened = new SqliteJournal(s.path, { now: () => s.f.now() * 1000 });
      t.after(() => reopened.close());
      assert.deepEqual(reopened.append(aliasBytes, s.authority).bytes, first.bytes);
      assert.throws(() => reopened.append(bytes(changed), s.authority), { status: 409, code: 'idempotency_conflict' });
    }
    assert.equal((await s.journal.cursor(s.authority)).last_seq, first.document.seq);
  });

  it(`(a,c) ${type}: a content reference cannot be committed before its record`, async (t) => {
    const s = setup(t, type);
    const canonical = canonicalJson({ document_bytes: '{}', metadata: {} });
    const op = referencedOp(s, 1, canonical);
    await assert.rejects(async () => s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority), invalid);
    assert.equal((await s.journal.cursor(s.authority)).snapshot, null);
    const saved = await s.journal.append(bytes(contentRecord(s, canonical)), s.authority);
    assert.equal(saved.document.seq, 1);
    await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
  });

  it(`(c) ${type}: missing, tampered, wrong-size and wrong-kind content is refused before intake effects`, async (t) => {
    const s = setup(t, type);
    const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
    const ref = pendingContentReference(op.payload);
    const ordinary = await s.journal.append(bytes(record(s.f.sid)), s.authority);
    for (const patch of [{ sha256: '0'.repeat(64) }, { size: ref.size + 1 }, { record_seq: 9000 }, { record_seq: ordinary.document.seq }]) {
      const payload = canonicalJson({ ...ref, ...patch });
      const altered = { ...op, payload, payload_sha256: sha256Hex(payload) };
      const calls = s.requests.filter((r) => r.opKey).length;
      await assert.rejects(s.intake.execute(altered, s.authority), invalid);
      await assert.rejects(async () => s.journal.append(bytes(pendingSnapshot(s, [altered])), s.authority), invalid);
      assert.equal(s.requests.filter((r) => r.opKey).length, calls);
    }
  });
}

it('(b,d) the 159-character bound is derived from schema fields and reader 1 refuses referenced snapshots', async (t) => {
  const s = setup(t, 'sqlite');
  const canonical = canonicalJson({ document_bytes: '{}', metadata: {} });
  const op = referencedOp(s, Number.MAX_SAFE_INTEGER, canonical);
  const payload = canonicalJson({ kind: 'pending_op.content', record_seq: Number.MAX_SAFE_INTEGER,
    sha256: 'a'.repeat(64), size: Number.MAX_SAFE_INTEGER });
  assert.equal(payload.length, pendingContentReferenceMaxLength);
  const doc = pendingSnapshot(s, [{ ...op, payload, payload_sha256: sha256Hex(payload) }]);
  assert.equal(validate(doc.contract, doc).ok, true);
  assert.deepEqual(canExecute(doc, { [doc.contract]: { major: 1, minor: 1 } }), { ok: false, code: 'contract_too_new' });
  for (const overrides of [{ minor: 1 }, { min_reader: 1 }]) assert.equal(validate(doc.contract, { ...doc, ...overrides }).ok, false);
  for (const altered of [{ ...JSON.parse(payload), extra: 1 }, { ...JSON.parse(payload), size: -1 },
    { ...JSON.parse(payload), record_seq: Number.MAX_SAFE_INTEGER + 1 }, { ...JSON.parse(payload), kind: 'source' }]) {
    const text = canonicalJson(altered);
    assert.equal(validate(doc.contract, pendingSnapshot(s, [{ ...op, payload: text, payload_sha256: sha256Hex(text) }])).ok, false);
  }
});

it('(a,d) invalid content hashes, sizes, noncanonical JSON, foreign writers and old reader declarations are refused', async (t) => {
  const s = setup(t, 'sqlite');
  const doc = contentRecord(s, canonicalJson({ document_bytes: '{}', metadata: {} }));
  for (const data of [{ ...doc.data, sha256: '0'.repeat(64) }, { ...doc.data, size: doc.data.size + 1 },
    { ...doc.data, canonical: doc.data.canonical + ' ' }, { canonical: '{}', sha256: sha256Hex('{}'), size: 2 }]) {
    assert.equal(validate(doc.contract, { ...doc, data }).ok, false);
  }
  for (const patch of [{ min_reader: 1 }, { minor: 1 }, { writer: { kind: 'host' } }, { writer: { kind: 'browser' } }]) {
    assert.equal(validate(doc.contract, { ...doc, ...patch }).ok, false);
  }
});

it('(b) eight full 16 KiB instances exceed the unchanged 64 KiB map contract and are refused', async (t) => {
  const s = setup(t, 'sqlite');
  const map = extensions();
  for (const instance of Object.values(map)) instance.data.text += 'a'.repeat(16 * 1024 - Buffer.byteLength(canonicalJson(instance)));
  const doc = snapshot(s.f.sid, [item({ extensions: map })], { minor: 1 });
  assert.ok(Buffer.byteLength(canonicalJson(map)) > 64 * 1024);
  assert.equal(validate(doc.contract, doc).ok, false);
  assert.throws(() => s.intake.prepare({ op: 'submit', n: 1, bytes: bytes(doc), authority: s.authority }), { status: 400 });
});

it('(c) a referenced post_source and post_turn preserve exact bytes, and changed retry bytes are refused', async (t) => {
  const s = setup(t);
  const sourceBytes = Buffer.from(`\n${JSON.stringify(record(s.f.sid, 'source'), null, 2)}\n`);
  const sourceOp = await s.intake.prepare({ op: 'post_source', n: 1, bytes: sourceBytes, authority: s.authority });
  const source = await s.intake.execute(sourceOp, s.authority);
  const turnBytes = Buffer.from(` ${JSON.stringify(record(s.f.sid))} `);
  const turnOp = await s.intake.prepare({ op: 'post_turn', n: 1, bytes: turnBytes, authority: s.authority,
    conversation_source_id: source.result.data.host_ids.source_id });
  const turn = await s.intake.execute(turnOp, s.authority);
  const fresh = new AeonIntake({ http: s.http, journal: s.journal });
  assert.deepEqual(await fresh.retryOp(sourceOp, s.authority), source.result.data.host_ids);
  assert.deepEqual(await fresh.retryOp(turnOp, s.authority), turn.result.data.host_ids);
  assert.deepEqual(s.requests.filter((r) => r.opKey === sourceOp.op_key).map((r) => r.body), [sourceOp.payload, sourceOp.payload]);
  assert.deepEqual(s.requests.filter((r) => r.opKey === turnOp.op_key).map((r) => r.body), [turnOp.payload, turnOp.payload]);
  await assert.rejects(fresh.execute({ ...turnOp, payload_bytes: Buffer.from(turnOp.payload + ' ') }, s.authority), { code: 'idempotency_conflict' });
});

it('(c) referenced replacement and its predecessor identity survive fresh-adapter retry byte-exact', async (t) => {
  const s = setup(t);
  registerExtensions(s);
  const firstItem = item({ extensions: extensions() });
  await confirm(s, firstItem);
  const firstOp = await s.intake.prepare({ op: 'submit', n: 1, bytes: bytes(snapshot(s.f.sid, [firstItem], { minor: 1 })), authority: s.authority });
  const first = await s.intake.execute(firstOp, s.authority);
  const predecessor = first.snapshot.spec.items[0];
  const nextItem = item({ version: 2, extensions: extensions('"'), supersedes_item_version: { item_ref: firstItem.item_ref, version: 1 } });
  await confirm(s, nextItem);
  const input = Buffer.from(`\n${JSON.stringify(snapshot(s.f.sid, [{ ...predecessor, state: 'superseded' }, nextItem], { minor: 1 }), null, 2)}\n`);
  const op = await s.intake.prepare({ op: 'replace', n: 1, bytes: input, authority: s.authority,
    supersedes_draft_id: predecessor.host.draft_id });
  const result = await s.intake.execute(op, s.authority);
  const fresh = new AeonIntake({ http: s.http, journal: s.journal, supportsReplace: true });
  assert.deepEqual(await fresh.retryOp(op, s.authority), result.result.data.host_ids);
  assert.equal(result.supersedes_draft_id, predecessor.host.draft_id);
  assert.deepEqual(s.requests.filter((r) => r.opKey === op.op_key).map((r) => r.body), [op.payload, op.payload]);
});

it('(a,c) SQLite content addresses and referenced pending snapshots survive close/reopen', async (t) => {
  const s = setup(t, 'sqlite');
  const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
  await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
  const reopened = new SqliteJournal(s.path, { now: () => s.f.now() * 1000 });
  t.after(() => reopened.close());
  const [content] = reopened.recordsByDigests([pendingContentReference(op.payload).sha256], s.authority);
  assert.equal(content.document.seq, pendingContentReference(op.payload).record_seq);
  const closure = await hydrateSnapshot(reopened, reopened.cursor(s.authority).snapshot, s.authority);
  assert.deepEqual(closure.get(content.document.seq).bytes, content.bytes);
});

for (const change of ['offset', 'total', 'chunk']) {
  it(`(c) chunked content reads refuse altered ${change} before any intake request`, async (t) => {
    let tamper = false;
    const s = setup(t, 'mock', (response, request) => {
      if (tamper && request.path.includes('offset=')) {
        if (change === 'offset') response.body.offset++;
        if (change === 'total') response.body.total++;
        if (change === 'chunk') response.body.chunk = response.body.chunk.slice(0, -4);
      }
      return response;
    });
    const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
    tamper = true;
    await assert.rejects(s.intake.execute(op, s.authority), { status: 502 });
    assert.equal(s.requests.some((r) => r.opKey), false);
  });
}

it('(c) resume refuses a missing closure record before invoking any retry callback', async (t) => {
  const s = setup(t, 'sqlite');
  const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
  const saved = await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
  await assert.rejects(hydrateSnapshot({ recordsByIds: () => [] }, saved, s.authority), invalid);
  let retries = 0;
  const port = { takeover: (...a) => s.journal.takeover(...a), append: (...a) => s.journal.append(...a),
    recordsAfter: (...a) => s.journal.recordsAfter(...a), recordsByIds: () => [] };
  await assert.rejects(new JournalClient({ port, authority: s.authority, now: () => s.f.now() * 1000 })
    .resume({ retryOp: () => { retries++; return {}; } }), invalid);
  assert.equal(retries, 0);
});

it('(c) tampered hydrated bytes and projection cannot replace the pinned content digest', async (t) => {
  const s = setup(t, 'sqlite');
  const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
  const saved = await s.journal.append(bytes(pendingSnapshot(s, [op])), s.authority);
  const other = contentRecord(s, canonicalJson({ document_bytes: '{}', metadata: {} }));
  const forged = { bytes: bytes(other), document: { ...other, seq: pendingContentReference(op.payload).record_seq } };
  await assert.rejects(hydrateSnapshot({ recordsByIds: () => [forged] }, saved, s.authority), invalid);
  await assert.rejects(s.intake.execute({ ...op, content_record: forged }, s.authority), invalid);
});

it('(a,c) interrupted chunk uploads are invisible to the journal and restart cleanly', async (t) => {
  let crash = true;
  const s = setup(t, 'mock', (response, request) => {
    if (crash && request.path.includes('upload=')) throw new Error('synthetic interrupted upload');
    return response;
  });
  const content = contentRecord(s, canonicalJson({ document_bytes: 'a'.repeat(1024 * 1024), metadata: {} }));
  await assert.rejects(s.journal.append(bytes(content), s.authority), { status: 503 });
  assert.equal((await s.journal.cursor(s.authority)).last_seq, 0);
  assert.deepEqual(await s.journal.recordsByDigests([content.data.sha256], s.authority), []);
  crash = false;
  const stored = await s.journal.append(bytes(content), s.authority);
  assert.equal(stored.document.seq, 1);
  assert.deepEqual(stored.bytes, bytes(content));
  assert.ok(s.requests.every((r) => Buffer.byteLength(r.body ?? '') <= 1024 * 1024));
});

it('(a,c) chunk uploads reject tampering, missing ranges and stale authority before commit', async (t) => {
  const s = setup(t, 'mock');
  const original = bytes(contentRecord(s, canonicalJson({ document_bytes: 'a'.repeat(1024 * 1024), metadata: {} })));
  const digest = sha256Hex(original.toString());
  const send = (offset, overrides = {}, token) => s.f.request('journal', 'records', canonicalJson({ offset,
    total: original.length, chunk: original.subarray(offset, offset + journalChunkBytes).toString('base64'), ...overrides }),
  { path: `/journal/sessions/${s.f.sid}/records?upload=${digest}&ack=seq`, ...(token === undefined ? {} : { token }) });
  assert.equal(send(journalChunkBytes).status, 400, 'later ranges require the earlier bytes');
  assert.equal(send(0, { chunk: '' }).status, 400);
  assert.equal(send(0, { total: Number.MAX_SAFE_INTEGER + 1 }).status, 400);
  assert.equal(send(0, { extra: true }).status, 400);
  assert.equal(send(0).body.offset, journalChunkBytes);
  assert.equal(send(journalChunkBytes, { total: original.length + 1 }).status, 400);
  assert.equal((await s.journal.cursor(s.authority)).last_seq, 0);
  assert.equal(send(0, { chunk: Buffer.alloc(journalChunkBytes, 97).toString('base64') }).status, 200);
  let final;
  for (let offset = journalChunkBytes; offset < original.length; offset += journalChunkBytes) final = send(offset);
  assert.equal(final.body.code, 'idempotency_conflict', 'the complete wire digest must match');
  assert.equal((await s.journal.cursor(s.authority)).last_seq, 0);
  assert.equal(send(0).status, 200);
  s.f.host.takeover(s.f.sid);
  assert.equal(send(journalChunkBytes).body.code, 'fenced_generation');
  assert.equal(send(journalChunkBytes, {}, s.f.token({ gen: 2 })).status, 400, 'takeover discards unfinished staging');
});

it('(a,c) invalid intermediate upload acknowledgements cannot return a pending manifest', async (t) => {
  const s = setup(t, 'mock', (response, request) => {
    if (request.path.includes('upload=')) response.body.offset++;
    return response;
  });
  const large = contentRecord(s, canonicalJson({ document_bytes: 'a'.repeat(1024 * 1024), metadata: {} }));
  await assert.rejects(s.journal.append(bytes(large), s.authority), { status: 502 });
  assert.equal((await s.journal.cursor(s.authority)).last_seq, 0);
});

it('(c) host-side reference resolution refuses missing content, tampered digests and replaced metadata', async (t) => {
  const s = setup(t, 'mock');
  const op = await s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')), authority: s.authority });
  const ref = pendingContentReference(op.payload);
  const send = (body, overrides = {}) => s.f.request('intake', 'sources', body,
    { path: `/intake/sessions/${s.f.sid}/sources?content=reference`, opKey: op.op_key, ...overrides });
  for (const patch of [{ record_seq: 999 }, { sha256: '0'.repeat(64) }, { size: ref.size + 1 }]) {
    assert.equal(send(canonicalJson({ ...ref, ...patch })).body.code, 'citation_invalid');
  }
  assert.equal(send(op.payload, { intakeMetadata: Buffer.from(canonicalJson({ conversation_source_id: s.f.sid })).toString('base64url') })
    .body.code, 'idempotency_conflict');
  assert.equal((await s.journal.cursor(s.authority)).last_seq, ref.record_seq, 'refusal creates no source');
  assert.equal(send(op.payload, { token: s.f.token({ capabilities: ['aithema.journal.read'] }) }).status, 403);
  const result = await s.intake.execute(op, s.authority);
  const sendRequest = s.requests.find((r) => r.opKey === op.op_key);
  assert.equal(sendRequest.intakeMetadata, undefined, 'metadata comes from pinned content rather than a header');
  assert.ok(result.result.data.host_ids.source_id);
});

it('(a) projection transport deduplicates identical content with distinct outer event bytes', async (t) => {
  const s = setup(t, 'mock');
  const projection = new AeonJournal({ http: s.http, recordFormat: 'projection' });
  const canonical = canonicalJson({ document_bytes: '{}', metadata: {} });
  const first = await projection.append(bytes(contentRecord(s, canonical)), s.authority);
  const second = await projection.append(bytes(contentRecord(s, canonical)), s.authority);
  assert.equal(second.document.seq, first.document.seq);
  assert.equal(second.document.data.canonical, canonical);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.bytes_origin, 'projection');
});

it('(a,c) mutation proof: removing the await at content append makes the write-ahead regression red', () => {
  const sourcePath = fileURLToPath(new URL('../runtime/hosts/aeon/intake.js', import.meta.url));
  const original = readFileSync(sourcePath, 'utf8').replace(/from '(\.[^']+)'/g,
    (_, specifier) => `from '${pathToFileURL(resolve(dirname(sourcePath), specifier)).href}'`);
  assert.ok(original.includes('prior[0] ?? await this.#journal.append('));
  const probe = `
    import assert from 'node:assert/strict';
    import { canonicalJson } from ${JSON.stringify(new URL('../contracts/validate.js', import.meta.url).href)};
    import { record } from ${JSON.stringify(new URL('./host-kit/fixtures.js', import.meta.url).href)};
    const { AeonIntake } = await import(process.argv[1]);
    const sid = '11111111-1111-4111-8111-111111111111';
    const events = [];
    const journal = { recordsByIds: () => [], recordsByDigests: () => [], async append(bytes) {
      await Promise.resolve();
      events.push('durable content');
      return { bytes: Buffer.from(bytes), document: { ...JSON.parse(bytes), seq: 1 } };
    } };
    const intake = new AeonIntake({ http: { scope: { sid }, request() {} }, journal });
    const op = await intake.prepare({ op: 'post_source', n: 1, bytes: canonicalJson(record(sid, 'source')),
      authority: { sid, gen: 1, writer_kind: 'worker' } });
    events.push('pending op returned');
    assert.deepEqual(events, ['durable content', 'pending op returned']);
    assert.equal(op.payload_kind, 'pending_op.content');
  `;
  for (const [source, expected] of [[original, 0], [original.replace('prior[0] ?? await this.#journal.append(', 'prior[0] ?? this.#journal.append('), 1]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, 'data:text/javascript,' + encodeURIComponent(source)],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expected, result.stderr);
  }
});
