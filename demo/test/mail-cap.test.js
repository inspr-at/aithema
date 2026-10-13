import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { createIdentity } from '@inspr/aithema-core';
import { createDemoHost } from '../host-ports.js';
import { listenAdmin, adminRequest } from '../admin-socket.js';
import { mockConsent, temporaryDb } from '../../test/helpers.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
async function fixture(t, options = {}) {
  let time = options.time ?? 1_000;
  const storage = options.storage ?? new SQLiteStorage();
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const messages = [];
  const host = createDemoHost({ storage, demo: false, now: () => time, privacyDocumentConfigured: () => true,
    mailPlugin: { id: 'smtp', deliversVerification: true, async requestVerification(effect) {
      messages.push(effect); return { status: 'sent' };
    } }, ...options });
  const settings = () => host.visitorCredits.settings();
  const set = mailCap => host.visitorCredits.saveSettings({ baseRevision: settings().revision, mailCap }, { actor: 'ops-cli:test', source: 'ops-cli' });
  host.visitorCredits.saveSettings({ baseRevision: settings().revision, confirmationEnabled: true }, { actor: 'ops-cli:test', source: 'ops-cli' });
  const session = owner => storage.create({ ownerToken: owner, locale: 'de' });
  const send = (owner, address = `${owner}@example.test`) => {
    const s = session(owner), visitor = host.saveEmail(owner, { address, noticeVersion: 'ait-135-v1' });
    return host.identity.requestVerification({ sessionId: s.id, ownerToken: owner, address,
      revision: visitor.addressRevision, expiresAt: time + 1_800_000 });
  };
  return { storage, host, messages, set, settings, session, send, at: value => { time = value; } };
}

test('AIT-166 defaults cap concurrent requests at 30 rolling-hour reservations', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => f.send(`burst-${i}`)));
  assert.equal(results.filter(r => r.status === 'sent').length, 30);
  assert.equal(results.filter(r => r.status === 'rate-limited').length, 30);
  assert.equal(f.messages.length, 30);
  assert.deepEqual(f.settings().mailCap, { hour: 30, day: 200 });
  assert.deepEqual(f.host.confirmation.mailCap(), { revision: f.settings().revision,
    hour: { limit: 30, count: 30, remaining: 0 }, day: { limit: 200, count: 30, remaining: 170 } });
  f.at(HOUR + 999);
  assert.equal((await f.send('before-hour')).status, 'rate-limited');
  f.at(HOUR + 1_000);
  assert.equal((await f.send('at-hour')).status, 'sent');
  assert.equal(f.host.confirmation.mailCap().hour.count, 1);
});

test('AIT-166 day cap is rolling, failed sends consume slots, and C1 rejections do not', async t => {
  const f = await fixture(t); f.set({ hour: 2, day: 3 });
  await f.send('first');
  assert.equal((await f.send('address-duplicate', 'first@example.test')).status, 'sent');
  f.at(HOUR + 1_000);
  await f.send('third');
  assert.equal((await f.send('day-suppressed')).status, 'rate-limited');
  f.at(DAY + 999);
  assert.equal((await f.send('before-day')).status, 'rate-limited');
  f.at(DAY + 1_000);
  assert.equal((await f.send('at-day')).status, 'sent');
  assert.deepEqual(f.host.confirmation.mailCap().day, { limit: 3, count: 2, remaining: 1 });

  const g = await fixture(t, { mailPlugin: { id: 'smtp', deliversVerification: true,
    async requestVerification() { throw new Error('synthetic relay failure'); } } });
  g.set({ hour: 10, day: 10 });
  for (let i = 0; i < 3; i++) assert.equal((await g.send(`failed-${i}`, 'shared@example.test')).status, 'failed');
  assert.equal((await g.send('c1-suppressed', 'shared@example.test')).status, 'rate-limited');
  assert.equal(g.host.confirmation.mailCap().hour.count, 3);
});

test('AIT-166 global accounting survives erasure, address changes, restart and bounded retention', async t => {
  const path = await temporaryDb(), f = await fixture(t, { storage: new SQLiteStorage(path) });
  f.set({ hour: 2, day: 3 });
  await f.send('erase'); await f.send('change');
  f.host.eraseVisitor('erase'); f.host.deleteEmail('change');
  f.storage.close();
  const g = await fixture(t, { storage: new SQLiteStorage(path) });
  assert.equal((await g.send('after-restart')).status, 'rate-limited');
  assert.equal(g.host.confirmation.mailCap().day.count, 2);
  assert.deepEqual(g.storage.db.prepare('PRAGMA table_info(host_mail_slots)').all().map(r => r.name).sort(), ['count', 'created_at']);
  g.at(DAY + 1_000); g.host.retainVisitors({ limit: 1 });
  assert.equal(g.storage.db.prepare('SELECT COUNT(*) n FROM host_mail_slots').get().n, 0);
  assert.equal((await g.send('after-retention')).status, 'sent');
});

