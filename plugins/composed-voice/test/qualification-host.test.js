import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQualificationMount, qualificationSettings, loadQualificationKeys, loadQualificationControl } from '../ops/qualification-server.mjs';
import { createQualificationHost } from '../ops/qualification-host-template.mjs';
import { startChild, temporaryDb } from '../../../test/helpers.js';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { probeOutputDevice, defaultOutputFromProfiler, combineOutputEvidence } from '../ops/qualification-output-probe.mjs';
import { guardBrowserProcessGroup } from '../ops/qualification-browser-watchdog.mjs';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeQualificationBudget, openPersistedQualificationBudget } from '../src/persisted-budget.js';

const sentinel = 'SENTINEL_FAKE_QUALIFICATION_VALUE_NEVER_LOG';
async function keysFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'provider.keys');
  await writeFile(path, `# run-window fake only\n\nELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=${sentinel}=suffix\n`, { mode: 0o600 });
  return { directory, path, values: { AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_COMPOSED_KEYS_FILE: path } };
}

const fakeControl = { capability: 'a'.repeat(64), runId: 'fixture-run', budgetPath: '/unused/fixture.sqlite' };
async function controlFixture(t, runId = 'fixture-run') {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-control-')), budgetPath = join(directory, 'budget.sqlite');
  initializeQualificationBudget({ path: budgetPath });
  const budget = openPersistedQualificationBudget({ path: budgetPath,
    verifyCeiling: async spec => ({ ...spec, verified: true, reference: 'SENTINEL_FAKE_PRICE', expiresAt: Date.now() + 60_000 }),
    verifyReceipt: async () => false });
  budget.claimRun(runId);
  const control = { ...fakeControl, runId, budgetPath }, controlFile = join(directory, 'control.json');
  await writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  t.after(async () => { budget.close(); await rm(directory, { recursive: true, force: true }); });
  return { control, controlFile, budget };
}
const attemptSpec = attemptId => ({ attemptId, lane: 'candidate', role: 'stt', provider: 'fixture', model: 'fixture',
  operation: 'stream', accountRef: 'offline-fixture', endpoint: 'https://fixture.invalid', maxMicro: 100, request: { fixture: true } });

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
  const base = { hostOrigin: 'http://127.0.0.1:4567', runDirectory: '/unused', ownerHeaders: { cookie: 'fixture' }, controlCapability: fakeControl.capability,
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
  const mount = createQualificationMount({ enabled: true, control: fakeControl, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
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

test('flagged demo serves the authenticated hook and mounts binary relay before JSON guards', async t => {
  const keys = await keysFixture(t), { controlFile } = await controlFixture(t);
  const module = join(keys.directory, 'server.mjs');
  await writeFile(module, `
import { createQualificationServer as fixture } from ${JSON.stringify(new URL('../../../test/fixtures/composed-qualification-provider.mjs', import.meta.url).href)};
export function createQualificationServer(options) {
  if (options.keys?.ELEVENLABS_API_KEY !== ${JSON.stringify(sentinel)} || options.keys?.OPENROUTER_API_KEY !== ${JSON.stringify(`${sentinel}=suffix`)}) throw new Error('Server did not receive file-only keys');
  return fixture(options);
}`);
  const fixture = await startChild(new URL('../../../demo/server.js', import.meta.url), await temporaryDb(), {
    ...keys.values, AITHEMA_COMPOSED_CONTROL_FILE: controlFile, AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567',
    AITHEMA_COMPOSED_QUALIFICATION_MODULE: module, ELEVENLABS_API_KEY: 'ambient-poison', OPENROUTER_API_KEY: 'ambient-poison',
  });
  t.after(() => fixture.kill());
  const headers = { host: '127.0.0.1:4567', cookie: 'aithema-visitor=fixture-owner', origin: 'http://127.0.0.1:4567' };
  // Node fetch rewrites Host from its URL; node:http preserves the tunnel Host.
  const status = (path, method = 'GET', body) => new Promise((resolve, reject) => {
    const outgoing = request(fixture.url + path, { method, headers }, response => { response.resume(); resolve(response.statusCode); });
    outgoing.on('error', reject); outgoing.end(body);
  });
  for (const path of ['/composed/qualification', '/composed/qualification-page.js', '/plugins/composed-voice/src/browser-audio.js', '/plugins/composed-voice/src/network-client.js', '/plugins/composed-voice/src/pcm-capture-worklet.js']) {
    assert.equal(await status(path), 200, path);
  }
  assert.equal(await status('/composed/relay', 'POST', new Uint8Array(1280)), 403); // Relay refused the missing grant, rather than 415/404.
});

test('remote sample cannot dispatch until persisted consume acknowledgement; refusal blocks work', async t => {
  let dispatched = 0;
  const { control, budget } = await controlFixture(t, 'denied-run');
  const mount = createQualificationMount({ enabled: true, control, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
    authenticateRelay: () => 'owner', networkRelay: { handle() {} },
    async createSample({ admit }) {
      const { attempt } = await admit(attemptSpec('denied-attempt'));
      await attempt.consume(); dispatched++;
      assert.fail('Denied consume dispatched');
    },
  });
  t.after(() => mount.close());
  const post = async input => {
    const response = await mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
      headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': fakeControl.capability }, body: JSON.stringify(input) }));
    assert.equal(response.status, 200); return response.json();
  };
  const { sampleId } = await post({ action: 'start', lane: 'candidate', runId: 'denied-run', item: { id: 'one' } });
  const { event: admission } = await post({ action: 'poll', sampleId });
  assert.equal(admission.type, 'admit'); assert.equal(dispatched, 0);
  const admitted = await budget.admit({ ...attemptSpec('denied-attempt'), runId: control.runId });
  const { attemptId, claimId, maxMicro } = admitted.attempt;
  await post({ action: 'ack', sampleId, id: admission.id, value: { attemptId, claimId, maxMicro } });
  const { event: consume } = await post({ action: 'poll', sampleId });
  assert.equal(consume.type, 'consume'); assert.equal(dispatched, 0);
  await post({ action: 'ack', sampleId, id: consume.id, error: true });
  const { event: failure } = await post({ action: 'poll', sampleId });
  assert.equal(failure.type, 'failure'); assert.equal(dispatched, 0);
});

test('remote close acknowledgement and next sample wait for confirmed OPS shutdown', async t => {
  const { control } = await controlFixture(t, 'stop-proof');
  const stopped = Promise.withResolvers(), answer = Promise.withResolvers();
  let signal;
  const mount = createQualificationMount({ enabled: true, control, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
    authenticateRelay: () => 'owner', networkRelay: { handle() {} },
    async createSample(options) {
      signal = options.signal;
      return { grant: {}, result: answer.promise, async close() { await stopped.promise; answer.reject(new Error('Stopped')); } };
    },
  });
  t.after(() => mount.close());
  const post = input => mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
    headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': fakeControl.capability }, body: JSON.stringify(input) }));
  const input = { action: 'start', lane: 'candidate', runId: 'stop-proof', item: { id: 'one' } };
  const { sampleId } = await (await post(input)).json();
  let acknowledged = false;
  const closing = post({ action: 'close', sampleId }).then(response => { acknowledged = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true); assert.equal(acknowledged, false);
  assert.equal((await post(input)).status, 400);
  stopped.resolve(); assert.equal((await closing).status, 200);
});

test('control capability protects start, poll, acknowledgements and stop from another loopback visitor', async t => {
  const { control } = await controlFixture(t);
  let starts = 0;
  const result = Promise.withResolvers(); result.promise.catch(() => {});
  const mount = createQualificationMount({ enabled: true, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567', control,
    authenticateRelay: () => 'visitor', networkRelay: { handle() {} },
    createSample() { starts++; return { grant: {}, result: result.promise, close() { result.reject(new Error('Closed')); } }; } });
  t.after(() => mount.close());
  const post = (input, capability) => mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
    headers: { host: '127.0.0.1:4567', ...(capability === undefined ? {} : { 'x-aithema-qualification-control': capability }) }, body: JSON.stringify(input) }));
  const start = { action: 'start', lane: 'candidate', runId: control.runId, item: { id: 'one' } };
  for (const capability of [undefined, 'wrong', 'b'.repeat(64)]) assert.equal((await post(start, capability)).status, 403);
  assert.equal(starts, 0);
  const { sampleId } = await (await post(start, control.capability)).json();
  for (const action of ['start', 'ack', 'poll', 'close']) {
    assert.equal((await post({ ...start, action, sampleId, id: 'forged', value: { attemptId: 'forged' } })).status, 403);
  }
  assert.equal(starts, 1);
  assert.equal((await post({ action: 'close', sampleId }, control.capability)).status, 200);
});

test('only matching admissions and committed consumes from this run can dispatch; all dispatches are in the ledger', async t => {
  const { control, budget } = await controlFixture(t), dispatched = [];
  const spec = attemptSpec('ledger-bound-attempt'), answer = Promise.withResolvers(); answer.promise.catch(() => {});
  const mount = createQualificationMount({ enabled: true, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567', control,
    authenticateRelay: () => 'owner', networkRelay: { handle() {} }, async createSample({ admit }) {
      const admission = await admit(spec);
      await admission.dispatch(async ({ attempt, report }) => {
        const stored = budget.snapshot().records.find(row => row.attemptId === attempt.attemptId);
        assert.equal(stored.state, 'dispatched'); assert.equal(stored.runId, control.runId);
        dispatched.push(attempt.attemptId);
        await report({ attemptId: attempt.attemptId, outcome: 'completed' });
      });
      return { grant: {}, result: answer.promise, close() { answer.reject(new Error('Closed')); } };
    } });
  t.after(() => mount.close());
  const post = input => mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
    headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': control.capability }, body: JSON.stringify(input) }));
  assert.equal((await post({ action: 'start', lane: 'candidate', runId: 'other-run', item: {} })).status, 403);
  const { sampleId } = await (await post({ action: 'start', lane: 'candidate', runId: control.runId, item: {} })).json();
  const { event: admission } = await (await post({ action: 'poll', sampleId })).json();
  const ack = (event, value) => post({ action: 'ack', sampleId, id: event.id, value });
  const identity = { attemptId: spec.attemptId, claimId: `qualification-${spec.attemptId}`, maxMicro: 100 };
  assert.equal((await ack(admission, identity)).status, 403, 'Identity without durable reservation');
  budget.claimRun('other-run');
  const other = await budget.admit({ ...attemptSpec('other-attempt'), runId: 'other-run' });
  assert.equal((await ack(admission, { attemptId: other.attempt.attemptId, claimId: other.attempt.claimId, maxMicro: 100 })).status, 403);
  const admitted = await budget.admit({ ...spec, runId: control.runId });
  for (const forged of [{ ...identity, attemptId: 'unknown' }, { ...identity, claimId: 'forged' }, { ...identity, maxMicro: 0 }]) {
    assert.equal((await ack(admission, forged)).status, 403);
  }
  assert.equal((await ack({ id: 'unknown' }, identity)).status, 403);
  assert.equal(dispatched.length, 0);
  assert.equal((await ack(admission, identity)).status, 200);
  const { event: consume } = await (await post({ action: 'poll', sampleId })).json();
  assert.equal((await ack(consume)).status, 403, 'Client cannot pretend consume committed');
  assert.equal(dispatched.length, 0);
  await admitted.attempt.consume();
  assert.equal((await ack(consume)).status, 200);
  const { event: terminal } = await (await post({ action: 'poll', sampleId })).json();
  assert.equal((await ack(terminal)).status, 403, 'Client cannot pretend terminal committed');
  await admitted.report(terminal.terminal);
  assert.equal((await ack(terminal)).status, 200);
  const { event: ready } = await (await post({ action: 'poll', sampleId })).json();
  assert.equal(ready.type, 'ready');
  assert.deepEqual(dispatched, [spec.attemptId]);
  assert.ok(dispatched.every(id => budget.snapshot().records.some(row => row.attemptId === id && row.state === 'settled' && row.runId === control.runId)));
  assert.equal((await post({ action: 'close', sampleId })).status, 200);
});

test('control authority is flag-only, private-file-only, and never accepted as browser headers', async t => {
  const { controlFile, control } = await controlFixture(t);
  assert.equal(await loadQualificationControl({}), undefined);
  const values = { AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_COMPOSED_CONTROL_FILE: controlFile };
  assert.deepEqual(await loadQualificationControl(values), control);
  await chmod(controlFile, 0o644);
  await assert.rejects(loadQualificationControl(values), /0600/);
  await chmod(controlFile, 0o600);
  await symlink(controlFile, `${controlFile}.link`);
  await assert.rejects(loadQualificationControl({ ...values, AITHEMA_COMPOSED_CONTROL_FILE: `${controlFile}.link` }), /non-symlink/);
  await writeFile(controlFile, '{bad');
  await assert.rejects(loadQualificationControl(values), /valid per-run authority/);
  assert.throws(() => createQualificationHost({ ...hostOptions('/unused'), controlCapability: undefined }), /controlCapability/);
  assert.throws(() => createQualificationHost({ ...hostOptions('/unused'), ownerHeaders: { 'X-Aithema-Qualification-Control': control.capability } }), /browser ownerHeaders/);
});

test('a valid identity for another run, lane, request or pricing identity cannot acknowledge this admission', async t => {
  for (const change of [{ runId: 'other-run' }, { lane: 'baseline' }, { request: { different: true } }, { maxMicro: 99 }]) {
    await t.test(Object.keys(change)[0], async t => {
      const { control, budget } = await controlFixture(t), spec = attemptSpec('same-identity');
      budget.claimRun('other-run');
      const admission = await budget.admit({ ...spec, runId: control.runId, ...change });
      const mount = createQualificationMount({ enabled: true, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567', control,
        authenticateRelay: () => 'owner', networkRelay: { handle() {} }, async createSample({ admit }) {
          await admit(spec); assert.fail('Mismatched ledger entry admitted');
        } });
      t.after(() => mount.close());
      const post = input => mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
        headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': control.capability }, body: JSON.stringify(input) }));
      const { sampleId } = await (await post({ action: 'start', lane: 'candidate', runId: control.runId, item: {} })).json();
      const { event } = await (await post({ action: 'poll', sampleId })).json();
      const { attemptId, claimId, maxMicro } = admission.attempt;
      assert.equal((await post({ action: 'ack', sampleId, id: event.id, value: { attemptId, claimId, maxMicro } })).status, 403);
      assert.equal(budget.snapshot().records[0].state, 'reserved');
      assert.equal((await post({ action: 'close', sampleId })).status, 200);
    });
  }
});


test('keys are flag-only, file-only and parse comments/blanks without environment fallback', async t => {
  const fixture = await keysFixture(t);
  assert.equal(await loadQualificationKeys({ AITHEMA_COMPOSED_KEYS_FILE: '/does/not/exist' }), undefined);
  const keys = await loadQualificationKeys({ ...fixture.values, ELEVENLABS_API_KEY: 'ambient-poison', OPENROUTER_API_KEY: 'ambient-poison' });
  assert.equal(keys.ELEVENLABS_API_KEY, sentinel);
  assert.equal(keys.OPENROUTER_API_KEY, `${sentinel}=suffix`);
  assert.ok(Object.isFrozen(keys));
  await assert.rejects(loadQualificationKeys({ AITHEMA_COMPOSED_QUALIFICATION: '1', ELEVENLABS_API_KEY: sentinel, OPENROUTER_API_KEY: sentinel }), /Absolute AITHEMA_COMPOSED_KEYS_FILE required/);
});

test('keys file refuses 0644, symlink, other owner, non-file and relative paths without leaking values', async t => {
  const fixture = await keysFixture(t);
  const refused = async (values, options, pattern) => {
    await assert.rejects(loadQualificationKeys(values, options), error => {
      assert.match(error.message, pattern); assert.ok(!String(error.stack).includes(sentinel)); assert.equal(error.cause, undefined); return true;
    });
  };
  await chmod(fixture.path, 0o644);
  await refused(fixture.values, undefined, /mode exactly 0600/);
  await chmod(fixture.path, 0o600);
  const link = join(fixture.directory, 'link'); await symlink(fixture.path, link);
  await refused({ ...fixture.values, AITHEMA_COMPOSED_KEYS_FILE: link }, undefined, /non-symlink/);
  await refused(fixture.values, { uid: process.getuid() + 1 }, /owned by the running user/);
  await refused({ ...fixture.values, AITHEMA_COMPOSED_KEYS_FILE: fixture.directory }, undefined, /regular/);
  await refused({ ...fixture.values, AITHEMA_COMPOSED_KEYS_FILE: 'relative.keys' }, undefined, /Absolute/);
  await refused({ ...fixture.values, AITHEMA_COMPOSED_KEYS_FILE: join(fixture.directory, sentinel) }, undefined, /regular/);
});

test('missing/empty, duplicate and unknown keys refuse startup; stdout/stderr never include sentinel', async t => {
  const fixture = await keysFixture(t);
  const contents = [
    `ELEVENLABS_API_KEY=${sentinel}\n`,
    `ELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=\n`,
    `ELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=${sentinel}\nUNKNOWN=${sentinel}\n`,
    `ELEVENLABS_API_KEY=${sentinel}\nELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=${sentinel}\n`,
    `${sentinel}\n`,
  ];
  for (const content of contents) {
    await writeFile(fixture.path, content);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../demo/server.js', import.meta.url))], {
      env: { PATH: process.env.PATH, ...fixture.values, AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567',
        ELEVENLABS_API_KEY: sentinel, OPENROUTER_API_KEY: sentinel }, timeout: 15_000,
    });
    assert.notEqual(child.status, 0);
    const logs = child.stdout.toString() + child.stderr.toString();
    assert.match(logs, /Missing qualification key|Duplicate qualification key|Unknown key/);
    assert.ok(!logs.includes(sentinel));
    assert.doesNotMatch(logs, /QUALIFICATION_MODULE required/);
  }
  await writeFile(fixture.path, `ELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=${sentinel}\n`);
  await chmod(fixture.path, 0o644);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../demo/server.js', import.meta.url))], {
    env: { PATH: process.env.PATH, ...fixture.values, AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567' }, timeout: 15_000,
  });
  assert.notEqual(child.status, 0); assert.match(child.stderr.toString(), /mode exactly 0600/);
  assert.ok(!(child.stdout.toString() + child.stderr.toString()).includes(sentinel));
});

