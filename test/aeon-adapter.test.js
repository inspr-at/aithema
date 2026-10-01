import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { canonicalJson, loadContractFile, sha256Hex, validate } from '../contracts/validate.js';
import { JournalClient, reopenDesign } from '../runtime/journal/index.js';
import { AeonError, AeonHttp, AeonIntake, AeonJournal, AeonSessionMonitor,
  INTAKE_POLL_MS, checkHostEvent, createHostEventHandler } from '../runtime/hosts/aeon/index.js';
import { serveHost, routePath } from './host-kit/index.js';
import { fixture, item, record, snapshot, validDocuments } from './host-kit/fixtures.js';
import { errorResponse, HostError } from './host-kit/protocol.js';

const bytes = (doc) => Buffer.from(canonicalJson(doc), 'utf8');
const code = (value, status = 409) => (error) => error.code === value && error.status === status;
const catalogue = loadContractFile('error-codes.json').codes;

async function setup(t, { transform, recordFormat = 'projection', credentialCaps, timeoutMs, fetchImpl } = {}) {
  const f = fixture();
  const requests = [];
  const serverHost = { request(request) {
    requests.push({ ...request });
    const response = f.host.request(request);
    return transform ? transform(response, request, f) : response;
  } };
  const server = await serveHost(serverHost);
  t.after(() => server.close());
  let liveGrant = f.liveGrant;
  const authority = { sid: f.sid, tid: 'tenant-1', pid: 'project-1', gen: 1, auth_epoch: 1,
    writer_kind: 'worker', capabilities: [...loadContractFile('capabilities.json').delegated_allowed], exp: f.now() + 900 };
  const http = new AeonHttp({ baseUrl: server.url, scope: authority, timeoutMs, fetchImpl,
    credentials: (a) => ({ token: f.token({ gen: a.gen, auth_epoch: a.auth_epoch,
      ...(credentialCaps ? { capabilities: credentialCaps } : {}) }), liveGrant }) });
  const journal = new AeonJournal({ http, recordFormat, takeoverAuthority: (a) => {
    const gen = f.host.takeover(f.sid);
    liveGrant = f.host.liveGrant(f.sid);
    return { ...a, gen };
  } });
  const intake = new AeonIntake({ http, supportsReplace: true });
  return { f, requests, http, journal, intake, authority, url: server.url };
}

async function confirm(s, candidate) {
  return s.journal.append(bytes(record(s.f.sid, 'ui.confirm', {
    item_ref: candidate.item_ref, version: candidate.version,
    content_sha256: candidate.content_sha256, principal_ref: 'person-1',
  }, { writer: { kind: 'worker', generation: s.authority.gen } })), s.authority);
}

async function submit(s, candidate = item(), n = 1, context) {
  await confirm(s, candidate);
  const doc = snapshot(s.f.sid, [candidate], { worker_generation: s.authority.gen });
  const op = s.intake.prepare({ op: 'submit', n, bytes: bytes(doc), context });
  const response = await s.intake.execute(op, s.authority);
  return { doc, op, response, id: response.result.data.host_ids.draft_id };
}

async function replacement(s, old, n = 1) {
  const previous = old.response.snapshot.spec.items.find((entry) => entry.host?.draft_id === old.id);
  const content = { ...previous.content, statement: `Replacement ${n}.` };
  const next = item({ item_ref: previous.item_ref, kind: previous.kind, version: previous.version + 1,
    content, content_sha256: sha256Hex(canonicalJson(content)),
    supersedes_item_version: { item_ref: previous.item_ref, version: previous.version } });
  await confirm(s, next);
  const doc = snapshot(s.f.sid, [{ ...previous, state: 'superseded' }, next], { worker_generation: s.authority.gen });
  const op = s.intake.prepare({ op: 'replace', n, bytes: bytes(doc), supersedes_draft_id: old.id });
  return { doc, op, next };
}

async function accept(s, id) {
  // Person-side fixture action; the adapter deliberately has no acceptance API.
  const response = await fetch(`${s.url}${routePath('intake', s.f.sid, 'accept', id)}`, {
    method: 'POST', headers: { cookie: `host_person=${s.f.host.personSession(s.f.sid, 'person-1')}` }, redirect: 'error',
  });
  return { status: response.status, body: await response.json() };
}

it('(a) JournalPort writes routes, preserves exact append bytes, applies CAS and reads bounded replay', async (t) => {
  const s = await setup(t);
  const doc = record(s.f.sid);
  const original = Buffer.from(`\n${JSON.stringify(doc, null, 2)}\n`);
  const appended = await s.journal.append(original, s.authority);
  assert.deepEqual(appended.bytes, original);
  assert.equal(appended.bytes_origin, 'original');
  assert.equal(s.f.host.storedBytes(s.f.sid, doc.client_event_id), original.toString());
  assert.deepEqual(await s.journal.append(original, s.authority), appended);
  await assert.rejects(s.journal.append(Buffer.concat([original, Buffer.from(' ')]), s.authority), code('idempotency_conflict'));
  const saved = await s.journal.append(bytes(snapshot(s.f.sid, [], { consumed_seq: 1 })), s.authority);
  assert.equal(saved.document.seq, 2);
  await assert.rejects(s.journal.append(bytes(snapshot(s.f.sid)), s.authority), { status: 409 });
  await s.journal.append(bytes(record(s.f.sid, 'op.result')), s.authority);
  const cursor = await s.journal.cursor(s.authority);
  assert.equal(cursor.last_seq, 3);
  assert.equal(cursor.working_rev, 1);
  assert.equal(cursor.worker_generation, 1);
  assert.equal(cursor.auth_epoch, 1);
  assert.equal(cursor.audit_seq, 0);
  assert.equal(cursor.snapshot.document.seq, 2);
  assert.deepEqual((await s.journal.recordsAfter(0, s.authority, 2)).map((r) => r.document.seq), [1, 2]);
  assert.equal((await s.journal.recordsByIds([1], s.authority))[0].bytes_origin, 'projection');
  assert.deepEqual(await s.journal.recordsByIds([], s.authority), []);
  assert.ok(s.requests.some((r) => r.path.endsWith('/snapshots')));
  assert.ok(s.requests.some((r) => r.path.endsWith('/op.result')));
});

