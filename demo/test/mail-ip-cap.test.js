import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createDemoHost } from '../host-ports.js';
import { listenAdmin, adminRequest } from '../admin-socket.js';
import { mockConsent, temporaryDb } from '../../test/helpers.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, peer = '192.0.2.19';
const actor = { actor: 'ops-cli:test', source: 'ops-cli' };
async function resolver(header) {
  const { createClientIpResolver } = await import('../client-ip.js');
  return createClientIpResolver({ header });
}
const request = xff => new Request('http://local/', { headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('AIT-167 IP header trust is off by default, ignores X-Real-IP, and refuses unsupported configuration', async () => {
  const resolve = await resolver();
  assert.equal(resolve(request('198.51.100.22'), { remoteAddress: peer }), peer);
  const trusted = await resolver('x-forwarded-for');
  assert.equal(trusted(new Request('http://local/', { headers: { 'x-real-ip': '198.51.100.22' } }), { remoteAddress: peer }), peer);
  await assert.rejects(() => resolver('x-real-ip'), /client.*IP.*header/iu);
});

test('AIT-167 uses the right-most XFF literal, never an earlier client-controlled entry', async () => {
  const resolve = await resolver('x-forwarded-for');
  assert.equal(resolve(request('spoofed, 198.51.100.22,  203.0.113.42 '), { remoteAddress: peer }), '203.0.113.42');
});

for (const xff of [undefined, '', '198.51.100.22, garbage', '198.51.100.22,', 'host.example.test',
  '192.0.2.1:443', '[2001:db8::1]', 'fe80::1%en0', '010.0.0.1']) {
  test(`AIT-167 missing/invalid XFF ${JSON.stringify(xff)} falls back to the socket peer`, async () => {
    const resolve = await resolver('x-forwarded-for');
    assert.equal(resolve(request(xff), { remoteAddress: peer }), peer);
  });
}

test('AIT-167 IPv6 addresses share a canonical /64, including expanded spellings and socket fallback', async () => {
  const resolve = await resolver('x-forwarded-for');
  const bucket = '2001:0db8:0001:0002::/64';
  for (const ip of ['2001:db8:1:2::1', '2001:DB8:0001:0002:abcd:ef01:2345:6789', '2001:db8:1:2::192.0.2.1']) {
    assert.equal(resolve(request(ip), { remoteAddress: peer }), bucket);
  }
  assert.equal(resolve(request(), { remoteAddress: '2001:db8:1:2::9' }), bucket);
  assert.notEqual(resolve(request('2001:db8:1:3::1'), { remoteAddress: peer }), bucket);
  assert.equal(resolve(request('::ffff:192.0.2.19'), { remoteAddress: peer }), peer);
  assert.equal(resolve(request('0:0:0:0:0:ffff:c000:213'), { remoteAddress: peer }), peer);
});

async function fixture(t, options = {}) {
  let time = options.time ?? 1_000;
  const storage = options.storage ?? new SQLiteStorage();
  t.after(() => { if (storage.db.isOpen) storage.close(); });
  const messages = [];
  const host = createDemoHost({ storage, demo: false, now: () => time, clientIpHeader: 'x-forwarded-for',
    privacyDocumentConfigured: () => true, mailPlugin: { id: 'smtp', deliversVerification: true,
      async requestVerification(effect, callOptions) { messages.push({ effect, callOptions }); return { status: 'sent' }; } }, ...options });
  const settings = () => host.visitorCredits.settings();
  host.visitorCredits.saveSettings({ baseRevision: settings().revision, confirmationEnabled: true }, actor);
  const set = mailIpCap => host.visitorCredits.saveSettings({ baseRevision: settings().revision, mailIpCap }, actor);
  const handlers = createHandlers({ storage, host, consent: mockConsent, now: () => time });
  t.after(() => handlers.close());
  const call = async (owner, { xff = '203.0.113.42', remoteAddress = peer, address = `${owner}@example.test`,
    command = 'request', session } = {}) => {
    const s = session ?? storage.create({ ownerToken: owner, locale: 'de' });
    const response = await handlers.handle(new Request(`http://local/api/sessions/${s.id}/identity/${command}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner,
        ...(xff === null ? {} : { 'x-forwarded-for': xff }) },
      body: JSON.stringify(['request', 'change'].includes(command) ? { address } : {}),
    }), { remoteAddress });
    return { status: response.status, headers: [...response.headers], body: await response.json() };
  };
  return { storage, host, messages, handlers, settings, set, call, at: value => { time = value; } };
}

for (const enabled of [false, true]) test(`AIT-168 confirmation ${enabled ? 'enabled sends' : 'disabled saves without sending or reserving caps'} on request, resend and change`, async t => {
  const f = await fixture(t);
  f.host.visitorCredits.saveSettings({ baseRevision: f.settings().revision, confirmationEnabled: enabled }, actor);
  const owner = 'confirmation-gate', session = f.storage.create({ ownerToken: owner });
  // AIT-164 saves the address before asking for a link. Pending-only API
  // identities intentionally do not grant the independently saved tier.
  f.host.saveEmail(owner, { address: `${owner}@example.test`, noticeVersion: 'ait-135-v1' });
  for (const [i, command] of ['request', 'resend', 'change'].entries()) {
    f.at(1_000 + i * 60_000);
    const address = command === 'change' ? 'changed@example.test' : `${owner}@example.test`;
    const response = await f.call(owner, { session, command, address });
    assert.equal(response.status, 200);
    assert.equal(response.body.identity.delivery, 'sent', 'accepted responses reveal no delivery suppression');
    await f.handlers.idle();
    assert.equal(f.host.visitor(owner).address, address);
    assert.equal(f.host.visitor(owner).tier, 'emailGiven');
    assert.equal(f.host.creditTiers(owner).canConfirm, enabled);
    assert.equal(f.messages.length, enabled ? i + 1 : 0);
    assert.equal(f.host.confirmation.mailCap().hour.count, enabled ? i + 1 : 0);
    assert.equal(f.host.confirmation.mailCap().day.count, enabled ? i + 1 : 0);
  }
  if (!enabled) {
    for (const table of ['visitor_confirmation_tokens', 'visitor_mail_deliveries', 'visitor_mail_abuse',
      'host_mail_slots', 'host_mail_cap_alerts', 'host_mail_ip_slots', 'host_mail_ip_alerts']) {
      assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table}: no reservation or suppression metadata`);
    }
    // Read the policy at delivery time, so OPS can re-enable a running host.
    f.host.visitorCredits.saveSettings({ baseRevision: f.settings().revision, confirmationEnabled: true }, actor);
    f.at(181_000); await f.call(owner, { session, command: 'resend' }); await f.handlers.idle();
    assert.equal(f.messages.length, 1);
    assert.equal(f.host.confirmation.mailCap().hour.count, 1);
  }
});

test('AIT-167 concurrent request limits default to 5/hour and 20/day and spare the global cap', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => f.call(`flood-${i}`)));
  await f.handlers.idle();
  assert.ok(responses.every(r => r.status === 200 && r.body.identity.delivery === 'sent'));
  assert.equal(f.messages.length, 5);
  assert.deepEqual(f.settings().mailIpCap, { hour: 5, day: 20 });
  assert.equal(f.host.confirmation.mailCap().hour.count, 5);
  await f.call('other-ip', { xff: '203.0.113.43' }); await f.handlers.idle();
  assert.equal(f.messages.length, 6);
  f.at(HOUR + 999); await f.call('before-hour'); await f.handlers.idle(); assert.equal(f.messages.length, 6);
  f.at(HOUR + 1_000); await f.call('at-hour'); await f.handlers.idle(); assert.equal(f.messages.length, 7);
});

