import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets } from '../src/index.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { mockConsent, temporaryDb, readEvents, unzip } from '../../../test/helpers.js';
import { createSession, applyEvent, inputRevision, createHandover, reduceHandover, PluginError } from '@inspr/aithema-core';

const owner = 'host-owner', foreign = 'another-owner';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const storage = options.storage ?? new SQLiteStorage();
  let time = 1_000;
  const host = createDemoHost({ storage, demoBypass: false, verificationRequired: true, now: () => time,
    identityPolicy: { resendCooldownMs: 100, verificationTtlMs: 500 }, ...options });
  const runtime = createPluginRuntime({ storage, consent: mockConsent, presets: options.presets });
  const handlers = createHandlers({ storage, consent: mockConsent, pluginRuntime: runtime, host, ownership: options.ownership,
    deadlineMs: options.deadlineMs ?? 30_000 });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await handlers.close(); storage.close(); };
  t.after(close);
  const call = (path, body, token = owner, method = body === undefined ? 'GET' : 'POST') => handlers.handle(new Request(`http://local${path}`, {
    method, headers: { ...(token ? { 'x-aithema-session-token': token } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const create = async () => (await call('/api/sessions', {})).json();
  const message = async id => (await (await call(`/api/sessions/${id}/demo/outbox`)).json()).messages.at(-1);
  return { storage, host, runtime, handlers, call, create, message, close, at: value => { time = value; } };
}

for (const route of ['sessions', 'library', 'reset']) test(`AIT-217: ${route} creation renews ownership once on the 201 response`, async t => {
  const created = t.mock.fn((response, token) => {
    assert.equal(response.status, 201);
    assert.equal(response.bodyUsed, false);
    response.headers.set('set-cookie', `owner=${token}; HttpOnly`);
  });
  const f = fixture(t, { ownership: { token: request => request.headers.get('x-aithema-session-token'), created } });
  const previous = route === 'reset' ? await f.create() : null;
  created.mock.resetCalls();
  const path = previous ? `/api/library/${previous.id}/reset` : `/api/${route}`;
  const request = new Request(`http://local${path}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' }, body: '{}',
  });
  const response = await f.handlers.handle(request);
  assert.equal(response.status, 201);
  assert.equal(created.mock.callCount(), 1);
  const [hookResponse, token, hookRequest] = created.mock.calls[0].arguments;
  assert.equal(hookResponse, response);
  assert.equal(token, owner);
  assert.equal(hookRequest, request);
  assert.equal(response.headers.get('set-cookie'), `owner=${owner}; HttpOnly`);
  const entry = await response.json();
  assert.equal(f.storage.authorize(entry.id, token).id, entry.id);
  if (previous) assert.notEqual(entry.id, previous.id);
});

for (const route of ['library', 'reset']) test(`AIT-217: failed ${route} creation never renews ownership`, async t => {
  const created = t.mock.fn();
  const f = fixture(t, { ownership: { token: request => request.headers.get('x-aithema-session-token'), created } });
  const previous = route === 'reset' ? await f.create() : null;
  created.mock.resetCalls();
  const path = previous ? `/api/library/${previous.id}/reset` : '/api/library';
  const invalid = previous ? { unexpected: true } : { title: 'x'.repeat(201) };
  assert.equal((await f.call(path, invalid)).status, 400);
  assert.equal((await f.call(path, {}, null)).status, 401);
  if (previous) assert.equal((await f.call(path, {}, foreign)).status, 404);
  t.mock.method(f.storage, previous ? 'erase' : 'create', () => { throw new Error('storage unavailable'); });
  assert.equal((await f.call(path, {})).status, 500);
  assert.equal(created.mock.callCount(), 0);
});

const sessionRoutes = [
  ['identity', undefined], ['identity/request', { address: 'owner@example.test' }], ['identity/resend', {}],
  ['identity/change', { address: 'changed@example.test' }], ['identity/confirm', { token: 'fake-token' }],
  ['identity/unlock', {}], ['handover', undefined], ['handover', {}], ['handover/retry', {}],
  ['credits', undefined], ['demo/outbox', undefined],
];
for (const deliversVerification of [false, true]) test(`AIT-151: non-demo identity routes require privacy before collection (delivery: ${deliversVerification})`, async t => {
  const f = fixture(t, { demo: false }), session = await f.create();
  f.host.identity.deliversVerification = deliversVerification;
  const before = f.storage.get(session.id), events = f.storage.read(session.id);
  let calls = 0;
  for (const key of ['requestVerification', 'verify']) t.mock.method(f.host.identity, key, () => { calls++; throw new Error('must not reach host'); });
  for (const [action, body] of sessionRoutes.filter(([action, body]) => action.startsWith('identity/') && body)) {
    await t.test(action, async () => {
      const path = `/api/sessions/${session.id}/${action}`;
      const response = await f.call(path, body);
      assert.equal(response.status, 403, action);
      assert.deepEqual(await response.json(), { error: 'privacy-document-required' });
      const malformed = await f.handlers.handle(new Request(`http://local${path}`, {
        method: 'POST', headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' }, body: '{',
      }));
      assert.equal(malformed.status, 403, 'refusal precedes body parsing');
      assert.deepEqual(f.storage.get(session.id), before);
      assert.deepEqual(f.storage.read(session.id), events);
      assert.equal((await f.call(path, body, foreign)).status, 404);
      assert.equal(calls, 0);
    });
  }
});

test('AIT-151: the explicit demo flag permits the development flow without privacy, independently of delivery', async t => {
  const f = fixture(t, { verificationRequired: false }), session = await f.create();
  f.host.identity.deliversVerification = false;
  const response = await f.call(`/api/sessions/${session.id}/identity/request`, { address: 'demo@example.test' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).identity.address, 'demo@example.test');
});

test('AIT-151: a validated privacy document releases a non-demo delivering identity flow', async t => {
  const f = fixture(t, { demo: false }), session = await f.create();
  f.host.privacyDocumentConfigured = () => true;
  f.host.identity.deliversVerification = true;
  let delivery;
  t.mock.method(f.host.identity, 'requestVerification', async effect => { delivery = effect; return { status: 'sent' }; });
  t.mock.method(f.host.identity, 'verify', async () => ({ verified: true, address: delivery.address, revision: delivery.revision }));
  const base = `/api/sessions/${session.id}/identity`;
  assert.equal((await f.call(`${base}/request`, { address: 'live@example.test' })).status, 200);
  const confirmed = await f.call(`${base}/confirm`, { token: 'host-evidence' });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).identity.status, 'verified');
});

for (const [action, body] of sessionRoutes) test(`${body ? 'POST' : 'GET'} ${action}: ownership precedes host calls and duplicate state`, async t => {
  const f = fixture(t), session = await f.create();
  await f.call(`/api/sessions/${session.id}/identity/request`, { address: 'owner@example.test' });
  await f.call(`/api/sessions/${session.id}/handover`, {});
  let calls = 0;
  for (const target of [f.host.identity, f.host]) for (const key of ['requestVerification', 'verify', 'outbox', 'wallet', 'handover']) {
    if (typeof target[key] === 'function') t.mock.method(target, key, () => { calls++; throw new Error('must not reach host'); });
  }
  const before = f.storage.get(session.id);
  for (const token of [null, foreign]) {
    const response = await f.call(`/api/sessions/${session.id}/${action}`, body, token);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'session-not-found' });
    const missing = await f.call(`/api/sessions/missing/${action}`, body, token);
    assert.equal(missing.status, response.status); assert.deepEqual(await missing.json(), { error: 'session-not-found' });
  }
  assert.equal(calls, 0); assert.deepEqual(f.storage.get(session.id), before);
});

