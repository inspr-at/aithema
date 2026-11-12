import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { createIdentity } from '@inspr/aithema-core';
import { createSmtpMail, smtpConfig } from '../../plugins/mail-smtp/src/index.js';
import { createDemoHost } from '../host-ports.js';
import { createConfirmationPage } from '../confirmation-page.js';
import { mockConsent } from '../../test/helpers.js';

const refused = ['a(b)@example.com', '"a"@example.com', 'a\ud800b@example.com', 'a\ue000b@example.com', 'a\u0378b@example.com'];
const tables = ['host_mail_slots', 'host_mail_ip_slots', 'visitor_mail_abuse', 'visitor_mail_deliveries', 'visitor_confirmation_tokens'];
function fixture(t, mode, storage = new SQLiteStorage()) {
  let time = Date.now(); const messages = [];
  const mailPlugin = mode === 'smtp' ? createSmtpMail({
    config: smtpConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'sender@example.test' }),
    publicOrigin: 'https://public.example.test',
    createTransport: () => ({ async sendMail(message) { messages.push(message); }, close() {} }),
  }) : undefined;
  const host = createDemoHost({ storage, demo: mode === 'demo', mailPlugin, now: () => time,
    privacyDocumentConfigured: () => true });
  const settings = host.visitorCredits.settings();
  if (mode !== 'off') host.visitorCredits.saveSettings({ baseRevision: settings.revision, confirmationEnabled: true }, { actor: 'ops-cli:test', source: 'ops-cli' });
  const handlers = createHandlers({ storage, host, consent: mockConsent });
  t.after(async () => { await handlers.close(); mailPlugin?.close(); storage.close(); });
  const call = (owner, path, body, method = body === undefined ? 'GET' : 'POST') => handlers.handle(new Request(`http://local${path}`, {
    method, headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const counts = () => tables.map(table => storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  return { storage, host, handlers, messages, call, counts, at: value => { time = value; }, now: () => time };
}
for (const mode of ['smtp', 'demo', 'off']) {
  test(`AIT-494 real delivery predicate refuses new input without reservations (${mode})`, async t => {
    const f = fixture(t, mode), owner = 'refused';
    const s = await (await f.call(owner, '/api/sessions', {})).json();
    await f.call(owner, `/api/sessions/${s.id}/identity`);
    const rows = () => f.storage.db.prepare('SELECT * FROM visitor_identities ORDER BY visitor_ref').all();
    const before = rows(), counts = f.counts(), journal = f.storage.read(s.id);
    for (const address of refused) for (const route of ['request', 'change', 'PUT', 'POST']) {
      const r = ['PUT', 'POST'].includes(route)
        ? await f.call(owner, '/api/visitor/email', { address, noticeVersion: 'ait-135-v1' }, route)
        : await f.call(owner, `/api/sessions/${s.id}/identity/${route}`, { address });
      assert.equal(r.status, 400, `${route}: ${JSON.stringify(address)}`);
      assert.deepEqual(await r.json(), { error: 'invalid-request' });
      assert.deepEqual(rows(), before); assert.deepEqual(f.counts(), counts);
      assert.deepEqual(f.storage.read(s.id), journal);
    }
    await f.handlers.idle(); assert.equal(f.messages.length, 0); assert.deepEqual(f.counts(), [0, 0, 0, 0, 0]);
  });
  if (mode !== 'off') test(`AIT-494 valid ASCII and IDN input still delivers (${mode})`, async t => {
    const f = fixture(t, mode);
    for (const [i, address] of ['user@bücher.example', 'user@BÜCHER.example', 'user@example.com'].entries()) {
      const owner = `valid-${i}`, s = await (await f.call(owner, '/api/sessions', {})).json();
      const r = await f.call(owner, `/api/sessions/${s.id}/identity/request`, { address });
      assert.equal(r.status, 200); assert.equal((await r.json()).identity.delivery, 'sent');
    }
    await f.handlers.idle();
    assert.equal(f.counts().at(-1), 3);
    if (mode === 'smtp') assert.equal(f.messages.length, 3);
  });
}

for (const mode of ['smtp', 'demo']) for (const address of ['a(b)@example.com', 'a\ue000b@example.com']) {
  for (const seed of ['saved', 'pending', 'legacy']) {
    test(`AIT-494 stored ${seed} address is safe and resend fails (${mode}, ${JSON.stringify(address)})`, async t => {
      const storage = new SQLiteStorage(), owner = 'stored', time = Date.now();
      const session = storage.create({ ownerToken: owner, locale: 'en' });
      const identity = { ...createIdentity(), address, status: 'verification-pending', verificationRevision: 1,
        delivery: 'sent', lastNow: time, expiresAt: time + 1_800_000, resendAt: 0 };
      if (seed === 'legacy') {
        storage.transitionHost(session.id, () => ({ state: { identity }, events: [] }), { ownerToken: owner });
      } else {
        const old = createDemoHost({ storage, now: () => time });
        if (seed === 'saved') old.saveEmail(owner, { address, noticeVersion: 'ait-135-v1' });
        old.visitorCredits.persistIdentity(session.ownerHash, identity);
      }
      const f = fixture(t, mode, storage);
      const state = await f.call(owner, `/api/sessions/${session.id}/identity`); assert.equal(state.status, 200);
      assert.equal((await f.call(owner, `/api/sessions/${session.id}/pause`, { paused: true })).status, 200);
      assert.equal((await f.call(owner, `/api/sessions/${session.id}/pause`, { paused: false })).status, 200);
      // Exercise the confirmation store's address normalization with a valid old
      // token, including both inspect and redemption, before the resend revokes it.
      const visitor = f.host.visitor(owner), token = f.host.confirmation.reserve({ ownerHash: session.ownerHash,
        sessionId: session.id, address, revision: visitor.addressRevision, expiresAt: f.now() + 1_800_000, locale: 'en' });
      assert.equal(token.status, 'reserved');
      f.host.confirmation.delivered(token.token, 'sent');
      assert.doesNotThrow(() => f.host.confirmation.inspect(token.token));
      assert.doesNotThrow(() => f.host.confirmation.redeem(token.token + 'wrong'));
      const origin = 'https://public.example.test', page = createConfirmationPage({ host: f.host, publicOrigin: origin, now: f.now });
      const response = await page.handle(new Request(`${origin}/confirm-email?token=${encodeURIComponent(token.token)}`));
      assert.equal(response.status, 200); assert.match(await response.text(), /data-confirmation-state="valid"/u);
      const cookie = response.headers.get('set-cookie').split(';')[0], cookieValue = cookie.slice(cookie.indexOf('=') + 1);
      const wrongToken = token.token + 'wrong';
      const redeemed = await page.handle(new Request(`${origin}/confirm-email`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: wrongToken, csrf: f.host.confirmation.csrf(cookieValue, wrongToken), lang: 'en' }),
      }));
      assert.equal(redeemed.status, 400); assert.match(await redeemed.text(), /data-confirmation-state="invalid"/u);
      // Remove only fixture reservations; the refused resend must create none.
      for (const table of tables) storage.db.exec(`DELETE FROM ${table}`);
      const r = await f.call(owner, `/api/sessions/${session.id}/identity/resend`, {});
      assert.equal(r.status, 200); assert.equal((await r.json()).identity.delivery, 'failed');
      await f.handlers.idle(); assert.deepEqual(f.counts(), [0, 0, 0, 0, 0]); assert.equal(f.messages.length, 0);
    });
  }
}