test('AIT-167 request routing respects opt-in trust, invalid header fallback and IPv6 buckets', async t => {
  const f = await fixture(t, { clientIpHeader: undefined });
  for (let i = 0; i < 7; i++) await f.call(`untrusted-${i}`, { xff: `203.0.113.${i + 1}` });
  await f.handlers.idle(); assert.equal(f.messages.length, 5);
  const g = await fixture(t);
  for (let i = 0; i < 7; i++) await g.call(`v6-${i}`, { xff: `198.51.100.${i}, 2001:db8:1:2::${i + 1}` });
  await g.handlers.idle(); assert.equal(g.messages.length, 5);
  await g.call('v6-other', { xff: '2001:db8:1:3::1' });
  for (let i = 0; i < 7; i++) await g.call(`fallback-${i}`, { xff: i % 2 ? '198.51.100.1, invalid' : null });
  await g.handlers.idle(); assert.equal(g.messages.length, 11);
});

test('AIT-167 default rolling day admits 20 requests across hourly windows', async t => {
  const f = await fixture(t);
  for (let hour = 0; hour < 4; hour++) {
    f.at(1_000 + hour * HOUR);
    await Promise.all(Array.from({ length: 5 }, (_, i) => f.call(`day-${hour}-${i}`)));
    await f.handlers.idle();
    assert.equal(f.messages.length, (hour + 1) * 5);
  }
  f.at(1_000 + 4 * HOUR); await f.call('day-full'); await f.handlers.idle();
  assert.equal(f.messages.length, 20); assert.equal(f.host.confirmation.mailCap().day.count, 20);
  f.at(1_000 + DAY); await f.call('day-expired'); await f.handlers.idle(); assert.equal(f.messages.length, 21);
});

