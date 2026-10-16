import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQualificationMount, qualificationSettings } from '../ops/qualification-server.mjs';
import { createQualificationHost } from '../ops/qualification-host-template.mjs';
import { startChild, temporaryDb } from '../../../test/helpers.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('qualification flag is default-off and loopback bind/origin are mandatory', async () => {
  assert.deepEqual(qualificationSettings({}), { enabled: false });
  const base = { AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567' };
  for (const hostname of ['0.0.0.0', '::', 'localhost', 'example.com']) {
    assert.throws(() => qualificationSettings({ ...base, AITHEMA_LISTEN_HOST: hostname }), /bind must be loopback/);
  }
  for (const origin of [undefined, 'https://example.com', 'http://localhost:4567', 'http://127.0.0.1:4567/path', 'http://127.0.0.1:4567/', 'http://user@127.0.0.1:4567']) {
    assert.throws(() => qualificationSettings({ ...base, AITHEMA_COMPOSED_RELAY_ORIGIN: origin }), /loopback http/);
  }
  assert.equal(qualificationSettings({ ...base, AITHEMA_LISTEN_HOST: '::1', AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://[::1]:4567' }).hostname, '::1');
  const off = createQualificationMount();
  for (const path of ['/composed/relay', '/composed/qualification', '/composed/qualification/control', '/plugins/composed-voice/src/browser-audio.js']) {
    assert.equal((await off.handle(new Request(`http://127.0.0.1:4567${path}`, { method: 'POST' }))).status, 404);
  }
});

test('OPS template is inert, requires browser-facing hostOrigin and every accounting port', () => {
  assert.throws(() => createQualificationHost(), /loopback/);
  let calls = 0;
  const base = { hostOrigin: 'http://127.0.0.1:4567', runDirectory: '/unused', ownerHeaders: { cookie: 'fixture' },
    verifyCeiling() { calls++; }, verifyReceipt() { calls++; }, reconcile() { calls++; } };
  for (const port of ['verifyCeiling', 'verifyReceipt', 'reconcile']) assert.throws(() => createQualificationHost({ ...base, [port]: undefined }), new RegExp(port));
  const host = createQualificationHost(base); assert.equal(calls, 0); assert.equal(host.verifyCeiling, base.verifyCeiling);
});

test('demo refuses qualification startup with a non-loopback bind or relay origin', () => {
  for (const values of [{ AITHEMA_LISTEN_HOST: '0.0.0.0', AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567' },
    { AITHEMA_LISTEN_HOST: '127.0.0.1', AITHEMA_COMPOSED_RELAY_ORIGIN: 'https://fixture.invalid' }]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../demo/server.js', import.meta.url))], {
      env: { PATH: process.env.PATH, AITHEMA_COMPOSED_QUALIFICATION: '1', ...values }, timeout: 15_000,
    });
    assert.notEqual(child.status, 0); assert.match(child.stderr.toString(), /loopback/);
    assert.doesNotMatch(child.stderr.toString(), /OPS AITHEMA_COMPOSED_QUALIFICATION_MODULE required/);
  }
});

test('demo leaves qualification routes and browser assets unreachable without flag', async t => {
  const fixture = await startChild(new URL('../../../demo/server.js', import.meta.url), await temporaryDb());
  t.after(() => fixture.kill());
  for (const path of ['/composed/relay', '/composed/qualification', '/composed/qualification/control', '/plugins/composed-voice/src/browser-audio.js', '/plugins/composed-voice/src/network-client.js', '/plugins/composed-voice/src/pcm-capture-worklet.js']) {
    assert.equal((await fetch(fixture.url + path)).status, 404);
  }
  assert.equal((await fetch(fixture.url + '/composed/relay', { method: 'POST', body: new Uint8Array(1280) })).status, 404);
});

test('enabled mount enforces tunnel Host, owner authentication and cross-origin guards', async t => {
  let calls = 0;
  const mount = createQualificationMount({ enabled: true, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
    authenticateRelay: request => request.headers.get('cookie') === 'fixture' ? 'owner' : null,
    networkRelay: { handle: async () => { calls++; return new Response(null, { status: 204 }); } }, createSample() { assert.fail(); } });
  t.after(() => mount.close());
  const request = headers => new Request('http://localhost/composed/qualification', { headers: { host: '127.0.0.1:4567', ...headers } });
  assert.equal((await mount.handle(request({}))).status, 401);
  assert.equal((await mount.handle(request({ cookie: 'fixture', host: '127.0.0.1:9999' }))).status, 403);
  assert.equal((await mount.handle(request({ cookie: 'fixture', origin: 'https://example.com' }))).status, 403);
  assert.equal((await mount.handle(request({ cookie: 'fixture' }))).status, 200);
  assert.equal(calls, 0);
});