it('(a) stored-byte transport validates projections and returns the original bytes after restart', async (t) => {
  const s = await setup(t, { recordFormat: 'stored', transform(response, request, f) {
    if (!request.path.startsWith('/journal/') || response.status !== 200 || request.path.endsWith('/authority')) return response;
    const stored = (doc) => ({ document: doc, bytes: f.host.storedBytes(f.sid, doc.client_event_id) });
    if (Array.isArray(response.body)) response.body = response.body.map(stored);
    else if (response.body.contract) response.body = stored(response.body);
    else if (response.body.snapshot) response.body.snapshot = stored(response.body.snapshot);
    return response;
  } });
  const doc = record(s.f.sid);
  const original = Buffer.from(`\n${JSON.stringify(doc, null, 2)}\n`);
  await s.journal.append(original, s.authority);
  const hydrated = await s.journal.recordsByIds([1], s.authority);
  assert.deepEqual(hydrated[0].bytes, original);
  assert.equal(hydrated[0].bytes_origin, 'original');
});

it('(a,d) resume hydrates sources, cited earlier turns, summary leaves and immutable design inputs outside replay', async (t) => {
  const s = await setup(t);
  const docs = [record(s.f.sid), record(s.f.sid, 'source'), record(s.f.sid), record(s.f.sid, 'design.input')];
  for (const doc of docs) await s.journal.append(bytes(doc), s.authority);
  const candidate = item({ state: 'draft', citations: [{ record_seq: 1, locator: 'turn:0', quote: 'synthetic' },
    { record_seq: 2, locator: 'seg:s1', quote: 'Synthetic' }], provenance: { intent: 'requested', derived_from: [1, 2, 3] } });
  const saved = snapshot(s.f.sid, [candidate], { consumed_seq: 4,
    spec: { items: [candidate], questions: [], brief: null, screens: [{ screen_ref: 'test-screen', design_input_seq: 4 }] } });
  await s.journal.append(bytes(saved), s.authority);
  await s.journal.append(bytes(record(s.f.sid)), s.authority);
  const resumed = await new JournalClient({ port: s.journal, authority: s.authority }).resume();
  assert.equal(resumed.cursor.worker_generation, 2);
  assert.deepEqual([...resumed.closure.keys()], [1, 2, 3, 4]);
  assert.deepEqual(resumed.replay.map((r) => r.document.seq), [6]);
  assert.ok(s.requests.some((r) => r.path.endsWith('records?ids=1%2C2%2C3')));
  assert.ok(s.requests.some((r) => r.path.endsWith('records?ids=4')));
  const rendering = await reopenDesign(resumed.snapshot, resumed.closure, 'test-screen', (input) => {
    assert.deepEqual(input.record_bytes, bytes(docs[3]));
    return Buffer.concat([input.screen_ir_bytes, input.tokens_bytes]);
  });
  assert.deepEqual(rendering, Buffer.concat([Buffer.from(canonicalJson(docs[3].data.screen_ir)), Buffer.from(canonicalJson(docs[3].data.tokens))]));
  validDocuments(resumed.snapshot);
});

it('(a) large records-by-ids closures use bounded batches and require every requested record', async (t) => {
  const s = await setup(t);
  for (let n = 0; n < 101; n++) assert.equal(s.f.request('journal', 'records', record(s.f.sid)).status, 200);
  const ids = Array.from({ length: 101 }, (_, n) => n + 1);
  assert.equal((await s.journal.recordsByIds(ids, s.authority)).length, 101);
  assert.equal(s.requests.filter((r) => r.path.includes('?ids=')).length, 34);
  await assert.rejects(s.journal.recordsByIds([102], s.authority), code('citation_invalid', 422));
  for (const bad of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [1, 1], ['1']]) {
    await assert.rejects(s.journal.recordsByIds(bad, s.authority), { status: 400 });
  }
});

for (const [name, change] of [
  ['missing source segment', (i) => { i.citations[0].locator = 'seg:missing'; }],
  ['invented quotation', (i) => { i.citations[0].quote = 'fabricated'; }],
  ['assistant citation', (i) => { i.citations[0] = { record_seq: 2, locator: 'turn:0' }; }],
  ['assistant summary leaf', (i) => { i.provenance.derived_from = [2]; }],
]) {
  it(`(a,d) closure validation refuses ${name} before any intake retry`, async (t) => {
    const s = await setup(t);
    await s.journal.append(bytes(record(s.f.sid, 'source')), s.authority);
    await s.journal.append(bytes(record(s.f.sid, 'turn', { ...record(s.f.sid).data, speaker: 'assistant', trust: 'assistant' })), s.authority);
    const i = item({ citations: [{ record_seq: 1, locator: 'seg:s1' }], provenance: { intent: 'inferred', derived_from: [1] } });
    change(i);
    const pending = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')) });
    await s.journal.append(bytes(snapshot(s.f.sid, [i], { consumed_seq: 2, pending_ops: [pending] })), s.authority);
    let retries = 0;
    await assert.rejects(new JournalClient({ port: s.journal, authority: s.authority }).resume({ retryOp() { retries++; } }), code('citation_invalid', 422));
    assert.equal(retries, 0);
  });
}

it('(b) per-operation keys preserve source/turn bytes and project host source IDs, ordinals and upload segments', async (t) => {
  const s = await setup(t);
  const sourceDoc = record(s.f.sid, 'source');
  const sourceBytes = Buffer.from(`\n${JSON.stringify(sourceDoc, null, 2)}\n`);
  const sourceOp = s.intake.prepare({ op: 'post_source', n: 7, bytes: sourceBytes });
  const source = await s.intake.execute(sourceOp, s.authority);
  const sourceId = source.result.data.host_ids.source_id;
  assert.deepEqual(await s.intake.execute(structuredClone(sourceOp), s.authority), source);
  const turnDoc = record(s.f.sid);
  const turnOp = s.intake.prepare({ op: 'post_turn', n: 7, bytes: bytes(turnDoc), conversation_source_id: sourceId });
  const turn = await s.intake.execute(turnOp, s.authority);
  assert.equal(sourceOp.op_key, `${s.f.sid}:source:7`);
  assert.equal(turnOp.op_key, `${s.f.sid}:turn:7`);
  assert.equal(s.f.host.storedBytes(s.f.sid, sourceDoc.client_event_id), sourceBytes.toString());
  const candidate = item({ citations: [{ record_seq: source.record.seq, locator: 'seg:s1', quote: 'Synthetic' },
    { record_seq: turn.record.seq, locator: 'turn:0', quote: 'export' }],
    provenance: { intent: 'requested', derived_from: [source.record.seq, turn.record.seq] } });
  const context = { sid: s.f.sid, records: [source.record, turn.record], turnOrdinals: new Map([[turn.record.seq, 0]]) };
  const submitted = await submit(s, candidate, 7, context);
  const payload = JSON.parse(submitted.op.payload);
  assert.deepEqual(payload.metadata.citations, [{ source_id: sourceId, locator: 'seg:s1', quote: 'Synthetic' },
    { source_id: sourceId, turn_id: turn.result.data.host_ids.turn_id, locator: 'turn:0', quote: 'export' }]);
  assert.equal(submitted.op.payload_sha256, sha256Hex(submitted.op.payload));
  assert.equal(validate('aithema.spec.snapshot', snapshot(s.f.sid, [], { pending_ops: [submitted.op] })).ok, true);
  assert.equal(JSON.stringify(payload).includes('target_node_id'), false);
  assert.equal(submitted.response.snapshot.spec.items[0].state, 'proposed');
  const snapshotResult = await s.intake.snapshot(s.authority);
  assert.equal(snapshotResult.sources.length, 1);
  assert.equal(snapshotResult.turns.length, 1);
  validDocuments(snapshotResult);
});