for (const [action, body] of [[undefined, undefined], ['rename', { title: 'Foreign' }], ['delete', {}], ['reset', {}]]) {
  test(`library ${action ?? 'open'} checks ownership before the port`, async t => {
    const f = fixture(t), entry = await (await f.call('/api/library', { title: 'Owner title' })).json();
    t.mock.method(f.host, 'library', () => { throw new Error('must not reach port'); });
    for (const token of [null, foreign]) {
      const response = await f.call(`/api/library/${entry.id}${action ? `/${action}` : ''}`, body, token);
      assert.equal(response.status, token ? 404 : 401);
    }
    assert.equal(f.storage.get(entry.id).library.title, 'Owner title');
  });
}
for (const body of [undefined, { title: 'New' }]) test(`library ${body ? 'new' : 'list'} requires an owner and isolates foreign entries`, async t => {
  const f = fixture(t);
  const owned = await (await f.call('/api/library', { title: 'Owned' })).json();
  assert.equal((await f.call('/api/library', body, null)).status, 401);
  const page = await (await f.call('/api/library', undefined, foreign)).json();
  assert.equal(page.total, 0); assert.deepEqual(page.items, []);
  if (body) {
    const entry = await (await f.call('/api/library', body, foreign)).json();
    assert.notEqual(entry.id, owned.id); assert.equal((await f.call(`/api/library/${entry.id}`, undefined, owner)).status, 404);
  }
});

test('identity locks assessment and concepts, trusts only host evidence, verifies once and keeps manual pause', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}`;
  assert.equal(s.identity.status, 'guest'); assert.equal(s.identity.assessmentUnlocked, false); assert.equal(s.identified, false);
  await f.call(`${base}/turns`, { clientEventId: 'first', content: 'systems: API' }); await f.handlers.idle();
  assert.equal(f.storage.get(s.id).understanding.inputRevision, null);
  assert.equal((await f.runtime.matrix(f.storage.get(s.id))).best.analysis.reason, 'verification required');
  assert.equal((await f.runtime.matrix(f.storage.get(s.id))).best.images.reason, 'verification required');
  for (const body of [{ address: 'owner@example.test', verified: true }, { address: 'owner@example.test', role: 'company' }, { address: 'owner@example.test', actor: { status: 'verified' } }]) {
    assert.equal((await f.call(`${base}/identity/request`, body)).status, 400);
  }
  const pending = await (await f.call(`${base}/identity/request`, { address: 'owner@example.test' })).json();
  assert.equal(pending.identity.delivery, 'sent'); assert.equal(pending.identity.status, 'verification-pending');
  assert.equal(f.storage.get(s.id).identified, false);
  const message = await f.message(s.id);
  assert.equal(JSON.stringify(await (await f.call(base)).json()).includes(message.token), false);
  assert.equal(JSON.stringify(f.storage.read(s.id)).includes(message.token), false);
  await f.call(`${base}/pause`, { paused: true });
  const wrong = await (await f.call(`${base}/identity/confirm`, { token: 'wrong-token' })).json();
  assert.equal(wrong.identity.status, 'verification-pending');
  const confirmed = await (await f.call(`${base}/identity/confirm`, { token: message.token })).json();
  assert.equal(confirmed.identity.status, 'verified'); assert.equal(confirmed.identity.assessmentUnlocked, true);
  assert.equal(f.storage.get(s.id).identified, true);
  assert.equal(confirmed.identity.manualPaused, true); assert.equal(confirmed.identity.canRunAssessment, false);
  assert.equal(f.storage.get(s.id).paused, true);
  await f.call(`${base}/identity/unlock`, {}); await f.call(`${base}/identity/confirm`, { token: message.token });
  assert.equal(f.storage.read(s.id).filter(e => e.type === 'identity.unlocked').length, 1);
  await f.call(`${base}/pause`, { paused: false }); await f.handlers.idle();
  assert.equal(f.storage.get(s.id).understanding.inputRevision, inputRevision(f.storage.get(s.id)));
});

for (const verificationRequired of [false, true]) test(`host verification policy ${verificationRequired ? 'on' : 'off'} controls assessment and concepts`, async t => {
  const f = fixture(t, { verificationRequired }), s = await f.create(), base = `/api/sessions/${s.id}`;
  assert.equal(s.identity.verificationRequired, verificationRequired);
  assert.equal(s.identity.demoBypass, false); assert.equal(s.identity.status, 'guest');
  assert.equal(s.identified, false);
  assert.equal(s.identity.assessmentUnlocked, !verificationRequired);
  assert.equal(s.identity.conceptsUnlocked, !verificationRequired);
  await f.call(`${base}/turns`, { clientEventId: 'policy-turn', content: 'systems: API' }); await f.handlers.idle();
  assert.equal(f.storage.get(s.id).understanding.inputRevision === inputRevision(f.storage.get(s.id)), !verificationRequired);
  const matrix = await f.runtime.matrix(f.storage.get(s.id));
  assert.equal(matrix.best.analysis.reason === 'verification required', verificationRequired);
  assert.equal(matrix.best.images.reason === 'verification required', verificationRequired);
  await f.call(`${base}/identity/request`, { address: 'policy@example.test' });
  assert.equal((await (await f.call(`${base}/identity`)).json()).identity.assessmentUnlocked, !verificationRequired);
});

test('enabling the host lock requires an identity port that can deliver verification', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  for (const identity of [undefined, { deliversVerification: false, requestVerification() {}, verify() {} },
    { deliversVerification: true, verify() {} }]) {
    assert.throws(() => createHandlers({ storage, consent: mockConsent,
      host: { policy: { verificationRequired: true }, identity } }), /delivering identity port/u);
  }
});

test('the fifth confirmation may succeed, and malformed tokens do not consume attempts', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'budget@example.test' });
  for (const token of ['', 1, 'x'.repeat(2049)]) assert.equal((await f.call(`${base}/confirm`, { token })).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await f.call(`${base}/confirm`, { token: 'wrong' })).status, 200);
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 4);
  const response = await f.call(`${base}/confirm`, { token: (await f.message(s.id)).token });
  assert.equal(response.status, 200); assert.equal((await response.json()).identity.status, 'verified');
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 5);
});

test('concurrent confirmation guesses reserve only five durable attempts before calling the host', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'budget@example.test' });
  let calls = 0; const entered = deferred(), held = deferred();
  t.mock.method(f.host.identity, 'verify', async () => {
    calls++;
    const reserved = f.storage.hostState(s.id).identity.confirmationAttempts;
    assert.ok(reserved > 0 && reserved <= 5);
    if (calls === 5) entered.resolve();
    await held.promise; return { verified: false };
  });
  const guesses = Array.from({ length: 12 }, (_, i) => f.call(`${base}/confirm`, { token: `guess-${i}` }));
  await entered.promise;
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 5);
  const blocked = await f.call(`${base}/confirm`, { token: (await f.message(s.id)).token });
  assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error, 'confirmation-rate-limit');
  held.resolve();
  const responses = await Promise.all(guesses);
  assert.equal(responses.filter(r => r.status === 200).length, 5);
  assert.equal(responses.filter(r => r.status === 429).length, 7);
  assert.equal(calls, 5); assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 5);
  const before = f.storage.read(s.id).length;
  assert.equal((await f.call(`${base}/confirm`, { token: 'still-blocked' })).status, 429);
  assert.equal(f.storage.read(s.id).length, before);
  assert.equal((await f.call(`${base}/resend`, {})).status, 429);
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 5);
  f.at(1_100); await f.call(`${base}/resend`, {});
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 0);
  assert.equal((await f.call(`${base}/confirm`, { token: 'new-revision-guess' })).status, 200);
  assert.equal(calls, 6);
});

test('confirmation lockout survives restart and an interrupted host call still consumes its attempt', async t => {
  const db = await temporaryDb(), f = fixture(t, { storage: new SQLiteStorage(db) }), s = await f.create();
  const base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'restart-budget@example.test' });
  for (let i = 0; i < 4; i++) await f.call(`${base}/confirm`, { token: 'wrong' });
  const entered = deferred();
  t.mock.method(f.host.identity, 'verify', () => { entered.resolve(); return new Promise(() => {}); });
  const pending = f.call(`${base}/confirm`, { token: 'interrupted' }); await entered.promise;
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 5);
  await f.handlers.close(); assert.equal((await pending).status, 503); await f.close();
  const reopened = fixture(t, { storage: new SQLiteStorage(db) }); await reopened.handlers.resume();
  let calls = 0;
  t.mock.method(reopened.host.identity, 'verify', () => { calls++; return { verified: false }; });
  const before = reopened.storage.read(s.id).length;
  assert.equal((await reopened.call(`${base}/confirm`, { token: 'after-restart' })).status, 429);
  assert.equal(calls, 0); assert.equal(reopened.storage.read(s.id).length, before);
  reopened.at(1_100); await reopened.call(`${base}/resend`, {});
  assert.equal((await reopened.call(`${base}/confirm`, { token: 'renewed' })).status, 200);
  assert.equal(calls, 1);
});

test('a failed confirmation reservation rolls back without sending a token to the host', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'rollback-attempt@example.test' });
  const before = f.storage.hostState(s.id), lengthBefore = f.storage.read(s.id).length;
  let calls = 0; t.mock.method(f.host.identity, 'verify', () => { calls++; return { verified: false }; });
  f.storage.db.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='identity.state' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.equal((await f.call(`${base}/confirm`, { token: 'guess' })).status, 500);
  assert.equal(calls, 0); assert.deepEqual(f.storage.hostState(s.id), before);
  assert.equal(f.storage.read(s.id).length, lengthBefore);
});

test('an asynchronous confirmation for an old revision cannot unlock a replacement request or spend its budget', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'old-revision@example.test' });
  const entered = deferred(), held = deferred();
  t.mock.method(f.host.identity, 'verify', async args => {
    entered.resolve(); await held.promise;
    return { verified: true, address: args.address, revision: args.revision };
  });
  const pending = f.call(`${base}/confirm`, { token: 'old-link' }); await entered.promise;
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 1);
  f.at(1_100); await f.call(`${base}/resend`, {});
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 0);
  const lengthBefore = f.storage.read(s.id).length;
  held.resolve(); const response = await pending;
  assert.equal((await response.json()).identity.status, 'verification-pending');
  assert.equal(f.storage.hostState(s.id).identity.confirmationAttempts, 0);
  assert.equal(f.storage.read(s.id).length, lengthBefore);
});

test('identity and credits GETs never write, and unchanged unlock polls leave the journal and content length unchanged', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}`;
  await f.call(`${base}/identity/request`, { address: 'polling@example.test' });
  const countContent = () => f.storage.db.prepare('SELECT COUNT(*) AS n FROM content WHERE session_id=?').get(s.id).n;
  const before = f.storage.read(s.id).length, contentBefore = countContent();
  const hostBefore = f.storage.hostState(s.id), sessionBefore = f.storage.get(s.id);
  assert.equal(f.storage.ownerCreditState(owner), null);
  for (let i = 1; i <= 10; i++) {
    f.at(1_000 + i);
    assert.equal((await f.call(`${base}/identity`)).status, 200);
    assert.equal((await f.call(`${base}/credits`)).status, 200);
  }
  assert.deepEqual(f.storage.hostState(s.id), hostBefore); assert.deepEqual(f.storage.get(s.id), sessionBefore);
  assert.equal(f.storage.ownerCreditState(owner), null);
  for (let i = 11; i <= 20; i++) {
    f.at(1_000 + i); assert.equal((await f.call(`${base}/identity/unlock`, {})).status, 200);
  }
  assert.equal(f.storage.read(s.id).length, before); assert.equal(countContent(), contentBefore);
  f.at(1_500);
  assert.equal((await (await f.call(`${base}/identity`)).json()).identity.expired, true);
  assert.equal(f.storage.read(s.id).length, before);
  await f.call(`${base}/identity/unlock`, {});
  assert.equal(f.storage.read(s.id).length, before + 1);
  await f.call(`${base}/identity/unlock`, {});
  assert.equal(f.storage.read(s.id).length, before + 1); assert.equal(countContent(), contentBefore + 1);
});

