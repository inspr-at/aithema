import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets } from '../src/index.js';
import { createDemoHost } from '../../../demo/host-ports.js';
import { mockConsent, temporaryDb, readEvents, unzip } from '../../../test/helpers.js';
import { createSession, applyEvent, inputRevision, createHandover, reduceHandover } from '@inspr/aithema-core';

const owner = 'host-owner', foreign = 'another-owner';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const storage = options.storage ?? new SQLiteStorage();
  let time = 1_000;
  const host = createDemoHost({ storage, demoBypass: false, verificationRequired: true, now: () => time,
    identityPolicy: { resendCooldownMs: 100, verificationTtlMs: 500 }, ...options });
  const runtime = createPluginRuntime({ storage, consent: mockConsent, presets: options.presets });
  const handlers = createHandlers({ storage, consent: mockConsent, pluginRuntime: runtime, host, deadlineMs: options.deadlineMs ?? 30_000 });
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

const sessionRoutes = [
  ['identity', undefined], ['identity/request', { address: 'owner@example.test' }], ['identity/resend', {}],
  ['identity/change', { address: 'changed@example.test' }], ['identity/confirm', { token: 'fake-token' }],
  ['identity/unlock', {}], ['handover', undefined], ['handover', {}], ['handover/retry', {}],
  ['credits', undefined], ['demo/outbox', undefined],
];
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
  assert.equal(s.identity.status, 'guest'); assert.equal(s.identity.assessmentUnlocked, false);
  await f.call(`${base}/turns`, { clientEventId: 'first', content: 'systems: API' }); await f.handlers.idle();
  assert.equal(f.storage.get(s.id).understanding.inputRevision, null);
  assert.equal((await f.runtime.matrix(f.storage.get(s.id))).best.analysis.reason, 'verification required');
  assert.equal((await f.runtime.matrix(f.storage.get(s.id))).best.images.reason, 'verification required');
  for (const body of [{ address: 'owner@example.test', verified: true }, { address: 'owner@example.test', role: 'company' }, { address: 'owner@example.test', actor: { status: 'verified' } }]) {
    assert.equal((await f.call(`${base}/identity/request`, body)).status, 400);
  }
  const pending = await (await f.call(`${base}/identity/request`, { address: 'owner@example.test' })).json();
  assert.equal(pending.identity.delivery, 'sent'); assert.equal(pending.identity.status, 'verification-pending');
  const message = await f.message(s.id);
  assert.equal(JSON.stringify(await (await f.call(base)).json()).includes(message.token), false);
  assert.equal(JSON.stringify(f.storage.read(s.id)).includes(message.token), false);
  await f.call(`${base}/pause`, { paused: true });
  const wrong = await (await f.call(`${base}/identity/confirm`, { token: 'wrong-token' })).json();
  assert.equal(wrong.identity.status, 'verification-pending');
  const confirmed = await (await f.call(`${base}/identity/confirm`, { token: message.token })).json();
  assert.equal(confirmed.identity.status, 'verified'); assert.equal(confirmed.identity.assessmentUnlocked, true);
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

test('credits reads owner and ledger amounts on the server, retains the owner time guard across new/reset and never exposes foreign spend', async t => {
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
  view = await (await f.call(`/api/sessions/${reset.id}/credits`)).json(); assert.equal(view.limitSlot.remainingMs, 50); assert.equal(view.balance.owner.committedMicro, 123);
  assert.equal(reset.session.paused, true); assert.equal(view.limitSlot.canStartPaidWork, false);
  f.at(1_200);
  const lengthBefore = f.storage.read(reset.id).length, guardBefore = f.storage.ownerCreditState(owner);
  view = await (await f.call(`/api/sessions/${reset.id}/credits`)).json(); assert.equal(view.limitSlot.status, 'ending'); assert.equal(view.limitSlot.endReason, 'one-hour');
  for (let i = 0; i < 10; i++) await f.call(`/api/sessions/${reset.id}/credits`);
  assert.equal(f.storage.read(reset.id).length, lengthBefore); assert.deepEqual(f.storage.ownerCreditState(owner), guardBefore);
  const next = await f.create(); view = await (await f.call(`/api/sessions/${next.id}/credits`)).json(); assert.equal(view.limitSlot.status, 'ending'); assert.equal(view.limitSlot.remainingMs, 0);
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