test('AIT-166 reservation failure rolls back the global slot with token and C1 accounting', async t => {
  const f = await fixture(t);
  t.mock.method(f.host.visitorCredits, 'createToken', () => { throw new Error('synthetic reservation failure'); });
  await assert.rejects(() => f.send('rollback'), /synthetic reservation failure/u);
  assert.equal(f.host.confirmation.mailCap().hour.count, 0);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse').get().n, 0);
  assert.equal(f.messages.length, 0);
});

test('AIT-166 temporary relay rejection becomes a private failed delivery and keeps the visitor cooldown', async t => {
  const { createSmtpMail, smtpConfig } = await import('../../plugins/mail-smtp/src/index.js');
  const logs = []; let sends = 0;
  t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
  const mailPlugin = createSmtpMail({ config: smtpConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'sender@example.test' }),
    publicOrigin: 'https://host.example.test', createTransport: () => ({
      async sendMail() { sends++; throw Object.assign(new Error('451 temporary visitor@example.test'), { responseCode: 451 }); }, close() {},
    }) });
  t.after(() => mailPlugin.close());
  const f = await fixture(t, { mailPlugin }), s = f.session('temporary');
  const visitor = f.host.saveEmail('temporary', { address: 'visitor@example.test', noticeVersion: 'ait-135-v1' });
  const effect = { sessionId: s.id, ownerToken: 'temporary', address: 'visitor@example.test',
    revision: visitor.addressRevision, expiresAt: 1_801_000 };
  assert.deepEqual(await f.host.identity.requestVerification(effect), { status: 'failed' });
  assert.equal(f.storage.db.prepare('SELECT status FROM visitor_mail_deliveries').get().status, 'failed');
  assert.equal(f.host.visitorCredits.audit().at(-1).newValues.outcome, 'failed');
  assert.equal((await f.host.identity.requestVerification(effect)).status, 'rate-limited');
  assert.equal(sends, 1); assert.equal(f.host.confirmation.mailCap().hour.count, 1);
  assert.deepEqual(logs, [{ event: 'mail-delivery-failed', temporary: true }]);
  f.at(61_000);
  assert.equal((await f.host.identity.requestVerification(effect)).status, 'failed');
  assert.equal(sends, 2, 'only an explicit resend after the cooldown retries delivery');
});