test('pre-B1 sessions stay unlocked across restart and their first identity and credits GETs are read-only', async t => {
  const db = await temporaryDb(), storage = new SQLiteStorage(db);
  const old = storage.create({ ownerToken: owner, demo: true }); storage.close();
  const f = fixture(t, { storage: new SQLiteStorage(db) }), base = `/api/sessions/${old.id}`;
  for (const action of ['identity', 'credits', 'identity', 'credits']) assert.equal((await f.call(`${base}/${action}`)).status, 200);
  assert.equal(f.storage.hostState(old.id), null); assert.equal(f.storage.ownerCreditState(owner), null);
  assert.equal(f.storage.read(old.id).length, 1);
  await f.handlers.resume();
  const resumed = await (await f.call(base)).json();
  assert.equal(resumed.identity.verificationRequired, false); assert.equal(resumed.identity.assessmentUnlocked, true);
  assert.equal(resumed.identity.conceptsUnlocked, true);
  await f.call(`${base}/turns`, { clientEventId: 'old-session', content: 'systems: API' }); await f.handlers.idle();
  assert.equal(f.storage.get(old.id).understanding.inputRevision, inputRevision(f.storage.get(old.id)));
  assert.equal((await f.create()).identity.verificationRequired, true);
});

for (const keepIdentity of [false, true]) for (const status of ['guest', 'verification-pending']) {
  test(`AIT-392: ${status} resumes without privacy after policy removal (identity: ${keepIdentity})`, async t => {
    const storage = new SQLiteStorage();
    const identity = {
      deliversVerification: true,
      requestVerification: async () => ({ status: 'sent' }),
      verify: async () => ({ verified: false }),
    };
    const mount = host => createHandlers({ storage, consent: mockConsent,
      pluginRuntime: createPluginRuntime({ storage, consent: mockConsent }), host });
    let handlers = mount({ now: () => 1_000, privacyDocumentConfigured: () => true,
      policy: { verificationRequired: true }, identity });
    t.after(async () => { await handlers.close(); storage.close(); });
    const call = (path, body, token = owner) => handlers.handle(new Request(`http://local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-aithema-session-token': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const created = await call('/api/sessions', {});
    assert.equal(created.status, 201);
    const s = await created.json(), base = `/api/sessions/${s.id}`;
    if (status === 'verification-pending') {
      assert.equal((await call(`${base}/identity/request`, { address: 'rollback@example.test' })).status, 200);
    }
    assert.equal((await call(`${base}/pause`, { paused: true })).status, 200);
    const before = storage.hostState(s.id).identity, seq = storage.get(s.id).seq;
    assert.equal(before.status, status);
    assert.equal(before.verificationRequired, true);
    assert.equal(storage.get(s.id).identity.assessmentUnlocked, false);
    await handlers.close();
    // Keep the same in-memory database while rolling back the host configuration.
    handlers = mount({ now: () => 1_000, ...(keepIdentity ? { identity } : {}) });
    await handlers.resume();
    await handlers.idle();
    assert.deepEqual(storage.hostState(s.id).identity, { ...before, verificationRequired: false });
    const response = await call(base);
    assert.equal(response.status, 200);
    const resumed = await response.json();
    assert.equal(resumed.identity.verificationRequired, false);
    assert.equal(resumed.identity.assessmentUnlocked, true);
    assert.equal(resumed.identity.conceptsUnlocked, true);
    assert.equal(resumed.identity.canRunAssessment, false);
    assert.equal(resumed.paused, true);
    const events = storage.read(s.id, seq);
    assert.deepEqual(events.map(event => event.type), ['identity.policy-changed', 'identity.state']);
    assert.deepEqual(events[0].data, { verificationRequired: false, reason: 'host-policy-disabled' });
    await handlers.resume();
    assert.equal(storage.get(s.id).seq, seq + 2);
    assert.equal((await call(base, undefined, foreign)).status, 404);
    for (const address of ['rollback@example.test', 'new@example.test']) {
      const denied = await call(`${base}/identity/request`, { address });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: 'privacy-document-required' });
    }
    assert.equal(storage.get(s.id).seq, seq + 2);
    if (status === 'verification-pending') {
      // A normal transition retaining an address still needs privacy permission.
      const denied = await call(`${base}/pause`, { paused: false });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: 'privacy-document-required' });
      assert.deepEqual(storage.hostState(s.id).identity, { ...before, verificationRequired: false });
    }
  });
}

for (const status of ['guest', 'verification-pending', 'verified']) test(`live adoption removes the demo lock for ${status} with a durable policy change`, async t => {
  const db = await temporaryDb(), f = fixture(t, { storage: new SQLiteStorage(db) }), s = await f.create();
  const base = `/api/sessions/${s.id}`;
  if (status !== 'guest') {
    await f.call(`${base}/identity/request`, { address: 'adopt@example.test' });
    await f.call(`${base}/identity/confirm`, { token: status === 'verified' ? (await f.message(s.id)).token : 'wrong' });
  }
  await f.call(`${base}/pause`, { paused: true });
  const before = f.storage.hostState(s.id).identity, seq = f.storage.get(s.id).seq;
  assert.equal(before.status, status); assert.equal(before.verificationRequired, true);
  await f.close();
  const live = fixture(t, { storage: new SQLiteStorage(db), demo: false });
  live.host.privacyDocumentConfigured = () => true;
  for (const action of ['identity', 'credits']) assert.equal((await live.call(`${base}/${action}`)).status, 200);
  assert.deepEqual(live.storage.hostState(s.id).identity, before);
  assert.equal(live.storage.get(s.id).seq, seq);
  await live.handlers.resume(); await live.handlers.idle();
  const adopted = live.storage.hostState(s.id).identity, session = live.storage.get(s.id);
  assert.deepEqual(adopted, { ...before, verificationRequired: false });
  assert.equal(session.identity.assessmentUnlocked, true); assert.equal(session.identity.conceptsUnlocked, true);
  assert.equal(session.identity.canRunAssessment, false); assert.equal(session.paused, true);
  assert.equal(session.identified, status === 'verified');
  const change = live.storage.read(s.id, seq);
  assert.deepEqual(change.map(e => e.type), ['identity.policy-changed', 'identity.state']);
  assert.deepEqual(change[0].data, { verificationRequired: false, reason: 'host-policy-disabled' });
  const replay = live.storage.read(s.id).reduce(applyEvent, createSession({ id: s.id, demo: true }));
  assert.deepEqual(replay.identity, session.identity); assert.equal(inputRevision(replay), inputRevision(session));
  await live.handlers.resume();
  assert.equal(live.storage.get(s.id).seq, seq + 2);
  assert.equal((await live.call(`${base}/demo/outbox`)).status, 404);
  await live.call(`${base}/pause`, { paused: false });
  assert.equal(live.storage.get(s.id).identity.canRunAssessment, true);
  await live.close();
  const restarted = fixture(t, { storage: new SQLiteStorage(db) });
  await restarted.handlers.resume();
  assert.equal(restarted.storage.get(s.id).identity.verificationRequired, false);
  assert.equal((await restarted.create()).identity.verificationRequired, true);
});

test('resend and address changes keep the host cooldown; stale and expired links cannot unlock', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'first@example.test' }); const first = await f.message(s.id);
  assert.equal((await f.call(`${base}/resend`, {})).status, 429);
  const changed = await f.call(`${base}/change`, { address: 'second@example.test' }); assert.equal(changed.status, 429);
  const state = (await changed.json()).identity;
  assert.equal(state.address, 'second@example.test'); assert.equal(state.delivery, 'idle'); assert.equal(state.pollVerification, false);
  const stale = await (await f.call(`${base}/confirm`, { token: first.token })).json(); assert.equal(stale.identity.status, 'verification-pending');
  f.at(1_100); assert.equal((await f.call(`${base}/resend`, {})).status, 200);
  const second = await f.message(s.id); assert.notEqual(second.revision, first.revision);
  f.at(1_600);
  const expired = await (await f.call(`${base}/confirm`, { token: second.token })).json();
  assert.equal(expired.identity.status, 'verification-pending'); assert.equal(expired.identity.expired, true);
  await f.call(`${base}/resend`, {}); const renewed = await f.message(s.id);
  const confirmed = await (await f.call(`${base}/confirm`, { token: renewed.token })).json(); assert.equal(confirmed.identity.status, 'verified');
  const relocked = await (await f.call(`${base}/request`, { address: 'third@example.test' })).json();
  assert.equal(relocked.identity.assessmentUnlocked, false);
});

test('polling accepts authoritative host confirmation, preserves pause and ignores a stale asynchronous reply', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/identity`;
  await f.call(`${base}/request`, { address: 'first@example.test' }); const first = await f.message(s.id);
  const entered = deferred(), held = deferred();
  t.mock.method(f.host.identity, 'verify', async args => { entered.resolve(); await held.promise; return { verified: true, address: args.address, revision: args.revision }; });
  const polling = f.call(`${base}/unlock`, {}); await entered.promise;
  await f.call(`${base}/change`, { address: 'second@example.test' }); held.resolve();
  assert.equal((await (await polling).json()).identity.status, 'verification-pending');
  f.at(1_100); await f.call(`${base}/resend`, {});
  await f.call(`/api/sessions/${s.id}/pause`, { paused: true });
  const unlocked = await (await f.call(`${base}/unlock`, {})).json();
  assert.equal(unlocked.identity.status, 'verified'); assert.equal(unlocked.identity.manualPaused, true);
  assert.notEqual(unlocked.identity.verificationRevision, first.revision);
});

test('late mail replies and interrupted host delivery cannot revive erased sessions', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}`;
  const entered = deferred(), held = deferred();
  t.mock.method(f.host.identity, 'requestVerification', async () => { entered.resolve(); await held.promise; return { status: 'sent' }; });
  const sending = f.call(`${base}/identity/request`, { address: 'owner@example.test' }); await entered.promise;
  assert.equal((await f.call(`${base}/erase`, {})).status, 200); held.resolve();
  assert.equal((await sending).status, 404); assert.equal(f.storage.hostState(s.id), null);
  assert.equal(f.storage.get(s.id).identity, null);
});

test('library CRUD searches literal text, pages, copies locale and preset on reset and erases content and host state', async t => {
  const presets = mockPresets(); presets.custom = structuredClone(presets.best);
  const f = fixture(t, { presets });
  const a = await (await f.call('/api/library', { title: '50% alpha', locale: 'de' })).json();
  f.at(1_001); const b = await (await f.call('/api/library', { title: 'beta_under', locale: 'de', processingPreset: 'custom' })).json();
  let page = await (await f.call('/api/library?search=%25&offset=0&limit=1')).json(); assert.equal(page.total, 1); assert.equal(page.items[0].id, a.id);
  page = await (await f.call('/api/library?search=_&offset=0&limit=1')).json(); assert.equal(page.total, 1); assert.equal(page.items[0].id, b.id);
  const firstPage = await (await f.call('/api/library?limit=1')).json(), secondPage = await (await f.call('/api/library?offset=1&limit=1')).json();
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id); assert.equal(firstPage.total, 2);
  const renamed = await (await f.call(`/api/library/${a.id}/rename`, { title: 'Renamed' })).json(); assert.equal(renamed.revision, 2);
  assert.equal((await (await f.call('/api/library?search=RENAMED')).json()).total, 1);
  await f.call(`/api/sessions/${a.id}/identity/request`, { address: 'erase@example.test' });
  await f.call(`/api/sessions/${a.id}/turns`, { clientEventId: 'erase-turn', content: 'erase this personal text' }); await f.handlers.idle();
  assert.equal((await f.call(`/api/library/${a.id}/delete`, {})).status, 200);
  assert.equal((await f.call(`/api/library/${a.id}`)).status, 404); assert.equal(f.storage.hostState(a.id), null);
  const persistent = JSON.stringify(f.storage.db.prepare('SELECT * FROM content WHERE session_id=?').all(a.id)) + JSON.stringify(f.storage.read(a.id)) + JSON.stringify(f.storage.get(a.id));
  for (const text of ['erase@example.test', 'erase this personal text', 'Renamed', '50% alpha']) assert.equal(persistent.includes(text), false, text);
  const reset = await f.call(`/api/library/${b.id}/reset`, {}); assert.equal(reset.status, 201);
  const replacement = await reset.json(); assert.notEqual(replacement.id, b.id); assert.equal(replacement.title, ''); assert.deepEqual(replacement.session.transcript, []);
  assert.equal(replacement.session.locale, 'de'); assert.equal(replacement.session.processingPreset, 'custom');
  assert.equal((await f.call(`/api/library/${b.id}`)).status, 404);
  assert.equal((await (await f.call('/api/library')).json()).total, 1);
});

test('AIT-295: library delete completes host erase before retirement', async t => {
  const f = fixture(t), session = await (await f.call('/api/library', { title: 'Ordered cleanup' })).json();
  const entered = deferred(), finish = deferred(), order = [];
  const erased = f.host.erased.bind(f.host), retired = f.host.retired.bind(f.host);
  let eraseCalls = 0;
  t.mock.method(f.host, 'erased', async info => {
    // The demo library calls erased again after its core erase callback.
    // Hold that second call; retired also replays erased idempotently.
    if (++eraseCalls !== 2) return erased(info);
    order.push('erase started'); entered.resolve(); await finish.promise;
    await erased(info); order.push('erase finished');
  });
  t.mock.method(f.host, 'retired', async info => { order.push('retired'); await retired(info); });
  const deleting = f.call(`/api/library/${session.id}/delete`, {});
  try {
    await entered.promise;
    assert.deepEqual(f.storage.pendingRetirements(10), []);
    assert.deepEqual(await f.handlers.retire({ before: 0 }), { retired: 0, failed: 0, more: false });
    assert.deepEqual(order, ['erase started']);
  } finally { finish.resolve(); }
  assert.equal((await deleting).status, 200);
  assert.deepEqual(await f.handlers.retire({ before: 0 }), { retired: 1, failed: 0, more: false });
  assert.deepEqual(order, ['erase started', 'erase finished', 'retired']);
});

test('AIT-297: HTTP visitor erase holds all owned tombstones until sibling cleanup finishes, then releases them', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create();
  const survivor = f.storage.create({ ownerToken: foreign });
  const entered = deferred(), finish = deferred();
  const erased = f.host.erased.bind(f.host);
  t.mock.method(f.host, 'erased', async info => {
    if (info.sessionId === second.id) { entered.resolve(); await finish.promise; }
    return erased(info);
  });
  const deleting = f.call('/api/visitor/erase', {});
  try {
    await entered.promise;
    assert.ok(f.storage.get(first.id).tombstone);
    assert.ok(f.storage.get(second.id).tombstone);
    assert.deepEqual(f.storage.pendingRetirements(10), [], 'even the finished sibling stays held through the HTTP request');
    assert.deepEqual(await f.handlers.retire({ before: 0 }), { retired: 0, failed: 0, more: false });
    assert.equal(f.storage.get(survivor.id).tombstone, null);
  } finally { finish.resolve(); }
  assert.equal((await deleting).status, 200);
  assert.deepEqual(new Set(f.storage.pendingRetirements(10)), new Set([first.id, second.id]));
  assert.deepEqual(await f.handlers.retire({ before: 0 }), { retired: 2, failed: 0, more: false });
  for (const id of [first.id, second.id]) assert.throws(() => f.storage.get(id), /not found/i);
  assert.equal(f.storage.get(survivor.id).tombstone, null);
});

test('AIT-295: library delete is fully retired by a sweep past 24h', async t => {
  const f = fixture(t), session = await (await f.call('/api/library', { title: 'Delete completely' })).json();
  f.storage.postTurn(session.id, 'private', Buffer.from('private'), 'private conversation');
  assert.equal((await f.call(`/api/library/${session.id}/delete`, {})).status, 200);
  const day = 24 * 60 * 60 * 1000, sweepAt = Date.now() + day + 1;
  assert.deepEqual(await f.handlers.retire({ before: sweepAt - day }), { retired: 1, failed: 0, more: false });
  assert.throws(() => f.storage.get(session.id), /not found/i);
  for (const { name } of f.storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (f.storage.db.prepare(`PRAGMA table_info("${name}")`).all().some(column => column.name === 'session_id')) {
      assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE session_id=?`).get(session.id).n, 0, name);
    }
  }
});