it('(b) host-only metadata carries brief mapping and supersedes_draft_id on the actual HTTP request', async (t) => {
  const seen = [];
  const fetchImpl = (url, init) => {
    seen.push({ path: new URL(url).pathname, body: init.body?.toString(), headers: { ...init.headers } });
    return fetch(url, init);
  };
  const s = await setup(t, { fetchImpl });
  const old = await submit(s, item({ kind: 'constraint' }));
  assert.equal(JSON.parse(old.op.payload).metadata.kind, 'brief');
  const next = await replacement(s, old);
  const replaced = await s.intake.execute(next.op, s.authority);
  const request = seen.find((r) => r.path.endsWith('/replace'));
  const metadata = JSON.parse(Buffer.from(request.headers['x-aithema-intake'], 'base64url'));
  assert.equal(metadata.supersedes_draft_id, old.id);
  assert.equal(request.headers['x-supersedes-draft-id'], old.id);
  assert.equal(request.headers['idempotency-key'], next.op.op_key);
  assert.deepEqual(Buffer.from(request.body), bytes(next.doc));
  assert.equal(request.body.includes('target_node_id'), false);
  assert.deepEqual(replaced.snapshot.spec.items.map((i) => i.state), ['superseded', 'proposed']);
});

for (const operation of ['submit', 'replace']) {
  for (const [name, change] of [
    ['foreign source id', (m) => { m.citations[0].source_id = randomUUID(); }],
    ['foreign turn id', (m) => { m.citations[1].turn_id = randomUUID(); }],
    ['wrong locator', (m) => { m.citations[0].locator = 'seg:missing'; }],
    ['wrong quote', (m) => { m.citations[1].quote = 'Invented quotation'; }],
    ['omitted citation', (m) => { m.citations.pop(); }],
    ['duplicate citation', (m) => { m.citations.push(m.citations[0]); }],
    ['hidden citation field', (m) => { m.citations[0].target_node_id = randomUUID(); }],
  ]) {
    it(`(b,d) ${operation} validates ${name} in the actual host metadata before creating a draft`, async (t) => {
      let tamper = false;
      const s = await setup(t, { fetchImpl(url, init) {
        if (tamper && init.headers['x-aithema-intake']) {
          const metadata = JSON.parse(Buffer.from(init.headers['x-aithema-intake'], 'base64url'));
          change(metadata);
          init = { ...init, headers: { ...init.headers,
            'x-aithema-intake': Buffer.from(canonicalJson(metadata)).toString('base64url') } };
        }
        return fetch(url, init);
      } });
      const source = await s.intake.execute(s.intake.prepare({ op: 'post_source', n: 1,
        bytes: bytes(record(s.f.sid, 'source')) }), s.authority);
      const turn = await s.intake.execute(s.intake.prepare({ op: 'post_turn', n: 1,
        bytes: bytes(record(s.f.sid)), conversation_source_id: source.result.data.host_ids.source_id }), s.authority);
      const citations = [{ record_seq: source.record.seq, locator: 'seg:s1', quote: 'Synthetic' },
        { record_seq: turn.record.seq, locator: 'turn:0', quote: 'export' }];
      const provenance = { intent: 'requested', derived_from: [source.record.seq, turn.record.seq] };
      const context = { sid: s.f.sid, records: [source.record, turn.record], turnOrdinals: new Map([[turn.record.seq, 0]]) };
      let op;
      if (operation === 'replace') {
        const old = await submit(s);
        const next = await replacement(s, old);
        Object.assign(next.doc.spec.items.at(-1), { citations, provenance });
        op = s.intake.prepare({ op: operation, n: 1, bytes: bytes(next.doc), supersedes_draft_id: old.id, context });
      } else {
        const candidate = item({ citations, provenance });
        await confirm(s, candidate);
        op = s.intake.prepare({ op: operation, n: 1, bytes: bytes(snapshot(s.f.sid, [candidate])), context });
      }
      const before = await s.intake.snapshot(s.authority);
      tamper = true;
      await assert.rejects(s.intake.execute(op, s.authority), code('citation_invalid', 422));
      tamper = false;
      assert.deepEqual(await s.intake.snapshot(s.authority), before);
      assert.ok((await s.intake.execute(op, s.authority)).result.data.host_ids.draft_id,
        'refused metadata never reserves the operation key or supersedes the old draft');
    });
  }
}

