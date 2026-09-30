import { it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, loadContractFile, sha256Hex, validate } from '../contracts/validate.js';
import { AeonHttp, AeonJournal } from '../runtime/hosts/aeon/index.js';
import { reopenDesign } from '../runtime/journal/index.js';
import { serveHost } from './host-kit/index.js';
import { fixture, item, record, snapshot } from './host-kit/fixtures.js';

const bytes = (doc) => canonicalJson(doc);

async function setup(t, { recordFormat = 'projection', transform = (response) => response } = {}) {
  const f = fixture();
  const pages = [];
  const server = await serveHost({ request(request) {
    const response = f.host.request(request);
    if (recordFormat === 'stored' && response.status === 200 && request.path.startsWith('/journal/')) {
      const stored = (doc) => ({ document: doc, bytes: f.host.storedBytes(f.sid, doc.client_event_id) });
      if (Array.isArray(response.body)) response.body = response.body.map(stored);
      else if (response.body.contract) response.body = stored(response.body);
      else if (response.body.snapshot) response.body.snapshot = stored(response.body.snapshot);
    }
    if (request.path.includes('/records?')) pages.push({ path: request.path, size: Buffer.byteLength(JSON.stringify(response.body)) });
    return transform(response, request, f);
  } });
  t.after(() => server.close());
  const authority = { sid: f.sid, tid: f.authz.tid, pid: f.authz.pid, gen: 1, auth_epoch: 1,
    writer_kind: 'worker', capabilities: loadContractFile('capabilities.json').delegated_allowed };
  const http = new AeonHttp({ baseUrl: server.url, scope: authority, credentials: () => ({ token: f.token() }) });
  return { f, pages, authority, journal: new AeonJournal({ http, recordFormat }) };
}

function maxObject(size) {
  const emptySize = Buffer.byteLength(bytes({ fixture: '' }));
  const value = { fixture: '"'.repeat((size - emptySize) / 2) };
  assert.equal(Buffer.byteLength(bytes(value)), size);
  return value;
}

for (const recordFormat of ['projection', 'stored']) {
  it(`(a,d) ${recordFormat}: cursor, replay and closure hydrate 400 max turns and 12 max design inputs under 4 MiB per page`, async (t) => {
    const s = await setup(t, { recordFormat });
    const turn = record(s.f.sid).data;
    for (let n = 0; n < 400; n++) {
      const doc = record(s.f.sid, 'turn', { ...turn, body: 't'.repeat(8000) });
      assert.equal(s.f.request('journal', 'records', bytes(doc)).status, 200);
    }
    const screen_ir = maxObject(512 * 1024);
    const tokens = maxObject(64 * 1024);
    const data = { screen_ir, tokens, screen_ir_sha256: sha256Hex(bytes(screen_ir)), tokens_sha256: sha256Hex(bytes(tokens)) };
    const designDocs = [];
    for (let n = 0; n < 12; n++) {
      const doc = record(s.f.sid, 'design.input', data);
      assert.equal(validate(doc.contract, doc).ok, true);
      assert.equal(s.f.request('journal', 'records', bytes(doc)).status, 200);
      designDocs.push(doc);
    }
    const evidence = item({ state: 'draft', citations: [{ record_seq: 1, locator: 'turn:0', quote: 'ttt' }],
      provenance: { intent: 'requested', derived_from: [1, 400] } });
    const doc = snapshot(s.f.sid, [], { consumed_seq: 412,
      spec: { items: [evidence], questions: [], brief: null,
        screens: designDocs.map((_, n) => ({ screen_ref: `screen-${n}`, design_input_seq: 401 + n })) } });
    assert.equal(s.f.request('journal', 'snapshots', bytes(doc)).status, 200);
    const { cursor, closure } = await s.journal.hydrate(s.authority);
    assert.equal(cursor.last_seq, 413);
    assert.equal(cursor.snapshot.document.working_rev, 1);
    assert.deepEqual([...closure.keys()], [1, 400, ...Array.from({ length: 12 }, (_, n) => 401 + n)]);
    const full = await s.journal.recordsAfter(0, s.authority);
    assert.equal(full.length, 413);
    assert.deepEqual(full.map((r) => r.document.seq), Array.from({ length: 413 }, (_, n) => n + 1));
    assert.equal((await s.journal.recordsAfter(400, s.authority, 412)).length, 12);
    for (let n = 0; n < 12; n++) {
      const rendered = await reopenDesign(cursor.snapshot.document, closure, `screen-${n}`, (input) => input);
      assert.equal(rendered.record_bytes.toString(), bytes(designDocs[n]));
      assert.equal(rendered.screen_ir_bytes.toString(), bytes(screen_ir));
      assert.equal(rendered.tokens_bytes.toString(), bytes(tokens));
    }
    for (const page of s.pages) {
      const query = new URL(page.path, 'http://127.0.0.1').searchParams;
      assert.equal(query.has('after'), false, 'unbounded tail routes are never used');
      assert.ok(query.get('ids').split(',').length <= (recordFormat === 'stored' ? 1 : 3));
      assert.ok(page.size <= 4 * 1024 * 1024, `page exceeds response cap: ${page.size}`);
    }
  });
}

for (const entry of ['cursor', 'recordsAfter', 'recordsByIds']) {
  it(`(a) ${entry} rejects a missing middle journal record even when the final seq matches`, async (t) => {
    const s = await setup(t, { transform(response, request) {
      if (request.path.includes('/records?') && response.status === 200) response.body = response.body.filter((row) => row.seq !== 2);
      return response;
    } });
    for (let n = 0; n < 4; n++) assert.equal(s.f.request('journal', 'records', record(s.f.sid)).status, 200);
    const work = entry === 'cursor' ? s.journal.cursor(s.authority) : entry === 'recordsAfter' ?
      s.journal.recordsAfter(0, s.authority, 4) : s.journal.recordsByIds([1, 2, 3, 4], s.authority);
    await assert.rejects(work, { status: 422, code: 'citation_invalid' });
  });
}

it('(a) replay pins its upper bound and handles empty and invalid cursor ranges', async (t) => {
  const s = await setup(t, { transform(response, request, f) {
    if (request.path.endsWith('/cursor')) f.request('journal', 'records', record(f.sid));
    return response;
  } });
  s.f.request('journal', 'records', record(s.f.sid));
  assert.deepEqual((await s.journal.recordsAfter(0, s.authority)).map((r) => r.document.seq), [1]);
  assert.deepEqual(await s.journal.recordsAfter(2, s.authority, 2), []);
  assert.deepEqual(await s.journal.recordsAfter(100, s.authority), []);
  for (const [after, through] of [[-1, 2], [1.5, 2], [0, -1], [3, 2], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(s.journal.recordsAfter(after, s.authority, through), { status: 400 });
  }
});