function inertBrowser(evidence) {
  return { defaultBrowserContext: () => ({ async overridePermissions() {} }), async close() {},
    async newPage() { return { async setExtraHTTPHeaders(headers) {
      assert.equal(Object.keys(headers).some(name => name.toLowerCase() === 'x-aithema-qualification-control'), false);
    }, async setRequestInterception() {}, on() {},
      async goto() { return { status: () => 200 }; }, async waitForFunction() {}, async evaluate() { return evidence; } }; } };
}
const hostOptions = directory => ({ hostOrigin: 'http://127.0.0.1:4567', runDirectory: directory,
  ownerHeaders: { cookie: 'fixture' }, controlCapability: fakeControl.capability, verifyCeiling() {}, verifyReceipt() {}, reconcile() {} });
const sampleOptions = wavPath => ({ item: { id: 'one', wavPath }, lane: 'candidate', runId: 'probe-refusal',
  admit() { assert.fail('No dispatch before probe'); }, onTiming() {} });

test('null-device refusal persists physicalBrowserMedia before control/admission and kills launcher group', async t => {
  const fixture = await keysFixture(t), evidence = { renderingVerified: false, labelledAudioOutputs: 0, outputLatency: 0 };
  let killed = 0;
  const host = createQualificationHost({ ...hostOptions(fixture.directory), launchBrowser: async (settings, lifetime) => {
    assert.ok(settings.userDataDir.startsWith(fixture.directory));
    assert.equal(settings.env.HOME, (await import('node:os')).homedir());
    assert.ok(lifetime.deadlineAt > Date.now());
    lifetime.registerProcessGroup({ watchdogArmed: true, kill() { killed++; } });
    return inertBrowser(evidence);
  } });
  t.after(() => host.close());
  let refused;
  await assert.rejects(host.runSample(sampleOptions(fixture.path)), error => {
    assert.match(error.message, /null or unverified audio output/);
    refused = error.physicalBrowserMedia;
    assert.equal(refused.verified, false);
    const { osDefaultOutput, verified, ...rendering } = refused;
    assert.equal(osDefaultOutput.source, 'system_profiler SPAudioDataType -json');
    assert.deepEqual(rendering, evidence); return true;
  });
  const run = createHash('sha256').update('probe-refusal').digest('hex').slice(0, 24);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.directory, run, 'candidate-physical-browser-media.json'))).physicalBrowserMedia, refused);
  assert.equal(killed, 1);
});