it('(a,b,d) acknowledged operation with missing op.result retries byte-exact after takeover and journals its original IDs', async (t) => {
  const s = await setup(t);
  const original = Buffer.from(`\n${JSON.stringify(record(s.f.sid, 'source'), null, 2)}\n`);
  const op = s.intake.prepare({ op: 'post_source', n: 1, bytes: original });
  const acknowledged = await s.intake.execute(op, s.authority);
  await s.journal.append(bytes(snapshot(s.f.sid, [], { consumed_seq: 1, pending_ops: [op] })), s.authority);
  // A new adapter has no source mapping cache; the durable payload is sufficient.
  const restartedIntake = new AeonIntake({ http: s.http });
  const client = new JournalClient({ port: s.journal, authority: s.authority });
  const resumed = await client.resume({ retryOp: restartedIntake.retryOp.bind(restartedIntake) });
  assert.equal(client.authority.gen, 2);
  assert.deepEqual(resumed.completedOps.get(op.op_key), acknowledged.result.data.host_ids);
  assert.deepEqual(s.requests.filter((r) => r.path.endsWith('/sources')).map((r) => r.body), [original.toString(), original.toString()]);
  assert.equal(s.f.request('intake', '', undefined, { token: s.f.token({ gen: 2 }) }).body.sources.length, 1);
  const results = (await s.journal.recordsAfter(2, client.authority)).filter((r) => r.document.kind === 'op.result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].document.data.host_ids, acknowledged.result.data.host_ids);
});

it('(b,d) source and draft payload byte changes under the same operation key surface idempotency_conflict', async (t) => {
  const s = await setup(t);
  const doc = record(s.f.sid, 'source');
  const op = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(doc) });
  await s.intake.execute(op, s.authority);
  const changed = s.intake.prepare({ op: 'post_source', n: 1, bytes: `${canonicalJson(doc)}\n` });
  await assert.rejects(s.intake.execute(changed, s.authority), code('idempotency_conflict'));
  const submitted = await submit(s);
  const changedDraft = s.intake.prepare({ op: 'submit', n: 1, bytes: `${canonicalJson(submitted.doc)}\n` });
  await assert.rejects(s.intake.execute(changedDraft, s.authority), code('idempotency_conflict'));
});

for (const operation of ['post_source', 'post_turn', 'submit', 'replace']) {
  for (const boundary of ['never-sent', 'lost-ack']) {
    it(`(a,b,d) ${boundary} ${operation} retries its original document and metadata after takeover`, async (t) => {
      let loseAck = false;
      let originalIds;
      const s = await setup(t, { transform(response) {
        if (loseAck && response.status === 200) {
          loseAck = false;
          originalIds = response.body.result.data.host_ids;
          return { status: 503, body: { message: 'Synthetic lost acknowledgement' } };
        }
        return response;
      } });
      let op;
      if (operation === 'replace') op = (await replacement(s, await submit(s))).op;
      else if (operation === 'submit') {
        await confirm(s, item());
        op = s.intake.prepare({ op: operation, n: 1, bytes: bytes(snapshot(s.f.sid, [item()])) });
      } else {
        let conversation_source_id;
        if (operation === 'post_turn') {
          const source = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')) });
          conversation_source_id = (await s.intake.execute(source, s.authority)).result.data.host_ids.source_id;
        }
        const doc = record(s.f.sid, operation === 'post_source' ? 'source' : 'turn');
        op = s.intake.prepare({ op: operation, n: 2, bytes: `\n${JSON.stringify(doc, null, 2)}\n`, conversation_source_id });
      }
      const seq = (await s.journal.cursor(s.authority)).last_seq;
      await s.journal.append(bytes(snapshot(s.f.sid, [], { consumed_seq: seq, pending_ops: [op] })), s.authority);
      if (boundary === 'lost-ack') {
        loseAck = true;
        await assert.rejects(s.intake.execute(op, s.authority), { status: 503 });
      }
      const restarted = new AeonIntake({ http: s.http, supportsReplace: true });
      const client = new JournalClient({ port: s.journal, authority: s.authority });
      const resumed = await client.resume({ retryOp: restarted.retryOp.bind(restarted) });
      assert.equal(client.authority.gen, 2);
      const receipt = resumed.completedOps.get(op.op_key);
      assert.ok(receipt);
      if (originalIds) assert.deepEqual(receipt, originalIds);
      const sent = s.requests.filter((r) => r.opKey === op.op_key);
      assert.equal(sent.length, boundary === 'never-sent' ? 1 : 2);
      for (const request of sent) {
        assert.equal(request.body, JSON.parse(op.payload).document_bytes);
        assert.equal(request.intakeMetadata, Buffer.from(canonicalJson(JSON.parse(op.payload).metadata)).toString('base64url'));
      }
      assert.deepEqual(resumed.snapshot.pending_ops, [op], 'the saved envelope is never rewritten during takeover');
      const results = (await s.journal.recordsAfter(0, client.authority)).filter((r) =>
        r.document.kind === 'op.result' && r.document.data.op_key === op.op_key);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0].document.data.host_ids, receipt);
    });
  }
}

for (const [kind, data, writer] of [
  ['turn', null, 'browser'],
  ['reaction', { turn_seq: 1, text: 'Synthetic answer.', delivered_prefix: '', certainty: 'uncertain', complete: false }, 'browser'],
  ['session.control', { action: 'suspend' }, 'host'],
  ['session.end', { reason: 'person', host_mode: 'review', export: 'offered' }, 'host'],
]) {
  it(`(a) rejects ${writer}-authored ${kind} before any delegated journal request`, async (t) => {
    const s = await setup(t);
    const doc = record(s.f.sid, kind, data, { writer: { kind: writer } });
    assert.equal(validate(doc.contract, doc).ok, true);
    await assert.rejects(s.journal.append(bytes(doc), s.authority), { status: 403 });
    assert.equal(s.requests.length, 0);
    assert.equal(s.f.request('journal', 'cursor').body.seq, 0);
  });
}

for (const entry of ['prepare', 'execute']) {
  it(`(b) ${entry} rejects two confirmed candidates before HTTP`, async (t) => {
    const s = await setup(t);
    const doc = snapshot(s.f.sid, [item(), item({ item_ref: 'REQ-2' })]);
    assert.equal(validate(doc.contract, doc).ok, true);
    const payload = canonicalJson({ document_bytes: bytes(doc).toString(),
      metadata: { kind: 'requirement', citations: [], supersedes_draft_id: null } });
    if (entry === 'prepare') assert.throws(() => s.intake.prepare({ op: 'submit', n: 1, bytes: bytes(doc) }), { status: 400 });
    else await assert.rejects(s.intake.execute({ op: 'submit', op_key: `${s.f.sid}:submit:1`, payload,
      payload_sha256: sha256Hex(payload) }, s.authority), { status: 400 });
    assert.equal(s.requests.length, 0);
  });
}

