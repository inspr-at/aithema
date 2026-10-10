import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryConformance, handoverConformance, ownerWalletConformance } from '@inspr/aithema-core';
import { hostPortKit } from '../../packages/core/src/host-port-kit.js';
import { SQLiteStorage, SQLiteBudgetLedger } from '../../packages/server/src/index.js';
import { createDemoHost } from '../host-ports.js';

test('demo storage library passes the destructive host-port kit with foreign-owner isolation', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = createDemoHost({ storage });
  const result = await libraryConformance(host.library('kit-owner'), { wasErased: host.wasErased, foreignPort: host.library('foreign-owner') });
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('demo handover sink passes the host-port kit including concurrent deduplication and retry', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  storage.create({ id: 'kit-session', ownerToken: 'kit-owner' });
  const host = createDemoHost({ storage });
  const result = await handoverConformance(host.handover('kit-owner'), { failNext: host.sink.failNext, deliveryCount: host.sink.deliveryCount });
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('demo owner wallet passes the host-port kit; reservations stay isolated by owner', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close()); new SQLiteBudgetLedger(storage);
  const host = createDemoHost({ storage }), wallet = host.wallet('kit-owner');
  const result = await ownerWalletConformance(wallet, { sessionId: 'kit-session', lane: 'reaction', maxMicro: 10,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  assert.deepEqual(result, { ok: true, failures: [] });
  assert.equal(host.wallet('foreign-owner').balance().committedMicro, 0);
});

test('demo identity host supplies revision-bound mail and polling facts under the host-port watchdog', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  storage.create({ id: 'kit-session', ownerToken: 'kit-owner' });
  const host = createDemoHost({ storage, demoBypass: false, now: () => 1 }), kit = hostPortKit(1_000);
  const request = { sessionId: 'kit-session', ownerToken: 'kit-owner', address: 'kit@example.test', revision: 2, expiresAt: 100 };
  const delivery = await kit.run('mail delivery failed', () => host.identity.requestVerification(request));
  kit.check(delivery?.status === 'sent', 'confirmed fake mail delivery');
  const mail = await kit.run('outbox failed', () => host.outbox(request));
  kit.check(mail?.length === 1 && mail[0].address === request.address && mail[0].revision === 2, 'revision-bound outbox');
  const wrong = await kit.run('wrong token failed', () => host.identity.verify({ ...request, token: 'wrong' }));
  kit.check(wrong?.verified === false, 'unverified token');
  const verified = await kit.run('confirmation failed', () => host.identity.verify({ ...request, token: mail[0].token }));
  kit.check(verified?.verified === true && verified.revision === 2, 'verified host evidence');
  const reused = await kit.run('reused token failed', () => host.identity.verify({ ...request, token: mail[0].token }));
  kit.check(reused?.verified === false, 'single-use token');
  const wrongAfterVerification = await kit.run('wrong token after confirmation failed', () => host.identity.verify({ ...request, token: 'wrong' }));
  kit.check(wrongAfterVerification?.verified === false, 'token evidence still requires a match');
  kit.check(host.outbox(request)[0].token === null, 'redeemed token removed from outbox');
  const polled = await kit.run('polling failed', () => host.identity.verify(request)); kit.check(polled?.verified === true, 'authoritative polling');
  const next = { ...request, revision: 3 };
  await host.identity.requestVerification(next);
  kit.check((await host.identity.verify({ ...next, token: mail[0].token })).verified === false, 'old token cannot redeem a new revision');
  const nextToken = host.outbox(next).at(-1).token;
  const raced = await Promise.all([host.identity.verify({ ...next, token: nextToken }), host.identity.verify({ ...next, token: nextToken })]);
  kit.check(raced.filter(result => result.verified === true).length === 1, 'one concurrent token redemption');
  assert.deepEqual(kit.result(), { ok: true, failures: [] });
});
