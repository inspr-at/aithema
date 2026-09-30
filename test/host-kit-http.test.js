import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadContractFile } from '../contracts/validate.js';
import { serveHost } from './host-kit/index.js';
import { claimRequest, fixture, record, validDocuments } from './host-kit/fixtures.js';
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

  it('retries after the committed response socket is destroyed, without adding a second record', async (t) => {
    const f = fixture();
    const local = await serveHost(f.host);
    t.after(local.close);
    local.server.prependOnceListener('request', (_req, res) => {
      res.end = () => res.destroy();
    });
    const doc = record(f.sid);
    const request = { method: 'POST', path: `/journal/sessions/${f.sid}/records`, token: f.token(), body: doc };
    await assert.rejects(send(local.url, request), { code: 'ECONNRESET' });
    const retry = await send(local.url, request);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.seq, 1);
    assert.equal(f.request('journal', 'records').body.length, 1);
  });

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
  ];
  it('has a transport scenario for every v1 catalogue code; post-v1 target codes stay outside this kit', () => {
    assert.deepEqual(errors.map(([code]) => code).sort(), loadContractFile('error-codes.json').codes.filter((entry) => entry.scope === 'v1').map((entry) => entry.code).sort());
  });
  for (const [code, area, action, prepare] of errors) {
    it(`returns catalogued HTTP status and machine-readable code for ${code}`, async (t) => {
      const route = routes.find((r) => r.area === area && r.action === action && r.method === 'POST');
      const { f, request } = routeScenario(route);
      prepare(f, request);
      const local = await serveHost(f.host);
      t.after(local.close);
      const response = await send(local.url, request);
      assert.equal(response.status, loadContractFile('error-codes.json').codes.find((entry) => entry.code === code).http);
      assert.equal(response.body.code, code);
      validDocuments(response.body);
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