test('library deletion acknowledges only after cancellation; host port erasure failures remain retryable', async t => {
  const f = fixture(t), entry = await (await f.call('/api/library', { title: 'Keep until erased' })).json();
  const erased = f.storage.erase.bind(f.storage); let failures = 1;
  t.mock.method(f.storage, 'erase', (...args) => { if (failures-- > 0) throw new Error('storage unavailable'); return erased(...args); });
  assert.equal((await f.call(`/api/library/${entry.id}/delete`, {})).status, 500);
  assert.equal((await f.call(`/api/library/${entry.id}`)).status, 200);
  assert.equal((await f.call(`/api/library/${entry.id}/delete`, {})).status, 200);
  assert.equal(f.storage.get(entry.id).tombstone !== null, true);
});

test('handover retries failures with a stable key, joins concurrent delivery and never sends a successful revision again', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}/handover`;
  assert.equal((await f.call(`${base}/retry`, {})).status, 200);
  f.host.sink.failNext();
  const failed = await (await f.call(base, {})).json(); assert.equal(failed.handover.status, 'failed'); assert.equal(failed.handover.canRetry, true);
  const result = await Promise.all([f.call(`${base}/retry`, {}), f.call(`${base}/retry`, {})]);
  const views = await Promise.all(result.map(r => r.json())); assert.equal(views[0].handover.status, 'sent'); assert.deepEqual(views[0], views[1]);
  assert.equal(views[0].handover.idempotencyKey, failed.handover.idempotencyKey); assert.equal(f.host.sink.deliveryCount(), 2);
  await f.call(base, {}); await f.call(`${base}/retry`, {}); assert.equal(f.host.sink.deliveryCount(), 2);
  const states = f.storage.read(s.id).filter(e => e.type === 'handover.state');
  assert.deepEqual(states.map(e => e.data.status), ['idle', 'preparing', 'failed', 'preparing', 'sent']);
  assert.equal(JSON.stringify(states).includes('owner@example.test'), false);
});

test('host state survives restart, recovers interrupted handover and replays through the durable journal', async t => {
  const db = await temporaryDb(), storage = new SQLiteStorage(db);
  const f = fixture(t, { storage }), s = await f.create();
  await f.call(`/api/sessions/${s.id}/identity/request`, { address: 'restart@example.test' });
  await f.call(`/api/sessions/${s.id}/pause`, { paused: true });
  storage.transitionHost(s.id, state => {
    const result = reduceHandover(createHandover({ sessionId: s.id }), { type: 'request', revision: 'before-restart' });
    return { state: { ...state, handover: result.state }, events: result.events };
  }, { ownerToken: owner });
  await f.close();
  const reopened = new SQLiteStorage(db), host = createDemoHost({ storage: reopened, demoBypass: false, now: () => 1_001 });
  const handlers = createHandlers({ storage: reopened, consent: mockConsent, host });
  t.after(async () => { await handlers.close(); reopened.close(); });
  await handlers.resume();
  const restored = reopened.get(s.id); assert.equal(restored.identity.address, 'restart@example.test'); assert.equal(restored.identity.manualPaused, true);
  assert.equal(restored.handover.status, 'failed'); assert.equal(restored.handover.error, 'delivery-interrupted');
  const events = reopened.read(s.id), replay = events.reduce(applyEvent, createSession({ id: s.id, demo: true }));
  assert.deepEqual(replay.identity, restored.identity); assert.deepEqual(replay.handover, restored.handover);
  const response = await handlers.handle(new Request(`http://local/api/sessions/${s.id}/events`, { headers: { 'x-aithema-session-token': owner } }));
  const streamed = await readEvents(response, events.length); assert.deepEqual(streamed.slice(0, events.length), events);
});

