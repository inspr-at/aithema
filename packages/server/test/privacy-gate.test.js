import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { createHostHandlers } from '../src/host-handlers.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { EMAIL_NOTICE_VERSION } from '../../../demo/visitor-credits.js';
import { mockConsent } from '../../../test/helpers.js';
import { inputRevision, reduceHandover } from '@inspr/aithema-core';

const owner = 'privacy-owner', id = 'privacy-session', address = 'privacy@example.test';
const error = { error: 'privacy-document-required' };
const refused = value => value?.code === error.error;
const routes = [
  ['POST', '/api/visitor/email', { address, noticeVersion: EMAIL_NOTICE_VERSION }],
  ['PUT', '/api/visitor/email', { address, noticeVersion: EMAIL_NOTICE_VERSION }],
  ...['request', 'change', 'resend', 'confirm', 'unlock'].map(action => ['POST', `/api/sessions/${id}/identity/${action}`,
    ['request', 'change'].includes(action) ? { address } : action === 'confirm' ? { token: 'unused' } : {}]),
];

function fixture(t, { demo = false, document = false, initialize = true, verificationRequired = false } = {}) {
  const storage = new SQLiteStorage();
  const host = createDemoHost({ storage, demo, verificationRequired, now: () => 1_000 });
  host.privacyDocumentConfigured = () => document;
  let reads = 0;
  const commands = createHostHandlers({ storage, host,
    ownership: { token: request => request.headers.get('x-aithema-session-token') },
    async readBody(request) { reads++; return new Uint8Array(await request.arrayBuffer()); },
    publish() {}, snapshot: sessionId => storage.get(sessionId), unlocked() {}, now: host.now,
    async eraseConversation(sessionId, ownerToken) {
      storage.erase(sessionId, { ownerToken });
      await host.erased({ sessionId, ownerToken });
    },
  });
  storage.create({ id, ownerToken: owner });
  if (initialize) commands.initialize(id, owner, { newSession: true });
  const handlers = createHandlers({ storage, host, consent: mockConsent });
  t.after(async () => { await handlers.close(); await commands.idle(); storage.close(); });
  const request = (path, body = {}, method = 'POST', token = owner) => new Request(`http://local${path}`, {
    method, headers: { 'x-aithema-session-token': token, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const call = (path, body = {}, method = 'POST') => commands.handle(request(path, body, method));
  const snapshot = () => ({ session: storage.get(id), events: storage.read(id), host: storage.hostState(id),
    visitors: storage.db.prepare('SELECT * FROM visitor_identities').all(),
    tokens: storage.db.prepare('SELECT * FROM visitor_confirmation_tokens').all() });
  const save = () => host.saveEmail(owner, { address, noticeVersion: host.emailNotice.version });
  return { storage, host, commands, handlers, call, request, snapshot, save, reads: () => reads,
    document: value => { document = value; } };
}

for (const deliversVerification of [false, true]) test(`AIT-135/AIT-151: all collection refuses before reading or saving (delivery ${deliversVerification})`, async t => {
  const f = fixture(t);
  f.host.identity.deliversVerification = deliversVerification;
  const before = f.snapshot();
  let writes = 0;
  for (const [target, key] of [[f.host, 'saveEmail'], [f.host.identity, 'persist'],
    [f.host.identity, 'requestVerification'], [f.host.identity, 'verify']]) {
    t.mock.method(target, key, () => { writes++; throw new Error('unexpected address effect'); });
  }
  for (const [method, path, body] of routes) await t.test(`${method} ${path}`, async () => {
    for (const payload of [body, '{']) {
      const response = await f.call(path, payload, method);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), error);
      assert.equal(f.reads(), 0);
      assert.equal(writes, 0);
      assert.deepEqual(f.snapshot(), before);
    }
  });
});

test('AIT-135/AIT-151: an identity command refuses before initializing an older conversation', async t => {
  const f = fixture(t, { initialize: false }), before = f.snapshot();
  const response = await f.handlers.handle(f.request(`/api/sessions/${id}/identity/request`, '{'));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  assert.deepEqual(f.snapshot(), before);
});

for (const document of [false, 'true', 1]) test(`AIT-135/AIT-151: document capability must return exactly true (${document})`, async t => {
  const f = fixture(t, { document });
  const response = await f.call('/api/visitor/email', { address, noticeVersion: f.host.emailNotice.version });
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  assert.equal(f.reads(), 0);
});

for (const demo of [undefined, 'true', 1]) test(`AIT-135/AIT-151: only the explicit boolean demo flag exempts collection (${demo})`, async t => {
  const f = fixture(t); f.host.demo = demo;
  const response = await f.call('/api/visitor/email', { address, noticeVersion: f.host.emailNotice.version });
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
});

for (const demo of [false, true]) test(`AIT-135/AIT-151: save and replace work with ${demo ? 'the demo exemption' : 'a validated document'}`, async t => {
  const f = fixture(t, { demo, document: !demo });
  if (demo) {
    f.host.identity.deliversVerification = false;
    t.mock.method(f.host, 'privacyDocumentConfigured', () => { throw new Error('demo must be exempt'); });
  }
  for (const [method, value] of [['POST', address], ['PUT', 'replacement@example.test']]) {
    const response = await f.call('/api/visitor/email', { address: value, noticeVersion: f.host.emailNotice.version }, method);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).visitor.address, value);
    assert.equal(f.host.visitor(owner).address, value);
  }
});

