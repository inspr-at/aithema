import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../src/index.js';
import { mockConsent, temporaryDb } from '../../../test/helpers.js';
import { inputRevision } from '@inspr/aithema-core';

const owner = 'role-fixture-owner';
function fixture(t, { storage = new SQLiteStorage(), available = true } = {}) {
  const host = { identity: { chooseRole: available }, policy: {} };
  const handlers = createHandlers({ storage, host, consent: mockConsent, pluginRuntime: createPluginRuntime({ storage, consent: mockConsent }) });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await handlers.close(); storage.close(); };
  t.after(close);
  const call = (path, value, token = owner) => handlers.handle(new Request('http://local'+path, {
    method: value === undefined ? 'GET' : 'POST', headers: { ...(token ? { 'x-aithema-session-token': token } : {}), 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
  const create = async () => (await call('/api/sessions', {})).json();
  return { storage, host, handlers, call, create, close };
}

test('AIT-281: choose role authenticates, refuses stale/invalid commands and exposes no labels', async t => {
  const f = fixture(t), session = await f.create(), path = `/api/sessions/${session.id}/identity/role`;
  assert.equal(session.roleChoice.role, null, 'a new conversation has no role');
  const command = { role: 'agency', baseRevision: session.seq, clientEventId: 'role-command' };
  const before = f.storage.read(session.id);
  for (const token of [null, 'foreign-owner']) assert.equal((await f.call(path, command, token)).status, 404);
  assert.deepEqual(f.storage.read(session.id), before);
  for (const invalid of [{ ...command, role: 'unknown' }, { ...command, baseRevision: -1 }, { ...command, clientEventId: '' }, { ...command, labels: {} }]) {
    assert.equal((await f.call(path, invalid)).status, 400);
  }
  const stale = await f.call(path, { ...command, baseRevision: session.seq - 1 });
  assert.equal(stale.status, 409);
  const notice = await stale.json(); assert.equal(notice.error, 'role-conflict'); assert.equal(notice.roleChoice.revision, session.seq);
  assert.deepEqual(f.storage.read(session.id), before);
  const result = await f.call(path, command); assert.equal(result.status, 200);
  const ack = await result.json(); assert.equal(ack.roleChoice.role, 'agency'); assert.equal(ack.roleChoice.source, 'chosen');
  assert.equal(ack.roleChoice.reasoning, null, 'choosing from null has no inferred reasoning');
  assert.equal(ack.roleChoice.labels, undefined);
  const after = f.storage.read(session.id);
  const replay = await f.call(path, command); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  assert.deepEqual(f.storage.read(session.id), after, 'receipt replay has no duplicate event');
  const conflict = await f.call(path, { ...command, role: 'private' }); assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'role-event-conflict');
});

test('AIT-281: choice survives restart, overrides inference and every later role is projected correctly', async t => {
  const path = await temporaryDb(), f = fixture(t, { storage: new SQLiteStorage(path) });
  const session = await f.create(), route = `/api/sessions/${session.id}/identity/role`;
  const command = { role: 'agency', baseRevision: session.seq, clientEventId: 'durable-role' };
  assert.equal((await f.call(route, command)).status, 200);
  await f.close();
  const restored = fixture(t, { storage: new SQLiteStorage(path) });
  assert.equal((await restored.call(route, command)).status, 200, 'idempotency survives process restart');
  const current = restored.storage.get(session.id);
  restored.storage.append(session.id, 'understanding.updated', { ...current.understanding, inputRevision: inputRevision(current),
    actor: { type: 'company', evidence: 'inferred', reasoning: 'fixture inference' } });
  assert.equal(restored.storage.get(session.id).actor.type, 'agency');
  let read = await (await restored.call(`/api/sessions/${session.id}/identity`)).json();
  assert.equal(read.roleChoice.role, 'agency'); assert.equal(read.roleChoice.source, 'chosen');
  assert.equal((await restored.call(route, { role: 'private', baseRevision: read.roleChoice.revision, clientEventId: 'second-role' })).status, 200);
  assert.equal(restored.storage.get(session.id).actor.type, 'private', 'second choice replaces the first actor content');
  read = await (await restored.call(`/api/sessions/${session.id}`)).json(); assert.equal(read.roleChoice.role, 'private');
});

test('AIT-281: withdrawal, consent reset and erasure forget durable role bytes and receipts', async t => {
  for (const action of ['withdraw', 'consent', 'erase']) {
    const f = fixture(t), session = await f.create();
    const turn = f.storage.postTurn(session.id, 'fixture-user', 'fixture bytes', 'fixture message', { ownerToken: owner }).event;
    const revision = f.storage.get(session.id).seq;
    assert.equal((await f.call(`/api/sessions/${session.id}/identity/role`, { role: 'agency', baseRevision: revision, clientEventId: 'forget-role' })).status, 200);
    if (action === 'withdraw') f.storage.withdraw(session.id, turn.data.id, 'withdrawal', { ownerToken: owner });
    if (action === 'consent') f.storage.reviseConsent(session.id, false, { ownerToken: owner });
    if (action === 'erase') f.storage.erase(session.id, { ownerToken: owner });
    assert.equal(f.storage.get(session.id).actor, null, action);
    assert.ok(!f.storage.hostState(session.id)?.identity?.role, action);
    assert.ok(!f.storage.hostState(session.id)?.roleCommands, action);
    assert.equal(f.storage.db.prepare("SELECT COUNT(*) AS n FROM content WHERE session_id=? AND kind='actor' AND bytes IS NOT NULL").get(session.id).n, 0);
    assert.ok(!JSON.stringify(f.storage.read(session.id)).includes('"role":"agency"'), 'erased role is absent from replay/export');
  }
});

test('AIT-281: absent host capability refuses role commands', async t => {
  const f = fixture(t, { available: false }), session = await f.create();
  assert.equal((await f.call(`/api/sessions/${session.id}/identity/role`, { role: 'agency', baseRevision: session.seq, clientEventId: 'no-cap' })).status, 503);
  assert.equal(Object.hasOwn(await (await f.call(`/api/sessions/${session.id}/identity`)).json(), 'roleChoice'), false);
});

test('AIT-281: identity includes the inferred role and reasoning only with the explicit chooseRole capability', async t => {
  for (const capability of [true, false, undefined]) {
    const f = fixture(t, { available: capability === true });
    if (capability === undefined) delete f.host.identity.chooseRole;
    const session = await f.create(), current = f.storage.get(session.id);
    f.storage.append(session.id, 'understanding.updated', { ...current.understanding, inputRevision: inputRevision(current),
      actor: { type: 'company', evidence: 'inferred', reasoning: 'private fixture inference' } });
    assert.equal(f.storage.get(session.id).actor.reasoning, 'private fixture inference');
    const response = await f.call(`/api/sessions/${session.id}/identity`); assert.equal(response.status, 200);
    const body = await response.json(); assert.ok(body.identity);
    assert.equal(Object.hasOwn(body, 'roleChoice'), capability === true);
    if (capability === true) {
      assert.equal(body.roleChoice.available, true); assert.equal(body.roleChoice.role, 'company');
      assert.equal(body.roleChoice.source, 'inferred'); assert.equal(body.roleChoice.reasoning, 'private fixture inference');
      f.host.identity.chooseRole = false;
      assert.equal(Object.hasOwn(await (await f.call(`/api/sessions/${session.id}/identity`)).json(), 'roleChoice'), false, 'revocation gates subsequent reads');
    } else assert.equal(JSON.stringify(body).includes('private fixture inference'), false);
  }
});