test('credits reads owner and ledger amounts on the server; new/reset get a fresh conversation guard without exposing foreign spend', async t => {
  const f = fixture(t, { demoBypass: true, durationMs: 200 }), s = await f.create();
  const before = await (await f.call(`/api/sessions/${s.id}/credits`)).json();
  assert.equal(before.balance.owner.availableMicro, 10_000_000); assert.equal(before.limitSlot.remainingMs, null);
  await f.call(`/api/sessions/${s.id}/turns`, { clientEventId: 'start', content: 'Hi' }); await f.handlers.idle();
  const request = { sessionId: s.id, lane: 'reaction', maxMicro: 123, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) };
  f.runtime.budget.admit(request);
  const foreignSession = f.storage.create({ ownerToken: foreign }); f.runtime.budget.admit({ ...request, sessionId: foreignSession.id, maxMicro: 456 });
  let view = await (await f.call(`/api/sessions/${s.id}/credits`)).json();
  assert.equal(view.balance.session.committedMicro, 123); assert.equal(view.balance.owner.committedMicro, 123); assert.equal(view.limitSlot.remainingMs, 200);
  await f.call(`/api/sessions/${s.id}/pause`, { paused: true });
  view = await (await f.call(`/api/sessions/${s.id}/credits`)).json(); assert.equal(view.limitSlot.canStartPaidWork, false);
  f.at(1_150);
  const reset = await (await f.call(`/api/library/${s.id}/reset`, {})).json();
  view = await (await f.call(`/api/sessions/${reset.id}/credits`)).json(); assert.equal(view.limitSlot.remainingMs, null); assert.equal(view.balance.owner.committedMicro, 123);
  assert.equal(reset.session.paused, true); assert.equal(view.limitSlot.canStartPaidWork, false);
  const pausedNew = await f.create(); assert.equal(pausedNew.paused, true);
  assert.equal((await (await f.call(`/api/sessions/${pausedNew.id}/credits`)).json()).limitSlot.remainingMs, null);
  await f.call(`/api/sessions/${reset.id}/turns`, { clientEventId: 'reset-start', content: 'New conversation' }); await f.handlers.idle();
  f.at(1_350);
  const lengthBefore = f.storage.read(reset.id).length, guardBefore = f.storage.creditState(reset.id);
  view = await (await f.call(`/api/sessions/${reset.id}/credits`)).json(); assert.equal(view.limitSlot.status, 'ending'); assert.equal(view.limitSlot.endReason, 'one-hour');
  for (let i = 0; i < 10; i++) await f.call(`/api/sessions/${reset.id}/credits`);
  assert.equal(f.storage.read(reset.id).length, lengthBefore); assert.deepEqual(f.storage.creditState(reset.id), guardBefore);
  await f.call(`/api/sessions/${reset.id}/pause`, { paused: false });
  const next = await f.create(); assert.equal(next.paused, false); view = await (await f.call(`/api/sessions/${next.id}/credits`)).json(); assert.equal(view.limitSlot.status, 'ready'); assert.equal(view.limitSlot.remainingMs, null);
});

