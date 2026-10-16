import { adminCopy } from '../admin-copy.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminFixture } from '../../test/fixtures/admin-host.js';
import { createOperatorSessions, createSQLiteOperatorStore } from '../../packages/server/src/operator-session.js';
import { SQLiteStorage } from '../../packages/server/src/index.js';
import { startChild, temporaryDb } from '../../test/helpers.js';

const routes = [['/admin'], ['/api/operator/admin/state'], ['/api/operator/admin/audit'], ['/api/operator/admin/settings', { baseRevision: 1, confirmationEnabled: false }]];
for (const [path, input] of routes) for (const mode of ['missing', 'expired', 'unconfigured']) {
  test(`AIT-169 ${path}: ${mode} session is refused on every request`, async t => {
    const f = await adminFixture({ configured: mode !== 'unconfigured' }); t.after(f.close);
    if (mode === 'expired') f.advance(8 * 60 * 60_000);
    const r = await f.call(path, input, { headers: { ...(input ? { origin: f.origin, 'content-type': 'application/json' } : {}), cookie: mode === 'missing' ? '' : f.cookie } });
    assert.equal(r.status, mode === 'unconfigured' ? 404 : 401);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('vary'), 'Cookie');
    if (path === '/admin' && mode !== 'unconfigured') assert.match(await r.text(), /return=admin/u);
  });
}
for (const [label, headers, status, body] of [
  ['cross origin', { origin: 'https://evil.test', 'content-type': 'application/json' }, 403],
  ['cross site', { origin: 'https://admin.host.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, 403],
  ['missing origin', { 'content-type': 'application/json' }, 403],
  ['content type', { origin: 'https://admin.host.test', 'content-type': 'text/plain' }, 415],
  ['body bound', { origin: 'https://admin.host.test', 'content-type': 'application/json' }, 413, ' '.repeat(16_385)],
]) test(`AIT-169 POST refuses ${label}`, async t => {
  const f = await adminFixture(); t.after(f.close);
  const response = await f.call('/api/operator/admin/settings', body ?? { baseRevision: 1, confirmationEnabled: true }, { headers: { cookie: f.cookie, ...headers } });
  assert.equal(response.status, status); assert.equal(f.host.visitorCredits.settings().revision, 1);
});
test('AIT-169 operator writes all sections, sanitizes the name and ignores a body subject', async t => {
  const f = await adminFixture({ name: 'A\u0000\n' + 'd'.repeat(150) }); t.after(f.close);
  for (const input of [{ confirmationEnabled: true }, { mailCap: { hour: 10, day: 40 }, mailIpCap: { hour: 2, day: 8 } },
    { allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' } }]) {
    const r = await f.call('/api/operator/admin/settings', { baseRevision: f.host.visitorCredits.settings().revision, ...input, subject: 'forged' });
    assert.equal(r.status, 200);
    const row = f.host.visitorCredits.audit().at(-1);
    assert.equal(row.actor, 'operator:' + ('A' + 'd'.repeat(150)).slice(0, 120) + '#verified-subject'); assert.equal(row.source, 'operator');
  }
});
test('AIT-169 audit actor has one subject delimiter when the operator name contains #', async t => {
  const f = await adminFixture({ name: 'Ada#Admin\u0000\n' }); t.after(f.close);
  const r = await f.call('/api/operator/admin/settings', { baseRevision: 1, confirmationEnabled: true });
  assert.equal(r.status, 200);
  const actor = f.host.visitorCredits.audit().at(-1).actor;
  assert.equal(actor, 'operator:AdaAdmin#verified-subject');
  assert.deepEqual(actor.split('#'), ['operator:AdaAdmin', 'verified-subject']);
});
for (const locale of ['de', 'en']) for (const ErrorType of [Error, TypeError, SyntaxError]) {
  test(`AIT-169 page build failure is minimal HTML; API stays JSON (${locale}, ${ErrorType.name})`, async t => {
    const f = await adminFixture(); t.after(f.close);
    f.host.visitorCredits.adminAudit = () => { throw new ErrorType('private-host-data: do not expose'); };
    const response = await f.call('/admin?lang=' + locale);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const copy = adminCopy[locale].failed;
    assert.equal(await response.text(), `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${locale === 'en' ? 'Admin' : 'Verwaltung'} · Aithema</title></head><body><p>${copy}</p></body></html>`);
    const api = await f.call('/api/operator/admin/audit');
    assert.equal(api.status, ErrorType === Error ? 503 : 400);
    assert.match(api.headers.get('content-type'), /^application\/json/u);
    assert.deepEqual(await api.json(), { error: ErrorType === Error ? 'host-settings-unavailable' : 'invalid-admin-command' });
  });
}
test('AIT-169 stale revision exposes current.updatedAt, invalid tier order fails and writes are POST only', async t => {
  const f = await adminFixture(); t.after(f.close);
  assert.equal((await f.call('/api/operator/admin/settings', { baseRevision: 1, confirmationEnabled: true })).status, 200);
  const r = await f.call('/api/operator/admin/settings', { baseRevision: 1, confirmationEnabled: false });
  assert.equal(r.status, 409); assert.equal((await r.json()).current.updatedAt, f.host.visitorCredits.settings().updatedAt);
  assert.equal((await f.call('/api/operator/admin/settings', { baseRevision: 2, allowancesUsd: { anonymous: '15', emailGiven: '10', emailConfirmed: '20' } })).status, 400);
  assert.equal((await f.call('/api/operator/admin/settings')).status, 405);
  assert.equal((await f.call('/api/operator/admin/settings', {}, { method: 'PUT' })).status, 405);
});
test('AIT-169 confirmation still requires qualified delivery', async t => {
  const f = await adminFixture({ delivery: false }); t.after(f.close);
  assert.equal((await f.call('/api/operator/admin/state')).status, 200);
  assert.equal((await f.call('/api/operator/admin/settings', { baseRevision: 1, confirmationEnabled: true })).status, 400);
  assert.equal(f.host.visitorCredits.settings().confirmationEnabled, false);
});
test('AIT-169 busiest connection uses rolling aggregates and exposes numbers only', async t => {
  const f = await adminFixture(); t.after(f.close);
  const insert = f.storage.db.prepare('INSERT INTO host_mail_ip_slots VALUES (?,?,?)');
  insert.run('secret-address-bucket-a', f.now() - 1000, 2); insert.run('secret-address-bucket-a', f.now() - 3_600_000, 5);
  insert.run('secret-address-bucket-b', f.now() - 1000, 4); insert.run('expired-bucket', f.now() - 86_400_000, 100);
  const state = await (await f.call('/api/operator/admin/state')).json();
  assert.deepEqual(state.busiestConnection, { hour: 4, day: 7 });
  assert.equal(JSON.stringify(state).includes('bucket'), false); assert.equal(JSON.stringify(state).includes('verified-subject'), false);
});
test('AIT-169 audit: 20 newest first, before cursor, confirmation evidence excluded, mail-cap retained', async t => {
  const f = await adminFixture(); t.after(f.close);
  for (let i = 0; i < 43; i++) f.host.visitorCredits.auditMailCap({ window: 'hour', count: i });
  f.host.visitorCredits.auditEvent('confirmation.delivery', { visitorRef: 'private-visitor', outcome: 'sent' });
  let before, ids = [], pages = 0;
  do {
    const r = await f.call('/api/operator/admin/audit' + (before ? '?before=' + before : ''));
    const p = await r.json(); assert.equal(r.status, 200);
    assert.equal(p.items.length, pages < 2 ? 20 : 4);
    assert.ok(p.items.every(i => !i.newValues.event?.startsWith('confirmation.')));
    ids.push(...p.items.map(i => i.id)); before = p.nextBefore; pages++;
  } while (before);
  assert.equal(pages, 3); assert.equal(new Set(ids).size, 44); assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  assert.equal((await f.call('/api/operator/admin/audit?before=-1')).status, 400);
  assert.equal((await f.call('/api/operator/admin/audit?limit=10')).status, 400);
});
test('AIT-169 locked provider snapshot: reason only, no new latch table; CLI precision remains exact', async t => {
  const f = await adminFixture(); t.after(f.close);
  f.spendCap.settle(f.spendCap.reserve(100_000), 110_000);
  const state = await (await f.call('/api/operator/admin/state')).json();
  assert.equal(state.providerCap.breach.reason, 'overrun'); assert.equal(Object.hasOwn(state.providerCap.breach, 'at'), false);
  assert.equal(f.storage.db.prepare("SELECT name FROM sqlite_master WHERE name='spend_cap_latch'").get(), undefined);
  f.host.visitorCredits.saveSettings({ baseRevision: 1, allowancesUsd: { anonymous: '10.123456', emailGiven: '15.654321', emailConfirmed: '20.999999' } }, { source: 'ops-cli', actor: 'ops-cli:precision' });
  assert.equal((await f.call('/api/operator/admin/settings', { baseRevision: 2, allowancesUsd: { anonymous: '10.123456', emailGiven: '18', emailConfirmed: '20.999999' } })).status, 200);
  assert.deepEqual(f.host.visitorCredits.settings().allowancesMicro, { anonymous: 10_123_456, emailGiven: 18_000_000, emailConfirmed: 20_999_999 });
});
for (const value of ['admin', 'ADMIN', '/admin', 'https://evil.test', '//evil.test', '', 'admin&return=admin']) test(`AIT-169 sealed return allowlist: ${value}`, async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const origin = 'https://operator.host.test', state = 's'.repeat(43);
  const provider = { label: 'stub', sessionNamespace: 'stub', allows: () => true,
    begin: () => ({ pending: { state, nonce: 'n'.repeat(43), verifier: 'v'.repeat(64) }, url: origin + '/stub' }),
    complete: async () => ({ name: 'Ada', subject: 'verified' }) };
  const sessions = createOperatorSessions({ provider, store: createSQLiteOperatorStore(storage.db), publicOrigin: origin });
  const login = await sessions.handle(new Request(origin + '/api/operator/login/?return=' + encodeURIComponent(value)));
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const callback = await sessions.handle(new Request(origin + '/api/operator/callback/?code=stub&state=' + state + '&return=admin', { headers: { cookie } }));
  assert.equal(callback.headers.get('location'), value === 'admin' ? '/admin' : '/#settings-general');
});
test('AIT-169 real host mounts admin and serves its CSP-clean script; feature off is 404', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb()); t.after(() => running.kill());
  assert.equal((await fetch(running.url + '/admin')).status, 404);
  const r = await fetch(running.url + '/demo/admin-page.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/u);
});


for (const locale of ['de', 'en']) test(`AIT-247 admin page renders erasure audit entries (${locale})`, async t => {
  const f = await adminFixture(); t.after(f.close);
  for (const [visitor, result] of [[false, 'erased'], [true, 'already-erased'], [null, 'invalid-admin-command']]) {
    f.host.visitorCredits.auditErasure({ sessionId: visitor === null ? null : 'erased-fixture', visitor, result }, { actor: 'ops-cli:fixture' });
  }
  const response = await f.call('/admin?lang=' + locale);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /erased-fixture/u);
  assert.match(html, /already-erased/u);
  assert.match(html, /invalid-admin-command/u);
  assert.ok(html.includes(locale === 'en' ? 'Erasure:' : 'Löschung:'));
});