test('launcher must arm watchdog; wall-clock timeout and host close kill even a pending launch', async t => {
  const fixture = await keysFixture(t);
  const unguarded = createQualificationHost({ ...hostOptions(fixture.directory), launchBrowser: async () => inertBrowser({}) });
  await assert.rejects(unguarded.runSample(sampleOptions(fixture.path)), /without an armed/);
  for (const closeEarly of [false, true]) {
    let killed = 0;
    const started = Promise.withResolvers();
    const host = createQualificationHost({ ...hostOptions(fixture.directory), sampleTimeoutMs: closeEarly ? 10_000 : 100,
      launchBrowser(_options, lifetime) {
        lifetime.registerProcessGroup({ watchdogArmed: true, kill() { killed++; } }); started.resolve();
        return new Promise(() => {});
      } });
    const pending = host.runSample(sampleOptions(fixture.path));
    pending.catch(() => {}); await started.promise;
    if (closeEarly) await host.close();
    await assert.rejects(pending, closeEarly ? /host closed/ : /wall-clock timeout/);
    assert.ok(killed >= 1);
  }
});


test('rendering requires default sink, positive latency and both clocks advancing for 500ms; labels are diagnostic', async () => {
  for (const variation of ['real', 'fake', 'fakeAliases', 'mixed', 'unlabelled', 'zeroLatency', 'nanLatency', 'contextStalled', 'performanceStalled', 'short', 'nonDefault', 'silentSink', 'defaultAlias', 'noAPI']) {
    let reads = 0, now = 0, closed = false;
    class AudioContext {
      outputLatency = variation === 'zeroLatency' ? 0 : variation === 'nanLatency' ? NaN : 0.01;
      sinkId = variation === 'nonDefault' ? 'other-output' : variation === 'silentSink' ? { type: 'none' } : variation === 'defaultAlias' ? 'default' : '';
      createOscillator() { return { connect: () => ({ connect() {} }), start() {}, stop() {} }; }
      createGain() { return { gain: {} }; }
      async resume() {}
      async close() { closed = true; }
      getOutputTimestamp() {
        const after = reads++ > 0;
        return { contextTime: after && variation !== 'contextStalled' ? 0.55 : 0,
          performanceTime: after && variation !== 'performanceStalled' ? 550 : 0 };
      }
    }
    const evidence = await runInNewContext(`(${probeOutputDevice.toString()})()`, {
      navigator: { mediaDevices: { async enumerateDevices() { return variation === 'fake' ? ['Fake Default Audio Output', 'Fake Audio Output 1', 'Fake Audio Output 2'].map(label => ({ kind: 'audiooutput', label })) :
        variation === 'fakeAliases' ? [{ kind: 'audiooutput', label: 'Fake Audio Output 1', groupId: 'fake' },
          { kind: 'audiooutput', deviceId: 'default', groupId: 'fake', label: 'Default' },
          { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Fake Audio Output 1' }] :
        variation === 'mixed' ? [{ kind: 'audiooutput', label: 'Fake Audio Output 1' }, { kind: 'audiooutput', label: 'MacBook Speakers' }] :
        [{ kind: 'audiooutput', label: variation === 'unlabelled' ? '' : 'Output' }]; } } },
      AudioContext: variation === 'noAPI' ? undefined : AudioContext,
      performance: { now: () => now }, setTimeout(resolve) { now += variation === 'short' ? 499 : 550; resolve(); },
    });
    assert.equal(evidence.renderingVerified, ['real', 'fake', 'fakeAliases', 'mixed', 'unlabelled', 'defaultAlias'].includes(variation), variation);
    if (['fake', 'fakeAliases'].includes(variation)) {
      assert.equal(evidence.realAudioOutputs, 0); assert.equal(evidence.fakeAudioOutputs, 3);
      assert.equal(evidence.fakeAudioOutputLabels.length, 3);
    }
    if (variation === 'mixed') {
      assert.equal(evidence.realAudioOutputs, 1); assert.equal(evidence.fakeAudioOutputs, 1);
      assert.deepEqual(Array.from(evidence.realAudioOutputLabels), ['MacBook Speakers']);
    }
    if (variation !== 'noAPI') assert.equal(closed, true);
  }
});

test('OS evidence retains only the unique default output name, transport and built-in flag', () => {
  const output = { _name: 'MacBook Pro-Lautsprecher', coreaudio_default_audio_output_device: 'spaudio_yes',
    coreaudio_device_transport: 'coreaudio_device_type_builtin', privateInventoryField: 'must not survive' };
  const profile = { SPAudioDataType: [{ _items: [{ _name: 'Microphone', coreaudio_default_audio_input_device: 'spaudio_yes' }, output] }] };
  assert.deepEqual(defaultOutputFromProfiler(profile), { name: 'MacBook Pro-Lautsprecher', transport: 'coreaudio_device_type_builtin', builtIn: true });
  const external = { ...output, _name: 'USB output', coreaudio_device_transport: 'coreaudio_device_type_usb' };
  assert.equal(defaultOutputFromProfiler({ SPAudioDataType: [{ _items: [external] }] }).builtIn, false);
  for (const items of [[], [{ _name: 'Not default' }], [output, external]]) {
    assert.throws(() => defaultOutputFromProfiler({ SPAudioDataType: [{ _items: items }] }), /exactly one default/);
  }
  for (const invalid of [{ ...output, _name: '' }, { ...output, coreaudio_device_transport: undefined }]) {
    assert.throws(() => defaultOutputFromProfiler({ SPAudioDataType: [invalid] }), /name and transport required/);
  }
});

test('physical output requires both rendering proof and the OS default output even with fake enumeration', () => {
  for (const renderingVerified of [false, true]) for (const verified of [false, true]) {
    const rendering = { renderingVerified, realAudioOutputs: 0, fakeAudioOutputs: 3, sinkId: '' };
    const osDefaultOutput = { verified, name: 'MacBook Pro-Lautsprecher', transport: 'coreaudio_device_type_builtin', builtIn: true };
    const evidence = combineOutputEvidence(rendering, osDefaultOutput);
    assert.equal(evidence.verified, renderingVerified && verified);
    assert.equal(evidence.fakeAudioOutputs, 3);
    assert.deepEqual(evidence.osDefaultOutput, osDefaultOutput);
  }
});

test('independent watchdog kills the browser process group at deadline even without template callbacks', { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const ended = once(child, 'exit');
  guardBrowserProcessGroup(child.pid, { deadlineAt: Date.now() + 500 });
  const [code, signal] = await ended;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
});

test('independent watchdog kills browser group after runner SIGKILL (also supports cross-user controller PID)', { timeout: 10_000 }, async t => {
  const controller = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { controller.kill('SIGKILL'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const ended = once(child, 'exit');
  guardBrowserProcessGroup(child.pid, { deadlineAt: Date.now() + 8000, controllerPid: controller.pid });
  controller.kill('SIGKILL');
  const [code, signal] = await ended;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
});