test('configured provider mode has no outbox or verification lock and retains export', async t => {
  const f = fixture(t, { demo: false, demoBypass: false }), s = await f.create();
  assert.equal(s.identity.verificationRequired, false); assert.equal(s.identity.assessmentUnlocked, true);
  assert.notEqual(s.featureMatrix.best.analysis.reason, 'verification required');
  assert.equal((await f.call(`/api/sessions/${s.id}/demo/outbox`)).status, 404);
  assert.equal((await f.call(`/api/sessions/${s.id}/demo/outbox`, undefined, foreign)).status, 404);
  const archive = await f.call(`/api/sessions/${s.id}/export`); assert.equal(archive.status, 200);
  assert.ok(unzip(await archive.arrayBuffer())['transcript.json']);
});

test('malformed host commands, method mismatches and paging fail without mutating state', async t => {
  const f = fixture(t), s = await f.create();
  for (const [path, body] of [
    [`/api/sessions/${s.id}/identity/request`, { address: 'not-an-address' }],
    [`/api/sessions/${s.id}/identity/confirm`, { token: '' }],
    [`/api/sessions/${s.id}/identity/resend`, { verified: true }],
    [`/api/sessions/${s.id}/handover`, { revision: 'client-chosen' }],
    [`/api/library/${s.id}/rename`, { title: 'x'.repeat(201) }],
    ['/api/library', { actor: 'agency' }],
  ]) assert.equal((await f.call(path, body)).status, 400, path);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=NaN']) assert.equal((await f.call(`/api/library?${query}`)).status, 400);
  for (const path of [`/api/sessions/${s.id}/credits`, `/api/sessions/${s.id}/demo/outbox`, `/api/library/${s.id}`]) assert.equal((await f.call(path, {}, owner)).status, 405);
});

test('concurrent handover requests join after an asynchronous offer and publish preparing before dispatch', async t => {
  const f = fixture(t), s = await f.create(), entered = deferred(), held = deferred();
  const port = f.host.handover(owner), deliver = port.deliver;
  t.mock.method(f.host, 'handover', () => ({
    ...port, async offer() { await Promise.resolve(); return { available: true }; },
    async deliver(request) {
      assert.equal(f.storage.get(s.id).handover.status, 'preparing'); entered.resolve(); await held.promise;
      return deliver(request);
    },
  }));
  const first = f.call(`/api/sessions/${s.id}/handover`, {}), second = f.call(`/api/sessions/${s.id}/handover`, {});
  await entered.promise;
  assert.equal((await f.call(`/api/sessions/${s.id}/handover`, {}, foreign)).status, 404);
  held.resolve();
  const result = await Promise.all([first, second]); const views = await Promise.all(result.map(r => r.json()));
  assert.equal(views[0].handover.status, 'sent'); assert.deepEqual(views[0], views[1]); assert.equal(f.host.sink.deliveryCount(), 1);
});