it('(b) refuses replacement without an explicit host feature declaration before sending HTTP', async (t) => {
  const s = await setup(t);
  const next = await replacement(s, await submit(s));
  const unsupported = new AeonIntake({ http: s.http });
  const count = s.requests.length;
  assert.throws(() => unsupported.prepare({ op: 'replace', n: 1, bytes: bytes(next.doc),
    supersedes_draft_id: JSON.parse(next.op.payload).metadata.supersedes_draft_id }), { status: 501 });
  await assert.rejects(unsupported.execute(next.op, s.authority), { status: 501 });
  assert.equal(s.requests.length, count);
});

it('(d) simultaneous replace/replace and accept/replace HTTP races have one atomic winner', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const one = await replacement(s, old, 1);
  const two = await replacement(s, old, 2);
  const results = await Promise.allSettled([s.intake.execute(one.op, s.authority), s.intake.execute(two.op, s.authority)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'draft_superseded');
  assert.deepEqual((await s.intake.snapshot(s.authority)).snapshot.spec.items.map((i) => i.state), ['superseded', 'proposed']);
  const other = await setup(t);
  const predecessor = await submit(other);
  const next = await replacement(other, predecessor);
  const [replaceResult, acceptResult] = await Promise.allSettled([
    other.intake.execute(next.op, other.authority), accept(other, predecessor.id),
  ]);
  assert.equal(acceptResult.status, 'fulfilled');
  if (replaceResult.status === 'fulfilled') {
    assert.equal(acceptResult.value.body.code, 'draft_superseded');
    assert.deepEqual((await other.intake.snapshot(other.authority)).snapshot.spec.items.map((i) => i.state), ['superseded', 'proposed']);
  } else {
    assert.equal(replaceResult.reason.code, 'already_accepted');
    assert.equal(acceptResult.value.status, 200);
    assert.deepEqual((await other.intake.snapshot(other.authority)).snapshot.spec.items.map((i) => i.state), ['accepted']);
  }
});

it('(d) accept wins atomically; replacement is refused with already_accepted and the item remains terminal', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const next = await replacement(s, old);
  assert.equal((await accept(s, old.id)).status, 200);
  await assert.rejects(s.intake.execute(next.op, s.authority), code('already_accepted'));
  assert.deepEqual((await s.intake.snapshot(s.authority)).snapshot.spec.items.map((i) => i.state), ['accepted']);
  assert.equal(typeof s.intake.accept, 'undefined');
});

it('(d) replace wins atomically; stale acceptance and competing replacement return draft_superseded', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const first = await replacement(s, old, 1);
  const competing = await replacement(s, old, 2);
  const result = await s.intake.execute(first.op, s.authority);
  assert.deepEqual(await s.intake.execute(first.op, s.authority), result);
  const stale = await accept(s, old.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'draft_superseded');
  await assert.rejects(s.intake.execute(competing.op, s.authority), code('draft_superseded'));
  assert.equal((await accept(s, result.result.data.host_ids.draft_id)).status, 200);
  assert.deepEqual(await s.intake.execute(first.op, s.authority), result, 'exact retry returns the original result after later acceptance');
  assert.deepEqual((await s.intake.snapshot(s.authority)).snapshot.spec.items.map((i) => i.state), ['superseded', 'accepted']);
});

for (const operation of ['post_source', 'post_turn', 'submit', 'replace', 'journal']) {
  it(`(d) host enforces fenced_generation on ${operation}, including already acknowledged retries`, async (t) => {
    const s = await setup(t);
    let op;
    let doc;
    if (operation === 'journal') {
      doc = bytes(record(s.f.sid));
      await s.journal.append(doc, s.authority);
    } else if (operation === 'submit') op = (await submit(s)).op;
    else if (operation === 'replace') {
      op = (await replacement(s, await submit(s))).op;
      await s.intake.execute(op, s.authority);
    } else {
      let sourceId;
      if (operation === 'post_turn') {
        const sourceOp = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')) });
        sourceId = (await s.intake.execute(sourceOp, s.authority)).result.data.host_ids.source_id;
      }
      op = s.intake.prepare({ op: operation, n: 1, bytes: bytes(record(s.f.sid, operation === 'post_source' ? 'source' : 'turn')),
        ...(operation === 'post_turn' ? { conversation_source_id: sourceId } : {}) });
      await s.intake.execute(op, s.authority);
    }
    s.f.host.takeover(s.f.sid);
    await assert.rejects(operation === 'journal' ? s.journal.append(doc, s.authority) : s.intake.execute(op, s.authority), code('fenced_generation'));
  });
}

it('(d) revoked epoch fences journal, intake writes and polling; authority remains readable for fail-closed lifecycle', async (t) => {
  const s = await setup(t);
  const op = s.intake.prepare({ op: 'post_source', n: 1, bytes: bytes(record(s.f.sid, 'source')) });
  await s.intake.execute(op, s.authority);
  s.f.host.revoke(s.f.sid);
  for (const work of [() => s.intake.execute(op, s.authority), () => s.intake.snapshot(s.authority),
    () => s.journal.append(bytes(record(s.f.sid)), s.authority), () => s.journal.recordsAfter(0, s.authority)]) {
    await assert.rejects(work(), code('revoked'));
  }
  const authority = await s.journal.authority(s.authority);
  assert.equal(authority.auth_epoch, 2);
  assert.equal(authority.tombstone, true);
});

it('(d) a contract-valid draft whose cited leaf is not in the host journal gets citation_invalid over HTTP', async (t) => {
  const s = await setup(t);
  const source = { ...record(s.f.sid, 'source'), seq: 100 };
  s.intake.bindHostSource(source, { source_id: randomUUID() });
  const i = item({ citations: [{ record_seq: 100, locator: 'seg:s1' }] });
  await confirm(s, i);
  const op = s.intake.prepare({ op: 'submit', n: 1, bytes: bytes(snapshot(s.f.sid, [i])), context: { sid: s.f.sid, records: [source] } });
  await assert.rejects(s.intake.execute(op, s.authority), code('citation_invalid', 422));
});

for (const entry of catalogue) {
  it(`(d) preserves catalogue code ${entry.code}, status and contract-valid error document without retry`, async (t) => {
    const s = await setup(t, { transform(response, request) {
      return request.path.startsWith('/intake/') ? errorResponse(new HostError(entry.http, entry.code, entry.code)) : response;
    } });
    await assert.rejects(s.intake.snapshot(s.authority), (error) => {
      assert.equal(error.code, entry.code);
      assert.equal(error.status, entry.http);
      validDocuments(error.document);
      return true;
    });
    assert.equal(s.requests.length, 1);
  });
}

