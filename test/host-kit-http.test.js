import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { canonicalJson, loadContractFile } from '../contracts/validate.js';
import { serveHost } from './host-kit/index.js';
import { claimRequest, fixture, record, snapshot, validDocuments } from './host-kit/fixtures.js';
import { routeScenario, routes } from './host-kit/scenarios.js';

/** A loopback-only client makes accidental external test traffic impossible. */
function send(base, request) {
  const url = new URL(request.path, base);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.origin, base);
  return new Promise((resolve, reject) => {
    const body = request.body === undefined ? null : typeof request.body === 'string' || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
    const headers = { ...(request.token === undefined ? {} : { authorization: `Bearer ${request.token}` }),
      ...(request.person ? { cookie: `host_person=${request.person}` } : {}),
      ...(request.opKey ? { 'idempotency-key': request.opKey } : {}),
      ...(request.liveGrant ? { 'x-live-grant': request.liveGrant } : {}),
      ...(request.intakeMetadata === undefined ? {} : { 'x-aithema-intake': request.intakeMetadata }),
      ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      ...request.headers,
    };
    const req = httpRequest(url, { method: request.method, headers, timeout: 2000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Loopback request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

describe('host kit loopback HTTP facade (AIT-44b/c)', () => {
  for (const action of ['sources', 'transcript-turns', 'drafts', 'replace']) {
    it(`${action}: forwards and validates intake metadata before mutation, and includes it in retry identity`, async (t) => {
      const { f, request } = routeScenario(routes.find((r) => r.area === 'intake' && r.action === action));
      let conversationSourceId = null;
      if (action === 'transcript-turns') {
        conversationSourceId = f.request('intake', 'sources', record(f.sid, 'source'), { opKey: `${f.sid}:source:1` }).body.result.data.host_ids.source_id;
      }
      const metadata = action === 'sources' || action === 'transcript-turns' ? { conversation_source_id: conversationSourceId } :
        { kind: 'requirement', citations: [], supersedes_draft_id: action === 'replace' ? request.path.split('/').at(-2) : null };
      const encode = (value) => Buffer.from(canonicalJson(value)).toString('base64url');
      const local = await serveHost(f.host);
      t.after(local.close);
      const before = f.request('intake', '').body;
      const seq = f.request('journal', 'cursor').body.seq;
      const foreign = await send(local.url, { ...request, body: { ...request.body, sid: '11111111-1111-4111-8111-111111111111' },
        intakeMetadata: encode(metadata) });
      assert.equal(foreign.status, 403);
      for (const header of ['not*base64url', Buffer.from([0xff]).toString('base64url'), encode([]), encode(null),
        encode({ ...metadata, target_node_id: f.sid }), encode({ ...metadata, generation: 1 }),
        Buffer.from(JSON.stringify(metadata, null, 2)).toString('base64url')]) {
        assert.equal((await send(local.url, { ...request, intakeMetadata: header })).status, 400);
        assert.deepEqual(f.request('intake', '').body, before);
        assert.equal(f.request('journal', 'cursor').body.seq, seq);
      }
      const wrong = action === 'sources' || action === 'transcript-turns' ?
        { conversation_source_id: '11111111-1111-4111-8111-111111111111' } :
        { ...metadata, kind: 'brief' };
      assert.equal((await send(local.url, { ...request, intakeMetadata: encode(wrong) })).status, 400);
      if (action === 'replace') {
        assert.equal((await send(local.url, { ...request, intakeMetadata: encode({ ...metadata,
          supersedes_draft_id: '11111111-1111-4111-8111-111111111111' }) })).status, 400);
      }
      const valid = { ...request, intakeMetadata: encode(metadata) };
      const first = await send(local.url, valid);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.deepEqual((await send(local.url, valid)).body, first.body);
      const conflict = await send(local.url, { ...valid, intakeMetadata: encode({ ...metadata, extra: true }) });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');
      assert.deepEqual((await send(local.url, valid)).body, first.body);
    });
  }

  for (const route of routes) {
    it(`${route.method} ${route.area}/${route.action || '(snapshot)'} works identically over HTTP`, async (t) => {
      const { f, request } = routeScenario(route);
      const local = await serveHost(f.host);
      t.after(local.close);
      assert.equal(local.server.address().address, '127.0.0.1');
      assert.ok(local.server.address().port > 0);
      const wrong = await send(local.url, { ...request, token: f.token({ capabilities: ['intake.read', 'aithema.authority.read'].filter((cap) => cap !== route.capability) }) });
      assert.equal(wrong.status, 403);
      const response = await send(local.url, request);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.headers['cache-control'], 'no-store');
      validDocuments(response.body);
      if (route.action !== 'claim') {
        const retry = f.host.request(request);
        assert.equal(retry.status, 200);
        assert.deepEqual(response.body, retry.body);
      } else {
        assert.equal(f.host.request(request).body.code, 'already_claimed');
      }
    });
  }

  it('lost HTTP ack retries preserve original sequence and exact wire bytes; malformed input never appends', async (t) => {
    const f = fixture();
    const local = await serveHost(f.host);
    t.after(local.close);
    const doc = record(f.sid);
    const body = `\n${JSON.stringify(doc, null, 2)}\n`;
    const request = { method: 'POST', path: `/journal/sessions/${f.sid}/records`, token: f.token(), body };
    const first = await send(local.url, request);
    const retry = await send(local.url, request);
    assert.deepEqual(retry.body, first.body);
    assert.equal(f.host.storedBytes(f.sid, doc.client_event_id), body);
    const conflict = await send(local.url, { ...request, body: JSON.stringify(doc) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'idempotency_conflict');
    validDocuments(conflict.body);
    for (const malformed of ['{', '', '[]', '{"__proto__":{}}']) {
      assert.equal((await send(local.url, { ...request, body: malformed })).status, 400);
    }
    assert.equal((await send(local.url, { ...request, headers: { authorization: 'Basic synthetic' } })).status, 401);
    f.host.takeover(f.sid);
    assert.equal((await send(local.url, request)).body.code, 'fenced_generation');
  });

  for (const [area, action] of [['journal', 'records'], ['journal', 'snapshots'], ['journal', 'op.result'], ['ledger', 'admit']]) {
    it(`${area}/${action}: current worker retries a lost HTTP ack after takeover without a second write`, async (t) => {
      const route = routes.find((r) => r.area === area && r.action === action && r.method === 'POST');
      const { f, request } = routeScenario(route);
      const local = await serveHost(f.host);
      t.after(local.close);
      const body = `\n${JSON.stringify(request.body, null, 2)}\n`;
      const original = { ...request, body };
      local.server.prependOnceListener('request', (_req, res) => {
        res.end = () => res.destroy();
      });
      await assert.rejects(send(local.url, original), { code: 'ECONNRESET' });
      f.host.takeover(f.sid);
      assert.equal((await send(local.url, original)).body.code, 'fenced_generation');
      const current = { ...original, token: f.token({ gen: 2 }) };
      const retry = await send(local.url, current);
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.body, f.host.request(current).body);
      validDocuments(retry.body);
      if (area === 'journal') {
        assert.equal(retry.body.seq, 1);
        assert.equal(f.request('journal', 'records').body.length, 1);
        assert.equal(f.host.storedBytes(f.sid, request.body.client_event_id), body);
      } else {
        const holds = f.request('ledger', 'holds', undefined, { path: `/ledger/sessions/${f.sid}/holds?state=open` });
        assert.equal(holds.body.body.holds.length, 1);
        assert.equal(retry.body.body.hold_id, holds.body.body.holds[0].hold_id);
        assert.equal(retry.body.body.remaining_micro, 999_900);
      }
      const conflict = await send(local.url, { ...current, body: `${body}\n` });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');
    });
  }

  it('HTTP intake polling returns the committed snapshot bytes after append and takeover; accepted resubmits have a code', async (t) => {
    const { f, request } = routeScenario(routes.find((r) => r.area === 'intake' && r.action === 'drafts'));
    const local = await serveHost(f.host);
    t.after(local.close);
    const submitted = await send(local.url, request);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.snapshot.minor, 0);
    assert.equal(submitted.body.snapshot.min_reader, 0);
    const bytes = JSON.stringify(submitted.body.snapshot);
    const recordRequest = { method: 'POST', path: `/journal/sessions/${f.sid}/records`, token: f.token(), body: record(f.sid) };
    assert.equal((await send(local.url, recordRequest)).status, 200);
    f.host.takeover(f.sid);
    const current = { token: f.token({ gen: 2 }), liveGrant: f.host.liveGrant(f.sid) };
    const read = { method: 'GET', path: `/intake/sessions/${f.sid}`, token: f.token() };
    const polled = await send(local.url, read);
    assert.equal(polled.status, 200);
    assert.equal(JSON.stringify(polled.body.snapshot), bytes);
    assert.deepEqual((await send(local.url, { ...request, ...current })).body, submitted.body);
    const id = submitted.body.result.data.host_ids.draft_id;
    const accepted = await send(local.url, { method: 'POST', path: `/intake/sessions/${f.sid}/drafts/${id}/accept`,
      person: f.host.personSession(f.sid, 'person-1') });
    assert.equal(accepted.status, 200);
    assert.notEqual(accepted.body.snapshot.client_event_id, submitted.body.snapshot.client_event_id);
    assert.equal(JSON.stringify((await send(local.url, read)).body.snapshot), JSON.stringify(accepted.body.snapshot));
    const resubmit = await send(local.url, { ...request, ...current, opKey: `${f.sid}:submit:2`,
      body: snapshot(f.sid, [request.body.spec.items[0]], { worker_generation: 2 }) });
    assert.equal(resubmit.status, 409);
    assert.equal(resubmit.body.code, 'already_accepted');
    validDocuments(resubmit.body);
  });

  const extensionDescriptor = { namespace: 'x-test.analysis', version: '1.0', title: 'Synthetic analysis', schema: {
    type: 'object', additionalProperties: false, required: ['score'], properties: {
      score: { type: 'number' }, evidence: { type: 'string', maxLength: 8 },
    },
  } };
  const extensionData = (data) => ({ 'x-test.analysis@1': { version: '1.0', data } });
  const errors = [
    ['idempotency_conflict', 'journal', 'records', (f, req) => { f.host.request(req); req.body = `${JSON.stringify(req.body)}\n`; }],
    ['citation_invalid', 'intake', 'drafts', (_f, req) => { req.body.spec.items[0].citations = [{ record_seq: 999, locator: 'turn:0' }]; }],
    ['draft_superseded', 'intake', 'replace', (f, req) => { f.host.request(req); req.opKey = `${f.sid}:replace:2`; }],
    ['already_accepted', 'intake', 'replace', (f, req) => {
      f.host.request({ method: 'POST', path: req.path.replace(/replace$/, 'accept'), person: f.host.personSession(f.sid, 'person-1') });
    }],
    ['fenced_generation', 'journal', 'records', (f) => { f.host.takeover(f.sid); }],
    ['revoked', 'journal', 'records', (f) => { f.host.revoke(f.sid); }],
    ['contract_too_new', 'journal', 'records', (_f, req) => { req.body.major = 2; }],
    ['already_claimed', 'ledger', 'claim', (f, req) => { f.host.request(req); }],
    ['hold_closed', 'ledger', 'recover', (f, req) => {
      f.host.request(req);
      req.path = req.path.replace(/recover$/, 'claim');
      req.body = claimRequest(req.body.body.hold_id);
    }],
    ['budget_denied', 'ledger', 'admit', (f) => { f.host.setEvidence(f.sid, false); }],
    ['extension_unknown', 'intake', 'drafts', (_f, req) => {
      req.body.minor = 1;
      req.body.spec.items[0].extensions = extensionData({ score: 1 });
    }],
    ['extension_invalid', 'intake', 'drafts', (f, req) => {
      f.host.registerExtension(f.sid, extensionDescriptor);
      req.body.minor = 1;
      req.body.spec.items[0].extensions = extensionData({ score: 'high' });
    }],
    ['extension_limit', 'intake', 'drafts', (f, req) => {
      f.host.registerExtension(f.sid, extensionDescriptor);
      req.body.minor = 1;
      req.body.spec.items[0].extensions = extensionData({ score: 1, evidence: 'x'.repeat(9) });
    }],
  ];
  it('has a transport scenario for every v1 catalogue code; post-v1 target codes stay outside this kit', () => {
    assert.deepEqual(errors.map(([code]) => code).sort(), loadContractFile('error-codes.json').codes.filter((entry) => entry.scope === 'v1').map((entry) => entry.code).sort());
  });
  for (const [code, area, action, prepare] of errors) {
    it(`returns catalogued HTTP status and machine-readable code for ${code}`, async (t) => {
      const route = routes.find((r) => r.area === area && r.action === action && r.method === 'POST');
      const { f, request } = routeScenario(route);
      prepare(f, request);
      const before = code.startsWith('extension_') ? {
        intake: f.request('intake', '').body, cursor: f.request('journal', 'cursor').body,
      } : null;
      const local = await serveHost(f.host);
      t.after(local.close);
      const response = await send(local.url, request);
      assert.equal(response.status, loadContractFile('error-codes.json').codes.find((entry) => entry.code === code).http);
      assert.equal(response.body.code, code);
      validDocuments(response.body);
      if (before) {
        assert.deepEqual(f.request('intake', '').body, before.intake);
        assert.deepEqual(f.request('journal', 'cursor').body, before.cursor);
        if (code === 'extension_unknown') f.host.registerExtension(f.sid, extensionDescriptor);
        request.body.minor = 1;
        request.body.min_reader = 0;
        request.body.spec.items[0].extensions = extensionData({ score: 1, evidence: 'x'.repeat(8) });
        const submitted = await send(local.url, request);
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.snapshot.minor, 1);
        assert.equal(submitted.body.snapshot.min_reader, 0);
        assert.deepEqual(submitted.body.snapshot.spec.items[0].extensions, request.body.spec.items[0].extensions);
        assert.deepEqual((await send(local.url, request)).body, submitted.body);
        validDocuments(submitted.body);
      }
    });
  }

  it('returns HTTP 413 for oversized input, 404 for unknown paths and rejects fake person cookies', async (t) => {
    const f = fixture();
    const local = await serveHost(f.host);
    t.after(local.close);
    assert.equal((await send(local.url, { method: 'POST', path: `/journal/sessions/${f.sid}/records`, token: f.token(), body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal((await send(local.url, { method: 'POST', path: `/journal/sessions/${f.sid}/records`, token: f.token(), body: Buffer.from([0xff]) })).status, 400);
    assert.equal((await send(local.url, { method: 'GET', path: '/not-a-route', token: f.token() })).status, 404);
    assert.equal((await send(local.url, { method: 'POST', path: `/intake/sessions/${f.sid}/drafts/${f.sid}/accept`, person: 'fake-person' })).status, 403);
    assert.equal((await send(local.url, { method: 'POST', path: `/intake/sessions/${f.sid}/drafts/${f.sid}/accept`, headers: { cookie: 'host_person=a; host_person=b' } })).status, 400);
  });

  it('is excluded by the existing release artifact allowlist', () => {
    const allowlist = JSON.parse(readFileSync(new URL('../release/allowlist.json', import.meta.url), 'utf8'));
    assert.equal(allowlist.paths.some((path) => path === 'test/' || path.startsWith('test/host-kit')), false);
    assert.ok(allowlist.forbidden_patterns.some((pattern) => new RegExp(pattern).test('test/host-kit/index.js')));
  });
});