test('AIT-167 database scan contains no raw IPv4, IPv6, forwarded chain or /64 bucket', async t => {
  const f = await fixture(t);
  const inputs = ['203.0.113.42', '198.51.100.1, 2001:db8:1:2::1', 'invalid'];
  for (const [i, xff] of inputs.entries()) { await f.call(`privacy-${i}`, { xff }); await f.handlers.idle(); }
  const tables = f.storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const dump = JSON.stringify(tables.map(({ name }) => f.storage.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
  for (const raw of [...inputs, peer, '198.51.100.1', '2001:db8:1:2::1', '2001:0db8:0001:0002::/64']) {
    if (raw !== 'invalid') assert.equal(dump.includes(raw), false);
  }
  assert.equal(f.messages.length, 3);
  const transport = JSON.stringify(f.messages);
  for (const raw of [peer, '203.0.113.42', '2001:db8:1:2::1', '2001:0db8:0001:0002::/64']) assert.equal(transport.includes(raw), false);
});

test('AIT-167 real HTTP adapter supplies the socket peer without trusting a forged peer header', async t => {
  const f = await fixture(t, { clientIpHeader: undefined });
  const { server, url } = await listen(f.handlers.handle);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const seen = [];
  const original = f.host.identity.clientIpBucket;
  t.mock.method(f.host.identity, 'clientIpBucket', (req, context) => { seen.push(context.remoteAddress); return original(req, context); });
  for (let i = 0; i < 7; i++) {
    const owner = `socket-${i}`, s = f.storage.create({ ownerToken: owner });
    const response = await fetch(`${url}/api/sessions/${s.id}/identity/request`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner,
        'x-forwarded-for': `203.0.113.${i}`, 'x-real-ip': `198.51.100.${i}`, 'remote-address': `192.0.2.${i}` },
      body: JSON.stringify({ address: `${owner}@example.test` }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  await f.handlers.idle(); assert.equal(f.messages.length, 5);
  assert.ok(seen.every(ip => ip === '127.0.0.1'));
});

test('AIT-167 IP accounting and log claims survive erasure/restart, expire in bounded batches after 24h, and use HMAC only', async t => {
  const logs = []; t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
  const path = await temporaryDb(), f = await fixture(t, { storage: new SQLiteStorage(path) });
  f.set({ hour: 1, day: 2 });
  await f.call('persist-one'); await f.handlers.idle();
  for (const owner of ['persist-blocked', 'persist-blocked-again']) { await f.call(owner); await f.handlers.idle(); }
  assert.equal(logs.length, 1);
  const rows = f.storage.db.prepare('SELECT * FROM host_mail_ip_slots').all();
  const key = await readFile(join(dirname(path), 'confirmation-hmac.key'));
  assert.equal(rows[0].bucket_key, createHmac('sha256', key).update('ip\0' + '203.0.113.42').digest('hex'));
  assert.notEqual(rows[0].bucket_key, createHash('sha256').update('203.0.113.42').digest('hex'));
  assert.deepEqual(logs[0], { event: 'mail-ip-cap', window: 'hour', bucket: rows[0].bucket_key.slice(0, 12) });
  f.host.eraseVisitor('persist-one'); await f.handlers.close(); f.storage.close();
  const g = await fixture(t, { storage: new SQLiteStorage(path) });
  await g.call('after-restart'); await g.handlers.idle(); assert.equal(g.messages.length, 0); assert.equal(logs.length, 1);
  g.at(HOUR + 1_000); await g.call('persist-two'); await g.handlers.idle(); assert.equal(g.messages.length, 1);
  await g.call('both-full'); await g.call('both-full-again'); await g.handlers.idle();
  assert.deepEqual(logs.map(l => l.window), ['hour', 'hour', 'day']);
  const tables = g.storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const dump = JSON.stringify(tables.map(({ name }) => g.storage.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
  for (const raw of ['203.0.113.42', peer, '2001:db8:1:2::1', '2001:0db8:0001:0002::/64']) assert.equal(dump.includes(raw), false);
  assert.equal(JSON.stringify(g.messages).includes('203.0.113.42'), false, 'mail transport never receives IP metadata');
  g.at(DAY + 999); await g.call('before-day'); await g.handlers.idle(); assert.equal(g.messages.length, 1);
  g.at(DAY + 1_000); await g.call('at-day'); await g.handlers.idle(); assert.equal(g.messages.length, 2);
  g.at(2 * DAY + HOUR + 1_000);
  for (let i = 0; i < 10; i++) g.host.retainVisitors({ limit: 1 });
  for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) assert.equal(g.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('AIT-167 IP reservation rolls back atomically with C1, global cap and token creation', async t => {
  const f = await fixture(t);
  f.storage.db.prepare('INSERT INTO host_mail_ip_slots VALUES (?, ?, 1)').run('expired', 1_000);
  f.storage.db.prepare('INSERT INTO host_mail_ip_alerts VALUES (?,\'day\',?)').run('expired', 1_000);
  f.at(DAY + 1_000);
  t.mock.method(f.host.visitorCredits, 'createToken', () => { throw new Error('synthetic token failure'); });
  await f.call('rollback'); await f.handlers.idle();
  assert.equal(f.messages.length, 0);
  for (const table of ['host_mail_slots', 'visitor_mail_abuse', 'visitor_confirmation_tokens']) {
    assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
  for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) {
    assert.equal(f.storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 1, 'expired-row cleanup also rolls back');
    assert.equal(f.storage.db.prepare(`SELECT bucket_key FROM ${table}`).get().bucket_key, 'expired');
  }
});

test('AIT-167 reserve physically deletes expired IP rows in bounded, idempotent batches', async t => {
  const f = await fixture(t), db = f.storage.db;
  for (let i = 0; i < 101; i++) {
    db.prepare('INSERT INTO host_mail_ip_slots VALUES (?,?,1)').run(`expired-${i}`, 1_000);
    db.prepare('INSERT INTO host_mail_ip_alerts VALUES (?,\'day\',?)').run(`expired-${i}`, 1_000);
  }
  db.prepare('INSERT INTO host_mail_ip_slots VALUES (?, ?, 1)').run('fresh', 1_002);
  db.prepare('INSERT INTO host_mail_ip_alerts VALUES (?,\'day\',?)').run('fresh', 1_002);
  f.at(DAY + 1_001);
  for (let pass = 0; pass < 3; pass++) {
    await f.call(`cleanup-${pass}`, { xff: '203.0.113.99' }); await f.handlers.idle();
    for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE bucket_key LIKE 'expired-%'`).get().n,
        pass === 0 ? 1 : 0, `${table}: at most 100 expired rows removed per reservation`);
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE bucket_key='fresh'`).get().n, 1);
    }
  }
  assert.equal(f.messages.length, 3);
});

test('AIT-167 hourly maintenance physically deletes idle IP rows by 25h and drains bounded batches', async t => {
  const { startVisitorRetention } = await import('../session-lifecycle.js');
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1_000 });
  const f = await fixture(t, { now: () => Date.now() }), db = f.storage.db;
  const maintenance = startVisitorRetention(f.host);
  t.after(() => maintenance.close());
  // Created immediately after startup: the 24h tick is one millisecond early.
  for (let i = 0; i < 205; i++) {
    db.prepare('INSERT INTO host_mail_ip_slots VALUES (?,?,1)').run(`idle-${i}`, 1_001);
    db.prepare('INSERT INTO host_mail_ip_alerts VALUES (?,\'day\',?)').run(`idle-${i}`, 1_001);
  }
  t.mock.timers.tick(DAY);
  for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 205);
  }
  const batches = [];
  const retain = f.host.retainVisitors.bind(f.host);
  t.mock.method(f.host, 'retainVisitors', options => { const result = retain(options); batches.push(result); return result; });
  t.mock.timers.tick(HOUR);
  assert.equal(batches.length, 1);
  for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 105, 'hourly batch is bounded');
  }
  t.mock.timers.tick(10); t.mock.timers.tick(10);
  assert.deepEqual(batches.map(result => result.pending), [200, 200, 10]);
  for (const table of ['host_mail_ip_slots', 'host_mail_ip_alerts']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
  t.mock.timers.tick(HOUR);
  assert.equal(batches.at(-1).pending, 0, 'repeated hourly sweep is idempotent');
  maintenance.close(); const count = batches.length;
  t.mock.timers.tick(HOUR); assert.equal(batches.length, count, 'shutdown stops maintenance');
});