for (const erase of [false, true]) test(`AIT-135/AIT-151: ${erase ? 'visitor erasure' : 'DELETE email'} remains available without a document`, async t => {
  const f = fixture(t, { demo: true });
  assert.equal((await f.call(`/api/sessions/${id}/identity/request`, { address })).status, 200);
  f.save();
  const second = f.storage.create({ id: 'privacy-second', ownerToken: owner });
  f.commands.initialize(second.id, owner, { newSession: true });
  f.host.demo = false;
  t.mock.method(f.host, 'privacyDocumentConfigured', () => { throw new Error('deletion must never need a document'); });
  const response = await f.handlers.handle(f.request(`/api/visitor/${erase ? 'erase' : 'email'}`, {}, erase ? 'POST' : 'DELETE'));
  assert.equal(response.status, 200);
  if (erase) {
    assert.equal((await response.json()).erased, true);
    assert.ok(f.storage.get(id).tombstone); assert.ok(f.storage.get(second.id).tombstone);
    assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities').get().n, 0);
  } else {
    assert.equal((await response.json()).visitor.address, null);
    assert.ok(!f.storage.get(id).tombstone);
  }
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_confirmation_tokens').get().n, 0);
  for (const sessionId of [id, second.id]) {
    assert.ok(!JSON.stringify(f.storage.get(sessionId)).includes(address));
    assert.ok(!JSON.stringify(f.storage.read(sessionId)).includes(address));
  }
});

for (const existing of [false, true]) test(`AIT-135/AIT-151: ${existing ? 'existing' : 'initial'} address projections refuse before persistence`, async t => {
  const f = fixture(t, { initialize: existing });
  f.save();
  const before = f.snapshot();
  assert.throws(() => f.commands.initialize(id, owner), refused);
  assert.deepEqual(f.snapshot(), before);
  const response = await f.handlers.handle(new Request(`http://local/api/sessions/${id}`, {
    headers: { 'x-aithema-session-token': owner },
  }));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  assert.deepEqual(f.snapshot(), before);
});

for (const transition of ['policy', 'pause', 'handover', 'retry', 'recovery']) test(`AIT-135/AIT-151: address-bearing ${transition} transitions refuse persistence`, async t => {
  const f = fixture(t, { demo: true, verificationRequired: transition === 'policy' });
  assert.equal((await f.call(`/api/sessions/${id}/identity/request`, { address })).status, 200);
  if (['retry', 'recovery'].includes(transition)) f.storage.transitionHost(id, state => ({ state: { ...state,
    handover: reduceHandover(state.handover, { type: 'request', revision: inputRevision(f.storage.get(id)) }).state }, events: [] }), { ownerToken: owner });
  if (transition === 'pause') f.storage.pause(id, true, { ownerToken: owner });
  f.host.demo = false; f.host.policy.verificationRequired = false;
  const before = f.snapshot();
  if (transition === 'policy') assert.throws(() => f.commands.initialize(id, owner), refused);
  else if (transition === 'pause') assert.throws(() => f.commands.syncPause(id, owner), refused);
  else if (transition === 'recovery') assert.doesNotThrow(() => f.commands.resume());
  else {
    const port = f.host.handover(owner);
    t.mock.method(f.host, 'handover', () => ({ ...port, offer: () => ({ available: true }) }));
    const response = await f.call(`/api/sessions/${id}/handover${transition === 'retry' ? '/retry' : ''}`);
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  }
  assert.deepEqual(f.snapshot(), before);
});

for (const command of ['request', 'confirm']) test(`AIT-135/AIT-151: ${command} dispatch rechecks the document after reserving state`, async t => {
  const f = fixture(t, { demo: true, document: true });
  if (command === 'confirm') assert.equal((await f.call(`/api/sessions/${id}/identity/request`, { address })).status, 200);
  f.host.demo = false;
  const persist = f.host.identity.persist;
  t.mock.method(f.host.identity, 'persist', (...args) => { const result = persist(...args); f.document(false); return result; });
  let dispatched = 0;
  t.mock.method(f.host.identity, command === 'request' ? 'requestVerification' : 'verify', () => { dispatched++; return {}; });
  const response = await f.call(`/api/sessions/${id}/identity/${command}`, command === 'request' ? { address } : { token: 'unused' });
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  assert.equal(dispatched, 0);
  assert.equal(f.storage.hostState(id).identity.status, 'verification-pending');
  assert.equal(f.storage.hostState(id).identity.delivery, command === 'request' ? 'requested' : 'sent');
});

for (const command of ['request', 'unlock']) test(`AIT-135/AIT-151: ${command} result rechecks the document after an asynchronous host reply`, async t => {
  const f = fixture(t, { demo: true, document: true });
  if (command === 'unlock') assert.equal((await f.call(`/api/sessions/${id}/identity/request`, { address })).status, 200);
  f.host.demo = false;
  const before = f.snapshot();
  t.mock.method(f.host.identity, command === 'request' ? 'requestVerification' : 'verify', async effect => {
    f.document(false);
    return command === 'request' ? { status: 'sent' } : { verified: true, address: effect.address, revision: effect.revision };
  });
  const response = await f.call(`/api/sessions/${id}/identity/${command}`, command === 'request' ? { address } : {});
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), error);
  assert.equal(f.storage.hostState(id).identity.status, 'verification-pending');
  if (command === 'request') assert.equal(f.storage.hostState(id).identity.delivery, 'requested');
  else assert.deepEqual(f.snapshot(), before);
});