test('host state and events roll back together when the durable journal refuses a transition', async t => {
  const f = fixture(t), s = await f.create(), before = f.storage.hostState(s.id);
  f.storage.db.exec("CREATE TRIGGER reject_host BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='identity.state' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  const response = await f.call(`/api/sessions/${s.id}/identity/request`, { address: 'rollback@example.test' });
  assert.equal(response.status, 500); assert.deepEqual(f.storage.hostState(s.id), before); assert.equal((await f.message(s.id)), undefined);
  assert.equal(f.storage.read(s.id).some(e => e.type === 'verification.requested'), false);
});

test('mail failure remains pending and is retryable at the configured boundary; shutdown bounds an unresponsive host', async t => {
  const f = fixture(t), s = await f.create();
  t.mock.method(f.host.identity, 'requestVerification', () => { throw new Error('private mail error'); });
  const failed = await (await f.call(`/api/sessions/${s.id}/identity/request`, { address: 'owner@example.test' })).json();
  assert.equal(failed.identity.status, 'verification-pending'); assert.equal(failed.identity.delivery, 'failed');
  assert.equal(JSON.stringify(failed).includes('private mail error'), false);
  assert.equal((await f.call(`/api/sessions/${s.id}/identity/resend`, {})).status, 429);
  f.at(1_100); const entered = deferred();
  t.mock.method(f.host.identity, 'requestVerification', () => { entered.resolve(); return new Promise(() => {}); });
  const pending = f.call(`/api/sessions/${s.id}/identity/resend`, {}); await entered.promise;
  await f.handlers.close(); assert.equal((await pending).status, 503);
  assert.equal(f.storage.hostState(s.id).identity.delivery, 'requested');
});

test('identity ownership is rechecked after a held confirmation and malformed evidence fails closed', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}`;
  await f.call(`${base}/identity/request`, { address: 'owner@example.test' });
  t.mock.method(f.host.identity, 'verify', () => ({ verified: true, revision: 999, address: 'other@example.test' }));
  assert.equal((await (await f.call(`${base}/identity/unlock`, {})).json()).identity.assessmentUnlocked, false);
  const entered = deferred(), held = deferred();
  t.mock.method(f.host.identity, 'verify', async args => { entered.resolve(); await held.promise; return { verified: true, address: args.address, revision: args.revision }; });
  const pending = f.call(`${base}/identity/unlock`, {}); await entered.promise;
  await f.call(`${base}/erase`, {}); held.resolve();
  assert.equal((await pending).status, 404); assert.equal(f.storage.get(s.id).identity, null);
});

test('verified identity erasure keeps replay revisions stable while removing addresses and title bytes', async t => {
  const f = fixture(t), s = await f.create(), base = `/api/sessions/${s.id}`;
  await f.call(`${base}/identity/request`, { address: 'erased@example.test' });
  await f.call(`${base}/identity/confirm`, { token: (await f.message(s.id)).token });
  await f.call(`${base}/identity/change`, { address: 'changed@example.test' });
  f.at(1_100); await f.call(`${base}/identity/resend`, {});
  await f.call(`${base}/identity/confirm`, { token: (await f.message(s.id)).token });
  await f.call(`${base}/erase`, {});
  const replay = f.storage.read(s.id).reduce(applyEvent, createSession({ id: s.id, demo: true }));
  assert.equal(inputRevision(replay), inputRevision(f.storage.get(s.id))); assert.equal(replay.identity, null);
  const persistent = JSON.stringify(f.storage.read(s.id)); assert.equal(persistent.includes('erased@example.test'), false); assert.equal(persistent.includes('changed@example.test'), false);
});

test('AIT-405: a throwing tier display callback cannot strand a saved and broadcast turn', async t => {
  const f = fixture(t, { demoBypass: true }), session = await f.create();
  const tiers = t.mock.method(f.host, 'creditTiers', () => { throw new Error('tier display unavailable'); });
  const abort = new AbortController();
  const stream = await f.handlers.handle(new Request(`http://local/api/sessions/${session.id}/events?after=${f.storage.get(session.id).seq}`, {
    headers: { 'x-aithema-session-token': owner }, signal: abort.signal,
  }));
  const response = await f.call(`/api/sessions/${session.id}/turns`, { clientEventId: 'tier-failure', content: 'systems: API' });
  await f.handlers.idle();
  abort.abort();
  const events = await readEvents(stream, Infinity);
  assert.equal(events.some(event => event.type === 'turn.final' && event.data.id === 'tier-failure'), true);
  assert.equal(response.status, 200);
  assert.equal(tiers.mock.callCount(), 0, 'tier display has no role in initial admission');
  assert.equal(f.storage.get(session.id).transcript.some(turn => turn.role === 'assistant'), true, 'the saved turn reaches the reply lane');
  assert.equal(f.storage.get(session.id).understanding.inputRevision, inputRevision(f.storage.get(session.id)));
});

const creditCallbackErrors = [Error, TypeError, RangeError, SyntaxError].map(ErrorType => [ErrorType.name, () => new ErrorType('private host diagnostic')]);
for (const code of ['not-admitted', 'rate-limit', 'provider-error']) creditCallbackErrors.push([`PluginError ${code}`, () => new PluginError(code, 'host-limit')]);
for (const [label, makeError] of creditCallbackErrors)
for (const failure of ['wallet', 'balance']) test(`AIT-405/AIT-407: throwing ${failure} (${label}) fails closed before saving or broadcasting a turn`, async t => {
  const f = fixture(t, { demoBypass: true }), session = await f.create();
  const before = f.storage.get(session.id), journal = f.storage.read(session.id);
  const abort = new AbortController();
  const stream = await f.handlers.handle(new Request(`http://local/api/sessions/${session.id}/events?after=${before.seq}`, {
    headers: { 'x-aithema-session-token': owner }, signal: abort.signal,
  }));
  const wallet = f.host.wallet;
  const broken = t.mock.method(f.host, 'wallet', (token, context) => {
    if (failure === 'wallet') throw makeError();
    return Object.create(wallet(token, context), { balance: { value: () => { throw makeError(); } } });
  });
  const body = { clientEventId: 'wallet-failure', content: 'systems: API' };
  const response = await f.call(`/api/sessions/${session.id}/turns`, body);
  await f.handlers.idle();
  abort.abort();
  const events = await readEvents(stream, Infinity);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'server-error' }, 'host diagnostics never blame the request or leak to the visitor');
  assert.deepEqual(f.storage.get(session.id), before, 'failed credit reads leave no saved turn or partial credit state');
  assert.deepEqual(f.storage.read(session.id), journal);
  assert.equal(events.some(event => event.type === 'turn.final'), false, 'failed credit reads never broadcast a turn');
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0, 'no paid attempt without credit limits');
  broken.mock.restore();
  assert.equal((await f.call(`/api/sessions/${session.id}/turns`, body)).status, 200, 'the same client event can be retried after recovery');
  await f.handlers.idle();
  assert.equal(f.storage.get(session.id).transcript.filter(turn => turn.id === body.clientEventId).length, 1);
  assert.equal(f.storage.get(session.id).transcript.some(turn => turn.role === 'assistant'), true);
  const replayWallet = t.mock.method(f.host, 'wallet', () => { throw new Error('wallet unavailable again'); });
  assert.equal((await f.call(`/api/sessions/${session.id}/turns`, body)).status, 200, 'receipted retries bypass credit preflight');
  assert.equal(replayWallet.mock.callCount(), 0);
});

