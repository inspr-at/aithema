import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createSpendCap } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createDemoHost } from '../host-ports.js';
import { listenAdmin, adminRequest } from '../admin-socket.js';
import { mockConsent, post, sessionFetch, startChild, temporaryDb } from '../../test/helpers.js';
const execute = promisify(execFile);

async function fixture(t) {
  const storage = new SQLiteStorage(), host = createDemoHost({ storage });
  const handlers = createHandlers({ storage, host, consent: mockConsent });
  const { server, url } = await listen(handlers.handle);
  const socketPath = join(await mkdtemp(join(tmpdir(), 'ait-erase-')), 'ops.sock');
  const admin = await listenAdmin({ host, socketPath, eraseSession: options => handlers.eraseSession(options) });
  t.after(async () => { await admin.close(); await handlers.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); storage.close(); });
  const create = (ownerToken = 'test-visitor') => post(url + '/api/sessions', {}, { 'x-aithema-session-token': ownerToken }).then(r => r.json());
  const erase = (sessionId, visitor = false) => adminRequest(socketPath, 'erase-session', { sessionId, visitor });
  return { storage, host, handlers, socketPath, url, create, erase };
}

// The real demo process must wire the socket port too, not only the test fixture.
test('AIT-247 running demo CLI erases a zero-turn session without its cookie and audits every retry', { timeout: 15_000 }, async t => {
  const db = await temporaryDb(), running = await startChild(new URL('../server.js', import.meta.url), db);
  t.after(() => running.kill());
  const session = await post(running.url + '/api/sessions', {}).then(r => r.json());
  const socket = join(db, '..', 'ops', 'admin');
  const run = (...args) => execute(process.execPath, [new URL('../admin-cli.js', import.meta.url).pathname, '--socket', socket, 'erase-session', ...args]);
  assert.equal(JSON.parse((await run(session.id)).stdout).result, 'erased');
  assert.equal(JSON.parse((await run(session.id)).stdout).result, 'already-erased');
  await assert.rejects(run('unknown'), e => JSON.parse(e.stdout).error === 'not-found');
  for (const args of [[], [session.id, '--visitor', 'false'], [session.id, '--actor', 'forged'], [session.id, '--visitor', '--visitor']]) {
    await assert.rejects(run(...args), e => /Usage:/u.test(e.stderr));
  }
  assert.equal((await fetch(running.url + '/erase-session')).status, 404);
  const items = (await adminRequest(socket, 'audit')).body.items.filter(e => e.newValues.event === 'session.erase');
  assert.deepEqual(items.map(e => e.newValues.result), ['erased', 'already-erased', 'not-found']);
  assert.ok(items.every(e => e.actor === `ops-cli:${userInfo().username}` && Number.isFinite(Date.parse(e.at)) && e.source === 'ops-cli'));
  assert.ok(items.every(e => e.newValues.visitor === false));
});