it('(b) rejects targets, node supersession, mismatched draft IDs, unsafe counters and malformed persisted operations before HTTP', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const next = await replacement(s, old);
  const start = s.requests.length;
  for (const bad of [{ ...next.doc, target_node_id: randomUUID() },
    { ...next.doc, spec: { ...next.doc.spec, items: next.doc.spec.items.map((i) => ({ ...i, target_node_id: randomUUID() })) } }]) {
    assert.throws(() => s.intake.prepare({ op: 'replace', n: 3, bytes: bytes(bad), supersedes_draft_id: old.id }), { status: 400 });
  }
  assert.throws(() => s.intake.prepare({ op: 'replace', n: 3, bytes: bytes(next.doc), supersedes_draft_id: randomUUID() }), { status: 400 });
  for (const n of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => s.intake.prepare({ op: 'submit', n, bytes: bytes(old.doc) }), { status: 400 });
  for (const changed of [{ ...next.op, payload_sha256: sha256Hex('wrong') }, { ...next.op, op_key: `${s.f.sid}:submit:1` },
    { ...next.op, payload_bytes: Buffer.from('changed') }, { ...next.op, extra: true }]) {
    await assert.rejects(s.intake.execute(changed, s.authority));
  }
  const payload = JSON.parse(next.op.payload);
  payload.metadata.target_node_id = randomUUID();
  const altered = canonicalJson(payload);
  await assert.rejects(s.intake.execute({ ...next.op, payload: altered, payload_sha256: sha256Hex(altered) }, s.authority), { status: 400 });
  assert.equal(s.requests.length, start);
});

it('(b) submission requires host source mappings, exact turn ordinals and valid evidence, independently of quoted instructions', async (t) => {
  const s = await setup(t);
  const person = (await s.journal.append(bytes(record(s.f.sid)), s.authority)).document;
  const i = item({ citations: [{ record_seq: person.seq, locator: 'turn:0' }] });
  const doc = bytes(snapshot(s.f.sid, [i]));
  assert.throws(() => s.intake.prepare({ op: 'submit', n: 1, bytes: doc }), code('citation_invalid', 422));
  const context = { sid: s.f.sid, records: [person], turnOrdinals: new Map([[person.seq, 0]]) };
  assert.throws(() => s.intake.prepare({ op: 'submit', n: 1, bytes: doc, context }), code('citation_invalid', 422));
  s.intake.bindHostSource(person, { turn_id: randomUUID() }, { conversationSourceId: randomUUID() });
  assert.throws(() => s.intake.prepare({ op: 'submit', n: 1, bytes: doc, context: { ...context, turnOrdinals: new Map([[person.seq, 1]]) } }), code('citation_invalid', 422));
  const op = s.intake.prepare({ op: 'submit', n: 1, bytes: doc, context });
  await assert.rejects(s.intake.execute(op, s.authority), { status: 403 }, 'a cited person turn never grants full-item UI confirmation');
});

it('(a,c) exact capabilities are required locally and on the mock outer gate; writes never substitute for intake.read', async (t) => {
  const s = await setup(t, { credentialCaps: ['intake.write'] });
  await assert.rejects(s.intake.snapshot(s.authority), { status: 403 });
  const count = s.requests.length;
  for (const authority of [{ ...s.authority, capabilities: ['intake.write'] }, { ...s.authority, sid: randomUUID() },
    { ...s.authority, tid: 'foreign' }, { ...s.authority, pid: 'foreign' }, { ...s.authority, writer_kind: 'host' },
    { ...s.authority, capabilities: [...s.authority.capabilities, 'intake.decide'] }]) {
    await assert.rejects(s.intake.snapshot(authority), { status: 403 });
  }
  assert.equal(s.requests.length, count);
});

it('(a) takeover is an explicit host integration and cannot pretend to bump a generation locally', async (t) => {
  const s = await setup(t);
  await assert.rejects(new AeonJournal({ http: s.http, recordFormat: 'projection' }).takeover(s.authority), { status: 501 });
  await assert.rejects(new AeonJournal({ http: s.http, recordFormat: 'projection', takeoverAuthority: (a) => a }).takeover(s.authority), code('fenced_generation'));
});

for (const [name, change] of [
  ['duplicate', (rows) => [...rows, rows[0]]], ['missing', () => []],
  ['foreign', (rows) => rows.map((row) => ({ ...row, sid: randomUUID() }))],
  ['unexpected', (rows) => rows.map((row) => ({ ...row, seq: 999 }))],
  ['invalid document', (rows) => rows.map((row) => ({ ...row, extra: true }))],
]) {
  it(`(a,d) hydration rejects a ${name} HTTP projection`, async (t) => {
    const s = await setup(t, { transform(response, request) {
      if (request.path.includes('?ids=') && response.status === 200) response.body = change(response.body);
      return response;
    } });
    await s.journal.append(bytes(record(s.f.sid)), s.authority);
    await assert.rejects(s.journal.recordsByIds([1], s.authority));
  });
}

it('(a,d) append rejects changed acknowledgements, unsupported contracts and original-byte omission', async (t) => {
  const s = await setup(t, { transform(response, request) {
    if (request.method === 'POST' && response.status === 200) response.body.data.body = 'Changed by host';
    return response;
  } });
  await assert.rejects(s.journal.append(bytes(record(s.f.sid)), s.authority), code('citation_invalid', 422));
  const tooNew = record(s.f.sid, 'turn', null, { minor: 3, min_reader: 3 });
  await assert.rejects(s.journal.append(bytes(tooNew), s.authority), code('contract_too_new', 422));
  await assert.rejects(new AeonJournal({ http: s.http }).append(bytes(record(s.f.sid)), s.authority));
});

for (const [name, change] of [
  ['result key', (r) => { r.result.data.op_key = `${r.result.sid}:submit:999`; }],
  ['host id type', (r) => { r.result.data.host_ids = { source_id: randomUUID() }; }],
  ['item content', (r) => { r.snapshot.spec.items[0].content.statement = 'Forged'; }],
  ['foreign snapshot', (r) => { r.snapshot.sid = randomUUID(); }],
  ['unexpected supersession', (r) => { r.supersedes_draft_id = randomUUID(); }],
]) {
  it(`(b,d) rejects altered intake ${name} acknowledgement`, async (t) => {
    const s = await setup(t, { transform(response, request) {
      if (request.path.endsWith('/drafts') && response.status === 200) change(response.body);
      return response;
    } });
    await assert.rejects(submit(s), { status: 502 });
  });
}