test('AIT-407: invalid turn requests retain 400/413 before host credit callbacks', async t => {
  const f = fixture(t, { demoBypass: true }), session = await f.create();
  const before = f.storage.get(session.id), journal = f.storage.read(session.id);
  const wallet = t.mock.method(f.host, 'wallet', () => { throw new TypeError('host must not be called'); });
  for (const [body, status, error] of [
    ['{', 400, 'invalid-request'],
    [JSON.stringify({ clientEventId: 'invalid', content: '' }), 400, 'invalid-turn'],
    [JSON.stringify({ clientEventId: 'metadata', content: 'valid', padding: 'p'.repeat(32_768) }), 413, 'size-limit'],
    [' '.repeat(65_537), 413, 'size-limit'],
  ]) {
    const response = await f.handlers.handle(new Request(`http://local/api/sessions/${session.id}/turns`, {
      method: 'POST', headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' }, body,
    }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(wallet.mock.callCount(), 0);
  assert.deepEqual(f.storage.get(session.id), before);
  assert.deepEqual(f.storage.read(session.id), journal);
});

for (const initial of [false, true]) test(`AIT-395: ${initial ? 'initial balance' : 'credits read'} passes the authorized conversation to each required projection`, async t => {
  const f = fixture(t, { demoBypass: true }), a = await f.create(), b = await f.create();
  const wallet = f.host.wallet(owner), seen = { wallet: [], tiers: [] };
  t.mock.method(f.host, 'wallet', (token, context) => {
    seen.wallet.push([token, context]);
    const limitMicro = context?.sessionId === a.id ? 10_000_000 : 2_500_000;
    return Object.create(wallet, { displayBalance: { value: undefined }, creditScope: { value: 'session' }, balance: { value: () => ({ ...wallet.balance(), limitMicro, availableMicro: limitMicro }) } });
  });
  t.mock.method(f.host, 'creditTiers', (token, context) => {
    seen.tiers.push([token, context]);
    return { current: context?.sessionId === a.id ? 'emailConfirmed' : 'anonymous', next: null, delta: 0, canConfirm: true,
      allowancesMicro: { anonymous: 2_500_000, emailGiven: 2_500_000, emailConfirmed: 10_000_000 } };
  });
  for (const session of [a, b]) {
    if (initial) { await f.call(`/api/sessions/${session.id}/turns`, { clientEventId: `start-${session.id}`, content: 'Hi' }); await f.handlers.idle(); }
    else {
      const view = await (await f.call(`/api/sessions/${session.id}/credits`)).json();
      assert.equal(view.balance.owner.limitMicro, session === a ? 10_000_000 : 2_500_000);
      assert.equal(view.scope, 'session');
      assert.equal(view.tiers.current, session === a ? 'emailConfirmed' : 'anonymous');
    }
  }
  const expected = [[owner, { sessionId: a.id }], [owner, { sessionId: b.id }]];
  assert.deepEqual(seen.wallet, expected);
  assert.deepEqual(seen.tiers, initial ? [] : expected, 'tiers receive context on credits reads and are never called for initial admission');
  for (const calls of Object.values(seen)) calls.length = 0;
  assert.equal((await f.call(`/api/sessions/${b.id}/credits`, undefined, foreign)).status, 404);
  assert.deepEqual(seen, { wallet: [], tiers: [] }, 'foreign owner never reaches projection callbacks');
});

test('AIT-395: callbacks ignoring context keep the complete owner-wide receipt snapshot', async t => {
  const f = fixture(t), s = await f.create();
  const before = await (await f.call(`/api/sessions/${s.id}/credits`)).json();
  const empty = { limitMicro: 10_000_000, committedMicro: 0, availableMicro: 10_000_000, overrunMicro: 0,
    reservedMicro: 0, confirmedSpendMicro: 0, uncertainSpendMicro: 0 };
  const balance = { sessionId: s.id, owner: empty, session: empty, voiceVisitor: empty };
  assert.deepEqual(before, {
    balance, limitSlot: { sessionId: s.id, status: 'ready', balance, remainingMs: null, endReason: null, canStartPaidWork: false, topUpOwnedByHost: true },
    tiers: { current: 'anonymous', next: null, delta: 0, canConfirm: false,
      allowancesMicro: { anonymous: 10_000_000, emailGiven: 10_000_000, emailConfirmed: 10_000_000 } },
    exhausted: false, fullHold: false, reconciling: false, lowAtMicro: 1_000_000, lowAtMaxMicro: 1_000_000,
    emailAsk: {}, emailAskAfter: 0, lowEmailAsk: { after: 0, armed: true }, nowMs: 1_000,
  }, 'owner-wide golden receipt from the unchanged demo policy');
  const wallet = f.host.wallet, tiers = f.host.creditTiers;
  t.mock.method(f.host, 'wallet', token => wallet(token));
  t.mock.method(f.host, 'creditTiers', token => tiers(token));
  assert.deepEqual(await (await f.call(`/api/sessions/${s.id}/credits`)).json(), before);
  assert.equal(Object.hasOwn(before, 'scope'), false);
});

for (const privacy of [false, true]) test(`AIT-395: session tier offers respect daily cap and privacy (privacy ${privacy})`, async t => {
  const f = fixture(t, { demo: false, privacyDocumentConfigured: () => privacy }), s = await f.create();
  const wallet = f.host.wallet(owner);
  t.mock.method(f.host, 'wallet', () => Object.create(wallet, { creditScope: { value: 'session' } }));
  let dailyCapReached = true;
  t.mock.method(f.host, 'creditTiers', () => ({ current: 'emailGiven', next: 'emailConfirmed', delta: 7_500_000, canConfirm: true, dailyCapReached,
    allowancesMicro: { anonymous: 2_500_000, emailGiven: 2_500_000, emailConfirmed: 10_000_000 } }));
  for (const capped of [true, false]) {
    dailyCapReached = capped;
    const receipt = await (await f.call(`/api/sessions/${s.id}/credits`)).json();
    assert.equal(receipt.dailyCapReached, capped);
    assert.equal(receipt.tiers.next, !capped && privacy ? 'emailConfirmed' : null);
    assert.equal(receipt.tiers.delta, !capped && privacy ? 7_500_000 : 0);
    assert.equal(receipt.tiers.canConfirm, !capped && privacy);
  }
});

for (const missing of [null, 'visitor', 'saveEmail', 'deleteEmail', 'eraseVisitor']) {
  test(`AIT-414: identity explicitly advertises visitor-email saving (${missing ?? 'complete port'})`, async t => {
    const f = fixture(t), session = await f.create();
    if (missing) delete f.host[missing];
    const identity = await f.call(`/api/sessions/${session.id}/identity`);
    assert.equal(identity.status, 200);
    assert.deepEqual((await identity.json()).visitorEmail, { canSave: missing === null });
    const visitor = await f.call('/api/visitor/email');
    assert.equal(visitor.status, missing ? 503 : 200);
    const pending = await f.call(`/api/sessions/${session.id}/identity/request`, { address: 'port@example.test' });
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).visitorEmail, { canSave: missing === null });
  });
}

test('AIT-411 O5: daily-cap receipt carries only a valid host reset instant while capped', async t => {
  const f = fixture(t), s = await f.create(), wallet = f.host.wallet(owner);
  t.mock.method(f.host, 'wallet', () => Object.create(wallet, { creditScope: { value: 'session' } }));
  let dailyCapReached = true, dailyCapResetAt = 123456789;
  t.mock.method(f.host, 'creditTiers', () => ({ dailyCapReached, dailyCapResetAt }));
  const receipt = async () => (await f.call(`/api/sessions/${s.id}/credits`)).json();
  assert.equal((await receipt()).dailyCapResetAt, dailyCapResetAt);
  dailyCapReached = false; assert.equal(Object.hasOwn(await receipt(), 'dailyCapResetAt'), false);
  dailyCapReached = true; dailyCapResetAt = 'invalid'; assert.equal(Object.hasOwn(await receipt(), 'dailyCapResetAt'), false);
});

test('AIT-411 O8: delete capability follows every required visitor port', async t => {
  const f = fixture(t), s = await f.create();
  assert.equal((await (await f.call(`/api/sessions/${s.id}/identity`)).json()).visitorEmail.canDelete, true);
  for (const key of ['visitor', 'saveEmail', 'deleteEmail', 'eraseVisitor']) {
    const saved = f.host[key]; delete f.host[key];
    assert.equal((await (await f.call(`/api/sessions/${s.id}/identity`)).json()).visitorEmail.canDelete, false, key);
    f.host[key] = saved;
  }
});

test('AIT-411 O6: disabled low ask cannot create a line or consume the low latch', async t => {
  const f = fixture(t), s = await f.create();
  f.host.emailAsk = { lowCredits: false };
  const wallet = f.host.wallet(owner);
  t.mock.method(f.host, 'wallet', () => ({ ...wallet, balance: () => ({ limitMicro: 10000000, committedMicro: 9900000 }), canAdmit: () => true }));
  f.storage.append(s.id, 'turn.final', { id: 'ait411-reply', role: 'assistant', content: 'Ready.' });
  const response = await (await f.call(`/api/sessions/${s.id}/email-ask`, { action: 'line' })).json();
  assert.equal(response.accepted, false); assert.equal(response.emailAsk.lowLine, undefined);
  assert.equal((await (await f.call(`/api/sessions/${s.id}/credits`)).json()).emailAskLowCredits, false);
});