test('AIT-166 accepted/global-suppressed HTTP responses match and finish before SMTP', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; }), messages = [];
  const f = await fixture(t, { mailPlugin: { id: 'smtp', deliversVerification: true,
    async requestVerification(effect) { messages.push(effect); await held; return { status: 'sent' }; } } });
  f.set({ hour: 1, day: 1 });
  const handlers = createHandlers({ storage: f.storage, host: f.host, consent: mockConsent });
  t.after(async () => { release(); await handlers.close(); });
  // The same displayed address is needed for exact body equality; this second
  // request is below C1's address cap, so only the global cap can suppress it.
  const call = async owner => {
    const s = f.session(owner);
    const response = await handlers.handle(new Request(`http://local/api/sessions/${s.id}/identity/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner },
      body: JSON.stringify({ address: 'shared@example.test' }),
    }));
    return { status: response.status, headers: [...response.headers], body: await response.json() };
  };
  const beforeSmtp = async owner => {
    let timer;
    try {
      return await Promise.race([call(owner), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP waited on SMTP')), 500); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const allowed = await beforeSmtp('http-allowed');
    assert.equal(messages.length, 0, 'SMTP dispatch starts after returning the response');
    await new Promise(resolve => setImmediate(resolve));
    const suppressed = await beforeSmtp('http-suppressed');
    assert.equal(allowed.status, 200); assert.equal(allowed.body.identity.delivery, 'sent');
    assert.deepEqual(suppressed, allowed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1);
    release(); await handlers.idle();
    for (const owner of ['http-allowed', 'http-suppressed']) {
      const s = f.storage.get(f.storage.ownedIds(owner)[0]);
      assert.equal(f.host.identity.project({ session: s }, createIdentity()).delivery, 'sent');
    }
  } finally { release(); }
});

test('AIT-166 suppression logs once per rolling window, persists across restart, and audits counts only', async t => {
  const logs = []; t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
  const path = await temporaryDb(), f = await fixture(t, { storage: new SQLiteStorage(path) });
  f.set({ hour: 1, day: 2 });
  await f.send('one'); await f.send('suppressed-a'); await f.send('suppressed-b');
  assert.deepEqual(logs, [{ event: 'mail-cap', window: 'hour', count: 1 }]);
  f.storage.close();
  const g = await fixture(t, { storage: new SQLiteStorage(path) });
  await g.send('suppressed-after-restart'); assert.equal(logs.length, 1);
  g.at(HOUR + 1_000); await g.send('two'); await g.send('both-full'); await g.send('both-full-again');
  assert.deepEqual(logs, [{ event: 'mail-cap', window: 'hour', count: 1 },
    { event: 'mail-cap', window: 'hour', count: 1 }, { event: 'mail-cap', window: 'day', count: 2 }]);
  const events = g.host.visitorCredits.audit({ limit: 1000 }).filter(e => e.newValues?.event === 'mail-cap');
  assert.equal(events.length, 3);
  assert.ok(events.every(e => Object.keys(e.newValues).sort().join(',') === 'count,event,revision,window'));
  assert.doesNotMatch(JSON.stringify(logs), /@|token|visitor/iu);
});

test('AIT-166 OPS CLI view and audited set require baseRevision, allow zero and preserve C1/A2', async t => {
  const f = await fixture(t), before = f.settings();
  const path = join(await mkdtemp(join(tmpdir(), 'ait-166-')), 'ops.sock');
  const admin = await listenAdmin({ host: f.host, socketPath: path }); t.after(() => admin.close());
  const run = (...args) => promisify(execFile)(process.execPath, ['demo/admin-cli.js', '--socket', path, ...args]);
  const initial = JSON.parse((await run('mail-cap')).stdout);
  assert.deepEqual(initial.hour, { limit: 30, count: 0, remaining: 30 });
  const saved = JSON.parse((await run('set-mail-cap', '--base-revision', String(before.revision), '--hour', '2', '--day', '5')).stdout);
  assert.deepEqual(saved.mailCap, { hour: 2, day: 5 }); assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.allowancesMicro, before.allowancesMicro); assert.equal(saved.confirmationEnabled, before.confirmationEnabled);
  const stale = await adminRequest(path, 'set-mail-cap', { baseRevision: before.revision, mailCap: { hour: 4, day: 8 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.current.revision, saved.revision);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: saved.revision, mailCap: { hour: 4, day: 8 } }), /OPS/u);
  for (const mailCap of [{ hour: -1, day: 8 }, { hour: 1.5, day: 8 }, { hour: '1', day: 8 }, { hour: 1 }, { hour: 1, day: 8, address: 'forbidden' }]) {
    assert.equal((await adminRequest(path, 'set-mail-cap', { baseRevision: saved.revision, mailCap })).status, 400);
  }
  assert.equal((await adminRequest(path, 'set-mail-cap', { baseRevision: saved.revision, mailCap: { hour: 1, day: 8 }, confirmationEnabled: false })).status, 400);
  await f.send('cli-count');
  const view = JSON.parse((await run('mail-cap')).stdout);
  assert.deepEqual(view.hour, { limit: 2, count: 1, remaining: 1 });
  assert.deepEqual(view.day, { limit: 5, count: 1, remaining: 4 });
  await run('set-mail-cap', '--base-revision', String(saved.revision), '--hour', '0', '--day', '0');
  assert.equal((await f.send('paused')).status, 'rate-limited');
  const audits = f.host.visitorCredits.audit().filter(e => e.source === 'ops-cli' && e.oldValues?.mailCap);
  assert.equal(audits.length, 2); assert.deepEqual(audits[0].oldValues.mailCap, { hour: 30, day: 200 });
  assert.deepEqual(audits[0].newValues.mailCap, { hour: 2, day: 5 });
});

test('AIT-166 migration preserves settings and imports existing C1 reservations without address data', async t => {
  const f = await fixture(t); await f.send('legacy-one'); await f.send('legacy-two');
  const before = f.settings();
  // Model the pre-AIT-166 schema and existing address-independent C1 slots.
  f.storage.db.exec('DROP TABLE IF EXISTS host_mail_slots; DROP TABLE IF EXISTS host_mail_cap_alerts;');
  for (const name of ['mail_cap_hour', 'mail_cap_day']) {
    if (f.storage.db.prepare('PRAGMA table_info(visitor_credit_settings)').all().some(c => c.name === name)) {
      f.storage.db.exec(`ALTER TABLE visitor_credit_settings DROP COLUMN ${name}`);
    }
  }
  const host = createDemoHost({ storage: f.storage, demo: false, now: () => 1_000, privacyDocumentConfigured: () => true,
    mailPlugin: { id: 'smtp', deliversVerification: true } });
  const after = host.visitorCredits.settings();
  assert.deepEqual(after.allowancesMicro, before.allowancesMicro); assert.equal(after.confirmationEnabled, before.confirmationEnabled);
  assert.deepEqual(after.mailCap, { hour: 30, day: 200 });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(host.confirmation.mailCap().day.count, 2);
  createDemoHost({ storage: f.storage, demo: false, now: () => 1_000 });
  assert.equal(host.confirmation.mailCap().day.count, 2, 'bootstrap is idempotent');
});