test('AIT-167 an IP log window remains claimed when an earlier slot expires', async t => {
  const logs = []; t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
  const f = await fixture(t); f.set({ hour: 2, day: 20 });
  await f.call('log-one'); await f.handlers.idle();
  f.at(2_000); await f.call('log-two'); await f.handlers.idle();
  f.at(3_000); await f.call('log-suppressed'); await f.handlers.idle(); assert.equal(logs.length, 1);
  f.at(HOUR + 1_000); await f.call('log-freed'); await f.handlers.idle(); assert.equal(f.messages.length, 3);
  f.at(HOUR + 1_001); await f.call('log-still-suppressed'); await f.handlers.idle(); assert.equal(logs.length, 1);
  f.at(HOUR + 3_000); await f.call('log-next-window'); await f.handlers.idle();
  // The second old slot has now expired, allowing one request. A fresh
  // suppression at the same timestamp starts the next alert window.
  await f.call('log-next-window-suppressed'); await f.handlers.idle(); assert.equal(logs.length, 2);
});

test('AIT-167 suppressed/allowed responses and scheduling match before SMTP or IP accounting runs', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }), sent = [];
  const f = await fixture(t, { mailPlugin: { id: 'smtp', deliversVerification: true,
    async requestVerification(effect) { sent.push(effect); await held; return { status: 'sent' }; } } });
  t.after(() => release()); f.set({ hour: 1, day: 2 });
  const beforeDispatch = async owner => {
    const response = await f.call(owner, { address: 'shared@example.test' });
    assert.equal(response.status, 200); assert.equal(response.body.identity.delivery, 'sent');
    return response;
  };
  try {
    const allowed = await beforeDispatch('allowed');
    assert.equal(sent.length, 0); assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM host_mail_ip_slots').get().n, 0);
    await new Promise(resolve => setImmediate(resolve));
    const suppressed = await beforeDispatch('suppressed');
    assert.deepEqual(suppressed, allowed);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 1);
  } finally { release(); await f.handlers.idle(); }
});