test('AIT-247 live erase closes SSE, preserves events and financial attribution while another session writes', { timeout: 10_000 }, async t => {
  const h = await fixture(t), a = await h.create(), b = await h.create('other-owner');
  await post(h.url + `/api/sessions/${a.id}/turns`, { clientEventId: 'private', content: 'erase-this-content' });
  await h.handlers.idle();
  const ledger = new SQLiteBudgetLedger(h.storage), cap = createSpendCap({ storage: h.storage, account: 'operator-test', capMicro: 1000 });
  const admitted = ledger.admit({ sessionId: a.id, lane: 'reaction', maxMicro: 50, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(admitted.attemptId); claim.consume();
  ledger.settle(claim.claimId, { attemptId: admitted.attemptId, outcome: 'completed', chargedMicro: 17, usage: { inputTokens: 1, outputTokens: 1 } });
  const hold = cap.reserve(50); cap.settle(hold, 17);
  const uncertain = ledger.admit({ sessionId: a.id, lane: 'reaction', maxMicro: 30, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const uncertainClaim = ledger.claim(uncertain.attemptId); uncertainClaim.consume();
  ledger.settle(uncertainClaim.claimId, { attemptId: uncertain.attemptId, outcome: 'uncertain' });
  const accountUncertain = cap.reserve(30); cap.dispatch(accountUncertain); cap.uncertain(accountUncertain);
  const uncertainBefore = ledger.get(uncertain.attemptId);
  const before = ledger.get(admitted.attemptId), accountBefore = cap.snapshot(), totalsBefore = ledger.breakdown(undefined, { ownerHash: before.owner_hash });
  const stream = await sessionFetch(h.url + `/api/sessions/${a.id}/events`);
  const consumed = stream.text();
  const writes = Array.from({ length: 8 }, (_, i) => post(h.url + `/api/sessions/${b.id}/pause`, { paused: Boolean(i % 2) }, { 'x-aithema-session-token': 'other-owner' }));
  assert.equal((await h.erase(a.id)).body.result, 'erased');
  assert.ok((await Promise.all(writes)).every(r => r.status === 200));
  assert.match(await consumed, /event: session.erased/u);
  assert.equal((await sessionFetch(h.url + `/api/sessions/${a.id}`)).status, 404);
  assert.equal(h.storage.read(a.id).filter(e => e.type === 'session.erased').length, 1);
  assert.ok(!JSON.stringify(h.storage.read(a.id)).includes('erase-this-content'));
  assert.deepEqual(ledger.get(admitted.attemptId), before);
  assert.deepEqual(ledger.get(uncertain.attemptId), uncertainBefore);
  assert.equal(totalsBefore.confirmedSpendMicro, 17);
  assert.equal(totalsBefore.uncertainSpendMicro, 30);
  assert.deepEqual(ledger.breakdown(undefined, { ownerHash: before.owner_hash }), totalsBefore);
  assert.deepEqual(cap.snapshot(), accountBefore);
  assert.equal(h.storage.get(a.id).ownerHash, before.owner_hash);
  assert.equal((await h.erase(a.id)).body.result, 'already-erased');
  assert.equal(h.storage.read(a.id).filter(e => e.type === 'session.erased').length, 1);
});

test('AIT-247 visitor scope preflights every sibling, clears identity, and works from an erased seed', async t => {
  const h = await fixture(t), a = await h.create(), b = await h.create(), other = await h.create('other-owner');
  h.host.saveEmail('test-visitor', { address: 'private@example.test', noticeVersion: h.host.emailNotice.version });
  const ledger = new SQLiteBudgetLedger(h.storage);
  const pending = ledger.admit({ sessionId: b.id, lane: 'reaction', maxMicro: 10, requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  assert.deepEqual(await h.erase(a.id, true), { status: 409, body: { error: 'pending-dispatch' } });
  assert.ok(!h.storage.get(a.id).tombstone && !h.storage.get(b.id).tombstone);
  const claim = ledger.claim(pending.attemptId); claim.consume();
  assert.equal((await h.erase(b.id)).body.error, 'pending-dispatch');
  ledger.settle(claim.claimId, { attemptId: pending.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
  const run = (...args) => execute(process.execPath, [new URL('../admin-cli.js', import.meta.url).pathname, '--socket', h.socketPath, 'erase-session', ...args]);
  assert.equal(JSON.parse((await run(a.id)).stdout).erasedSessions, 1);
  assert.equal(h.host.visitor('test-visitor').address, 'private@example.test', 'single erase retains visitor identity');
  assert.equal(JSON.parse((await run(a.id, '--visitor')).stdout).erasedSessions, 1);
  assert.ok(h.storage.get(b.id).tombstone);
  assert.ok(!h.storage.get(other.id).tombstone);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM visitor_identities WHERE owner_hash=?').get(h.storage.get(a.id).ownerHash).n, 0);
  assert.equal((await h.erase(a.id, true)).body.result, 'already-erased');
  const audit = (await adminRequest(h.socketPath, 'audit')).body.items.filter(e => e.newValues.event === 'session.erase');
  assert.deepEqual(audit.map(e => e.newValues.result), ['pending-dispatch', 'pending-dispatch', 'erased', 'erased', 'already-erased']);
  assert.ok(!JSON.stringify(audit).includes('private@example.test'));
});

test('AIT-247 active durable voice refuses the operator; HTTP retains cancellation behavior', async t => {
  const h = await fixture(t), a = await h.create(), b = await h.create();
  h.storage.saveVoiceCall(b.id, { callId: 'active-call', providerSessionId: 'provider-call', terminal: null });
  assert.deepEqual(await h.erase(a.id, true), { status: 409, body: { error: 'voice-call-active' } });
  assert.deepEqual(await h.erase(b.id), { status: 409, body: { error: 'voice-call-active' } });
  assert.ok(!h.storage.get(a.id).tombstone && !h.storage.get(b.id).tombstone);
  assert.equal((await post(h.url + `/api/sessions/${b.id}/erase`, {})).status, 200);
});

test('AIT-247 rejects forged scope and audits invalid requests and handler failures without content', async t => {
  const h = await fixture(t), a = await h.create();
  assert.equal((await adminRequest(h.socketPath, 'erase-session', { sessionId: a.id, visitor: 'yes', content: 'do-not-log' })).status, 400);
  assert.equal((await adminRequest(h.socketPath, 'erase-session', { sessionId: a.id, actor: 'forged' })).status, 400);
  const erased = t.mock.method(h.host, 'erased', async () => { throw new Error('do-not-log'); });
  assert.equal((await h.erase(a.id)).body.error, 'erasure-failed');
  const audit = (await adminRequest(h.socketPath, 'audit')).body.items.filter(e => e.newValues.event === 'session.erase');
  assert.deepEqual(audit.map(e => e.newValues.result), ['invalid-admin-command', 'invalid-admin-command', 'erasure-failed']);
  assert.ok(!JSON.stringify(audit).includes('do-not-log'));
  erased.mock.restore();
  const cleanup = t.mock.method(h.host, 'erased');
  assert.equal((await h.erase(a.id)).body.result, 'already-erased');
  assert.equal(cleanup.mock.callCount(), 1, 'a tombstone retry finishes host cleanup');
});

test('AIT-247 audit failure cannot acknowledge a successful erase', async t => {
  const h = await fixture(t), a = await h.create();
  const audit = t.mock.method(h.host.visitorCredits, 'auditErasure', () => { throw new Error('audit unavailable'); });
  assert.equal((await h.erase(a.id)).status, 503);
  audit.mock.restore();
  assert.equal((await h.erase(a.id)).body.result, 'already-erased');
});


test('AIT-247 a failed post-commit checkpoint retries the erasure cascade and closes SSE', { timeout: 10_000 }, async t => {
  const h = await fixture(t), a = await h.create();
  const stream = await sessionFetch(h.url + `/api/sessions/${a.id}/events`), consumed = stream.text();
  const checkpoint = t.mock.method(h.storage, 'checkpointErasure', () => { throw new Error('checkpoint unavailable'); });
  assert.equal((await h.erase(a.id)).body.error, 'erasure-failed');
  assert.ok(h.storage.get(a.id).tombstone, 'the erase transaction committed before the checkpoint failed');
  checkpoint.mock.restore();
  assert.equal((await h.erase(a.id)).body.result, 'already-erased');
  assert.match(await consumed, /event: session.erased/u);
  assert.equal(h.storage.read(a.id).filter(e => e.type === 'session.erased').length, 1);
});