it('(d) transport preserves ordinary HTTP failures and refuses unknown, wrong-status or success-wrapped codes', async (t) => {
  for (const status of [400, 401, 403, 404, 413, 500, 503]) {
    const s = await setup(t, { transform: () => ({ status, headers: {}, body: { message: 'synthetic refusal' } }) });
    await assert.rejects(s.intake.snapshot(s.authority), (error) => error.status === status && error.code === null);
  }
  for (const [status, body] of [[409, { code: 'invented' }], [422, { code: 'revoked' }], [200, { code: 'revoked' }],
    [409, { code: 'revoked', document: { contract: 'aithema.element.event', major: 1, minor: 0, min_reader: 0 } }]]) {
    const s = await setup(t, { transform: () => ({ status, headers: {}, body }) });
    await assert.rejects(s.intake.snapshot(s.authority), { status: 502 });
  }
});

it('(d) deadlines include credential acquisition and response bodies, cancellation is visible and no retry occurs', async (t) => {
  let fetches = 0;
  let cancelled = false;
  const s = await setup(t, { timeoutMs: 20, fetchImpl: async () => {
    fetches++;
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { status: 200 });
  } });
  await assert.rejects(s.intake.snapshot(s.authority), { status: 504 });
  assert.equal(fetches, 1);
  assert.equal(cancelled, true);
  const http = new AeonHttp({ baseUrl: s.url, scope: s.authority, credentials: () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(new AeonIntake({ http }).snapshot(s.authority), { status: 504 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(s.intake.snapshot(s.authority, { signal: controller.signal }), { status: 499 });
});

it('(d) transport refuses invalid UTF-8/JSON, excessive bodies and unsafe endpoint mounts', async (t) => {
  const s = await setup(t);
  for (const body of ['not JSON', new Uint8Array([0xff]), 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const http = new AeonHttp({ baseUrl: s.url, scope: s.authority,
      credentials: () => ({ token: s.f.token() }), fetchImpl: async () => new Response(body) });
    await assert.rejects(new AeonIntake({ http }).snapshot(s.authority), { status: 502 });
  }
  for (const baseUrl of ['http://remote.example', 'https://user:password@host.example', `${s.url}?query=1`, `${s.url}#fragment`]) {
    assert.throws(() => new AeonHttp({ baseUrl, scope: s.authority, credentials() {} }), TypeError);
  }
  for (const path of ['https://remote.example/path', '../escape', '/outside']) {
    const http = new AeonHttp({ baseUrl: `${s.url}/plugin`, scope: s.authority, credentials() {}, paths: () => path });
    await assert.rejects(new AeonIntake({ http }).snapshot(s.authority), { status: 400 });
  }
  assert.equal(s.requests.length, 0);
});

for (const status of [301, 302, 303, 307, 308]) {
  it(`(d) refuses a real loopback HTTP ${status} redirect without following it`, async (t) => {
    let requests = 0;
    let followed = 0;
    const server = createServer((req, res) => {
      requests++;
      if (req.url === '/redirect') {
        res.writeHead(status, { location: '/destination' });
        res.end();
      } else {
        followed++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sources: [], turns: [], snapshot: null }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const f = fixture();
    const scope = { sid: f.sid, tid: f.authz.tid, pid: f.authz.pid, writer_kind: 'worker', gen: 1, auth_epoch: 1,
      capabilities: ['intake.read'] };
    const http = new AeonHttp({ baseUrl: `http://127.0.0.1:${server.address().port}`, scope,
      credentials: () => ({ token: f.token() }), paths: () => 'redirect' });
    await assert.rejects(new AeonIntake({ http }).snapshot(scope), { status: 503 });
    assert.equal(requests, 1);
    assert.equal(followed, 0);
  });
}

class FakeClock {
  time = 0;
  tasks = new Map();
  next = 1;
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = this.next++; this.tasks.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = (id) => this.tasks.delete(id);
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}

function monitorFor(s, overrides = {}) {
  const clock = new FakeClock();
  const snapshots = [];
  const controls = [];
  const errors = [];
  const monitor = new AeonSessionMonitor({ intake: s.intake, authority: () => s.authority,
    onSnapshot: (value) => snapshots.push(value), onControl: (value) => controls.push(value),
    onError: (error) => errors.push(error), clock, ...overrides });
  return { monitor, clock, snapshots, controls, errors };
}

it('(c) polls intake.read at fixed 30-second deadlines only while active, with no event-stream scope', async (t) => {
  const s = await setup(t);
  const m = monitorFor(s);
  t.after(() => m.monitor.stop());
  assert.equal(INTAKE_POLL_MS, 30_000);
  await m.monitor.start();
  assert.equal(m.snapshots.length, 1);
  m.clock.advance(29_999);
  assert.equal(s.requests.length, 1);
  m.clock.advance(1);
  await m.monitor.refresh();
  assert.equal(m.snapshots.length, 2);
  m.clock.advance(30_000);
  await m.monitor.refresh();
  assert.equal(m.snapshots.length, 3);
  m.monitor.stop();
  m.clock.advance(90_000);
  await m.monitor.refresh();
  assert.equal(m.snapshots.length, 3);
  assert.ok(s.requests.every((r) => r.path === `/intake/sessions/${s.f.sid}`));
});

it('(c,d) callbacks refresh authoritative accepted and superseded outcomes; session_control stops immediately', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const m = monitorFor(s);
  t.after(() => m.monitor.stop());
  await m.monitor.start();
  const next = await replacement(s, old);
  const replaced = await s.intake.execute(next.op, s.authority);
  await m.monitor.hostEvent({ kind: 'draft_superseded', ids: [old.id] });
  assert.deepEqual(m.snapshots.at(-1).snapshot.spec.items.map((i) => i.state), ['superseded', 'proposed']);
  const id = replaced.result.data.host_ids.draft_id;
  await accept(s, id);
  await m.monitor.hostEvent({ kind: 'draft_accepted', ids: [id] });
  assert.equal(m.snapshots.at(-1).snapshot.spec.items.at(-1).state, 'accepted');
  const { control } = s.f.host.revoke(s.f.sid);
  await m.monitor.hostEvent({ kind: 'session_control', ids: [control.seq] });
  assert.equal(m.monitor.active, false);
  assert.deepEqual(m.controls, [{ kind: 'session_control', ids: [control.seq] }]);
  const count = s.requests.length;
  m.clock.advance(60_000);
  assert.equal(s.requests.length, count);
});

it('(c) stops on revoked polling and exposes failures to the embedding application', async (t) => {
  const s = await setup(t);
  const m = monitorFor(s);
  t.after(() => m.monitor.stop());
  await m.monitor.start();
  s.f.host.revoke(s.f.sid);
  await assert.rejects(m.monitor.refresh(), code('revoked'));
  assert.equal(m.monitor.active, false);
  assert.equal(m.snapshots.length, 1);
});

it('(c) callbacks racing a poll perform another read; stop suppresses late responses and cancels the read', async () => {
  let resolve;
  let signal;
  let reads = 0;
  const s = { authority: {}, intake: { snapshot(a, options) {
    reads++;
    signal = options.signal;
    return reads === 1 ? new Promise((r) => { resolve = r; }) : Promise.resolve({ snapshot: null });
  } } };
  const m = monitorFor(s);
  const started = m.monitor.start();
  await Promise.resolve();
  const event = m.monitor.hostEvent({ kind: 'draft_accepted', ids: [randomUUID()] });
  resolve({ snapshot: null });
  await started;
  await event;
  assert.equal(reads, 2);
  assert.equal(m.snapshots.length, 2);
  m.monitor.stop();
  let release;
  const other = monitorFor({ authority: {}, intake: { snapshot(a, options) {
    signal = options.signal;
    return new Promise((r) => { release = r; });
  } } });
  const pending = other.monitor.start();
  await Promise.resolve();
  other.monitor.stop();
  assert.equal(signal.aborted, true);
  release({ snapshot: null });
  assert.equal(await pending, null);
  assert.equal(other.snapshots.length, 0);
});

it('(c) polling rejects backwards revisions and reports timer failures without unhandled rejections', async () => {
  let reads = 0;
  const m = monitorFor({ authority: {}, intake: { snapshot: async () => ({ snapshot: { working_rev: ++reads === 1 ? 2 : 1 } }) } });
  await m.monitor.start();
  m.clock.advance(30_000);
  await assert.rejects(m.monitor.refresh(), { status: 502 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.errors.length, 1);
  assert.equal(m.monitor.lastError.status, 502);
  m.monitor.stop();
});

it('(c) polling stays on deadline while snapshot handlers complete in revision order', async () => {
  let reads = 0;
  let deliveries = 0;
  let release;
  const applied = [];
  const m = monitorFor({ authority: {}, intake: { snapshot: async () => ({ snapshot: { working_rev: ++reads } }) } }, {
    onSnapshot: async (response) => {
      if (++deliveries === 1) await new Promise((resolve) => { release = resolve; });
      applied.push(response.snapshot.working_rev);
    },
  });
  const first = m.monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  m.clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(deliveries, 1);
  assert.deepEqual(applied, []);
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [1, 2]);
  m.monitor.stop();
});

it('(c) failed handlers do not poison the delivery queue; stopping suppresses queued revisions', async () => {
  let reads = 0;
  let release;
  const applied = [];
  const m = monitorFor({ authority: {}, intake: { snapshot: async () => ({ snapshot: { working_rev: ++reads } }) } }, {
    onSnapshot: async (response) => {
      if (response.snapshot.working_rev === 1) throw new Error('Synthetic handler failure');
      if (response.snapshot.working_rev === 2) await new Promise((resolve) => { release = resolve; });
      applied.push(response.snapshot.working_rev);
    },
  });
  await assert.rejects(m.monitor.start(), /Synthetic handler failure/);
  const second = m.monitor.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  m.clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 3);
  assert.deepEqual(applied, []);
  m.monitor.stop();
  release();
  await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [2], 'already running handlers finish; queued callbacks are suppressed');
});

it('(c) strict host-event validation rejects unknown kinds, foreign identifiers and hidden fields', () => {
  for (const event of [null, {}, { kind: 'accept', ids: [randomUUID()] }, { kind: 'draft_accepted', ids: [] },
    { kind: 'draft_accepted', ids: [randomUUID()], state: 'accepted' }, { kind: 'draft_accepted', ids: [1] },
    { kind: 'session_control', ids: [randomUUID()] }, { kind: 'session_control', ids: [0] },
    { kind: 'session_control', ids: [1, 1] }]) assert.throws(() => checkHostEvent(event), { status: 400 });
});

it('(c) HTTP host-event route requires separate service auth, binds sid, and handles all callback kinds over loopback', async (t) => {
  const s = await setup(t);
  const old = await submit(s);
  const m = monitorFor(s);
  t.after(() => m.monitor.stop());
  await m.monitor.start();
  const handler = createHostEventHandler({ sid: s.f.sid, monitor: m.monitor,
    authenticateService: (req) => req.headers['x-synthetic-service'] === 'fixture-service' });
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/v1/sessions/${s.f.sid}/host-event`;
  const send = (event, options = {}) => fetch(options.url ?? url, { method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-synthetic-service': 'fixture-service', ...options.headers },
    ...(options.method === 'GET' ? {} : { body: options.body ?? JSON.stringify(event) }), redirect: 'error' });
  assert.equal((await send({ kind: 'draft_accepted', ids: [old.id] }, { headers: { 'x-synthetic-service': '', authorization: `Bearer ${s.f.token()}` } })).status, 401);
  assert.equal((await send({}, { url: url.replace(s.f.sid, randomUUID()) })).status, 404);
  assert.equal((await send({}, { method: 'GET' })).status, 405);
  assert.equal((await send({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send({}, { body: 'bad JSON' })).status, 400);
  assert.equal((await send({}, { body: new Uint8Array([0xff]) })).status, 400);
  assert.equal((await send({}, { body: 'x'.repeat(65_537) })).status, 413);
  const next = await replacement(s, old);
  const result = await s.intake.execute(next.op, s.authority);
  assert.equal((await send({ kind: 'draft_superseded', ids: [old.id] })).status, 204);
  await accept(s, result.result.data.host_ids.draft_id);
  assert.equal((await send({ kind: 'draft_accepted', ids: [result.result.data.host_ids.draft_id] })).status, 204);
  const { control } = s.f.host.revoke(s.f.sid);
  assert.equal((await send({ kind: 'session_control', ids: [control.seq] })).status, 204);
  assert.equal(m.monitor.active, false);
  assert.equal(m.controls.length, 1);
});