test('AIT-167 only identity/request is IP throttled; resend and change retain C1/global behavior', async t => {
  const f = await fixture(t); f.set({ hour: 0, day: 0 });
  const owner = 'route-scope', s = f.storage.create({ ownerToken: owner, locale: 'de' });
  await f.call(owner, { session: s }); await f.handlers.idle(); assert.equal(f.messages.length, 0);
  f.at(61_000); await f.call(owner, { session: s, command: 'resend' }); await f.handlers.idle(); assert.equal(f.messages.length, 1);
  f.at(121_000); await f.call(owner, { session: s, command: 'change', address: 'changed@example.test' });
  await f.handlers.idle(); assert.equal(f.messages.length, 2);
  assert.equal(f.host.confirmation.mailCap().hour.count, 2);
});

test('AIT-167 OPS CLI views/sets IP limits with ceilings, audited revisions, zero and strict payloads', async t => {
  const f = await fixture(t), before = f.settings();
  const path = join(await mkdtemp(join(tmpdir(), 'ait-ip-cli-')), 'ops.sock');
  const admin = await listenAdmin({ host: f.host, socketPath: path }); t.after(() => admin.close());
  const run = (...args) => promisify(execFile)(process.execPath, ['demo/admin-cli.js', '--socket', path, ...args]);
  assert.deepEqual(JSON.parse((await run('settings')).stdout).mailIpCap, { hour: 5, day: 20 });
  const saved = JSON.parse((await run('set-mail-ip-cap', '--base-revision', String(before.revision), '--hour', '2', '--day', '5')).stdout);
  assert.equal(saved.revision, before.revision + 1); assert.deepEqual(saved.mailIpCap, { hour: 2, day: 5 });
  assert.deepEqual(saved.mailCap, before.mailCap); assert.deepEqual(saved.allowancesMicro, before.allowancesMicro);
  assert.equal(saved.confirmationEnabled, before.confirmationEnabled);
  const audit = f.host.visitorCredits.audit().at(-1); assert.deepEqual(audit.oldValues.mailIpCap, before.mailIpCap);
  assert.deepEqual(audit.newValues.mailIpCap, saved.mailIpCap); assert.equal(audit.source, 'ops-cli');
  assert.equal((await adminRequest(path, 'set-mail-ip-cap', { baseRevision: before.revision, mailIpCap: { hour: 1, day: 2 } })).status, 409);
  assert.throws(() => f.host.visitorCredits.saveSettings({ baseRevision: saved.revision, mailIpCap: { hour: 1, day: 2 } }), /OPS/u);
  for (const cap of [{ hour: -1, day: 5 }, { hour: 1.5, day: 5 }, { hour: '1', day: 5 }, { hour: 1 },
    { hour: 2, day: 1 }, { hour: 1_001, day: 10_000 }, { hour: 1_000, day: 10_001 }, { hour: 1, day: 5, ip: peer }]) {
    const revision = f.settings().revision, history = f.host.visitorCredits.audit();
    assert.equal((await adminRequest(path, 'set-mail-ip-cap', { baseRevision: revision, mailIpCap: cap })).status, 400);
    assert.equal(f.settings().revision, revision); assert.deepEqual(f.host.visitorCredits.audit(), history);
  }
  assert.equal((await adminRequest(path, 'set-allowances', { baseRevision: saved.revision, mailIpCap: { hour: 1, day: 2 } })).status, 400);
  assert.equal((await adminRequest(path, 'set-mail-ip-cap', { baseRevision: saved.revision, mailIpCap: { hour: 1, day: 2 }, mailCap: { hour: 1, day: 2 } })).status, 400);
  await assert.rejects(() => run('set-mail-ip-cap', '--base-revision', String(saved.revision), '--hour', '1001', '--day', '10000'), error => /hour.*1000/iu.test(error.stderr));
  for (const cap of [{ hour: 1_000, day: 10_000 }, { hour: 1_000, day: 1_000 }, { hour: 0, day: 0 }]) {
    const result = JSON.parse((await run('set-mail-ip-cap', '--base-revision', String(f.settings().revision), '--hour', String(cap.hour), '--day', String(cap.day))).stdout);
    assert.deepEqual(result.mailIpCap, cap);
  }
});

test('AIT-167 IP settings migration is audited once and preserves existing global/C1 accounting', async t => {
  const f = await fixture(t); await f.call('migration'); await f.handlers.idle();
  const before = f.settings(), global = f.host.confirmation.mailCap().hour.count;
  for (const column of ['mail_ip_cap_hour', 'mail_ip_cap_day']) f.storage.db.exec(`ALTER TABLE visitor_credit_settings DROP COLUMN ${column}`);
  const host = createDemoHost({ storage: f.storage, demo: false, now: () => 1_000 });
  const after = host.visitorCredits.settings();
  assert.deepEqual(after.mailIpCap, { hour: 5, day: 20 }); assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.mailCap, before.mailCap); assert.deepEqual(after.allowancesMicro, before.allowancesMicro);
  assert.equal(host.confirmation.mailCap().hour.count, global);
  assert.equal(host.visitorCredits.audit().at(-1).source, 'migration');
  createDemoHost({ storage: f.storage }); assert.equal(host.visitorCredits.settings().revision, after.revision);
});
