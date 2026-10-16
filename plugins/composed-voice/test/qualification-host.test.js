import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQualificationMount, qualificationSettings, loadQualificationKeys, loadQualificationControl, loopbackOrigin } from '../ops/qualification-server.mjs';
import { createQualificationHost } from '../ops/qualification-host-template.mjs';
import { startChild, temporaryDb } from '../../../test/helpers.js';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { probeOutputDevice, defaultOutputFromProfiler, combineOutputEvidence, readBrowserEvidence, findRefusedOutputFlags } from '../ops/qualification-output-probe.mjs';
import { guardBrowserProcessGroup } from '../ops/qualification-browser-watchdog.mjs';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeQualificationBudget, openPersistedQualificationBudget } from '../src/persisted-budget.js';
import { readQualificationCorpus } from '../src/qualification-corpus.js';
import { IncompleteMediaEvidence } from '../src/live-qualification.js';
import { QualificationSampleFailure, QUALIFICATION_SAMPLE_FAILURES } from '../src/qualification-failure.js';
import { assertFailureDiagnostic } from './qualification-failure-fixture.js';

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
  for (const path of ['/composed/qualification', '/composed/qualification-page.js', '/composed/qualification-output-timing.js', '/plugins/composed-voice/src/browser-audio.js', '/plugins/composed-voice/src/network-client.js', '/plugins/composed-voice/src/pcm-capture-worklet.js']) {
    assert.equal(await status(path), 200, path);
  }
  assert.equal(await status('/composed/relay', 'POST', new Uint8Array(1280)), 403); // Relay refused the missing grant, rather than 415/404.
});

test('visitor erasure awaits qualification revocation for every owned session', async t => {
  const keys = await keysFixture(t), { controlFile } = await controlFixture(t);
  const module = join(keys.directory, 'revoke.mjs'), record = join(keys.directory, 'revoked.json');
  await writeFile(module, `
import { appendFile } from 'node:fs/promises';
export function createQualificationServer({ storage }) {
  return { networkRelay: { handle() {} }, createSample() {}, async revokeSession(id) {
    if (storage.get(id).tombstone) throw new Error('Revoke must precede erase');
    await appendFile(${JSON.stringify(record)}, id + '\\n');
  } };
}`);
  const fixture = await startChild(new URL('../../../demo/server.js', import.meta.url), await temporaryDb(), {
    ...keys.values, AITHEMA_COMPOSED_CONTROL_FILE: controlFile, AITHEMA_COMPOSED_RELAY_ORIGIN: 'http://127.0.0.1:4567',
    AITHEMA_COMPOSED_QUALIFICATION_MODULE: module,
  });
  t.after(() => fixture.kill());
  const headers = { 'content-type': 'application/json' };
  const first = await fetch(fixture.url + '/api/sessions', { method: 'POST', headers, body: '{}' });
  const one = await first.json(); headers.cookie = first.headers.get('set-cookie').split(';')[0];
  const two = await (await fetch(fixture.url + '/api/sessions', { method: 'POST', headers, body: '{}' })).json();
  const erased = await fetch(fixture.url + '/api/visitor/erase', { method: 'POST', headers, body: '{}' });
  assert.equal(erased.status, 200);
  assert.deepEqual(new Set((await readFile(record, 'utf8')).trim().split('\n')), new Set([one.id, two.id]));
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

function inertBrowser(evidence, { args = [process.execPath, '--enable-automation'], commandLineUnavailable = false,
  processInfo = [{ type: 'browser', id: process.pid }] } = {}) {
  return { process: () => null, target: () => ({ async createCDPSession() { return {
    async send(method) {
      if (method === 'Browser.getBrowserCommandLine') {
        if (commandLineUnavailable) throw new Error('Command line unavailable');
        return { arguments: args };
      }
      assert.equal(method, 'SystemInfo.getProcessInfo');
      return { processInfo };
    }, async detach() {},
  }; } }), defaultBrowserContext: () => ({ async overridePermissions() {} }), async close() {},
    async newPage() { return { async evaluateOnNewDocument() {}, async setExtraHTTPHeaders(headers) {
      assert.equal(Object.keys(headers).some(name => name.toLowerCase() === 'x-aithema-qualification-control'), false);
    }, async setRequestInterception() {}, on() {},
      async goto() { return { status: () => 200 }; }, async waitForFunction() {}, async evaluate() { return evidence; } }; } };
}
const hostOptions = directory => ({ hostOrigin: 'http://127.0.0.1:4567', runDirectory: directory,
  ownerHeaders: { cookie: 'fixture' }, controlCapability: fakeControl.capability, verifyCeiling() {}, verifyReceipt() {}, reconcile() {} });
const sampleOptions = wavPath => ({ item: { id: 'one', utterancePath: wavPath, bargeInPath: wavPath }, lane: 'candidate', runId: 'probe-refusal',
  admit() { assert.fail('No dispatch before probe'); }, onTiming() {} });

async function sampleFixture(path) {
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40); await writeFile(path, wav);
  return sampleOptions(path);
}

// Execute the real host with inert browser/control ports and a verified output
// probe. No Chrome, OS audio probe, provider or network is used in these tests.
async function settlementFixture(t, { reason, refusal, countWriteFailure = false, closeFailure = false, pendingMedia = false, lateEvents = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-settlement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await sampleFixture(join(directory, 'input.wav'));
  const fenced = Promise.withResolvers(), delivered = Promise.withResolvers();
  const warnings = [], acknowledgements = [], timings = [];
  t.mock.method(process, 'emitWarning', (...args) => warnings.push(args));
  let terminal, polls = 0, countPath;
  const browser = inertBrowser({});
  const page = await browser.newPage();
  page.exposeFunction = async (_name, fn) => { terminal = fn; };
  page.evaluate = async () => {
    if (countWriteFailure) await mkdir(countPath);
    await terminal(refusal ? { refusal } : {}); fenced.resolve();
    if (pendingMedia) return new Promise(() => {});
    return { trace: lateEvents ? [{ kind: 'post-measurement' }, { kind: 'post-measurement' }] : [], ...(refusal ? { refusal } : {}) };
  };
  browser.newPage = async () => page;
  const ports = { createHash, mkdir, mkdtemp, writeFile, homedir, isAbsolute, join, loopbackOrigin,
    findRefusedOutputFlags, readQualificationCorpus, IncompleteMediaEvidence, QualificationSampleFailure, QUALIFICATION_SAMPLE_FAILURES,
    probePhysicalOutput: async () => ({ verified: true }),
    async fetch(_url, options) {
      const request = JSON.parse(options.body), json = value => Response.json(value);
      if (request.action === 'start') return json({ sampleId: 'offline-sample' });
      if (request.action === 'close' && closeFailure) return new Response(null, { status: 400 });
      if (request.action === 'measurement-terminal' || request.action === 'close') return json({});
      if (request.action === 'ack') { acknowledgements.push(request); return json({}); }
      assert.equal(request.action, 'poll');
      if (polls++ === 0) return json({ event: { type: 'ready', grant: {} } });
      await fenced.promise;
      if (lateEvents && polls === 2) return json({ event: { type: 'post-measurement' } });
      if (lateEvents && polls === 3) return json({ event: { type: 'admit', id: 'late-admit', spec: attemptSpec('after-fence') } });
      if (polls === (lateEvents ? 4 : 2)) {
        delivered.resolve();
        return json({ event: reason ? { type: 'failure', reason, error: sentinel } :
          { type: 'result', result: { hypothesis: 'Wien', entities: [], ttsPCM: 'AAE=', ttsFormat: {}, ttsConfig: {} } } });
      }
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        if (options.signal.aborted) reject(options.signal.reason);
      });
    } };
  const source = (await readFile(new URL('../ops/qualification-host-template.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gmu, '').replace('export function createQualificationHost', 'function createQualificationHost');
  const factory = new Function(...Object.keys(ports), `${source}\nreturn createQualificationHost;`)(...Object.values(ports));
  const host = factory({ ...hostOptions(directory), launchBrowser(_settings, lifetime) {
    assert.equal(lifetime.timeoutMs, 20 * 60_000);
    lifetime.registerProcessGroup({ watchdogArmed: true, kill() {} });
    return browser;
  } });
  t.after(() => host.close());
  const runSample = async (options = input) => {
    const run = createHash('sha256').update(options.runId).digest('hex').slice(0, 24);
    const sample = createHash('sha256').update(`${options.runId}:${options.item.sampleId ?? options.item.id}`).digest('hex').slice(0, 24);
    countPath = join(directory, run, `candidate-post-measurement-${sample}.json`);
    return host.runSample({ ...options, onTiming(event) { timings.push(event); options.onTiming(event); } });
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return { runSample, delivered: delivered.promise, warnings, acknowledgements, timings, countPath: () => countPath };
}

for (const [reason, message] of Object.entries(QUALIFICATION_SAMPLE_FAILURES)) {
  test(`measured server settlement ${reason} aborts promptly with its cause in failure.json`, { timeout: 5000 }, async t => {
    const h = await settlementFixture(t, { reason, pendingMedia: true });
    await assertFailureDiagnostic(t, h.runSample, 'candidate', false, message);
    assert.deepEqual(h.timings, [], 'a server failure is not a post-measurement event');
  });
}

for (const refusal of ['late-first-audio', 'barge-in-before-first-audio', 'missing-playback-stop']) {
  for (const reason of Object.keys(QUALIFICATION_SAMPLE_FAILURES)) {
    test(`${refusal} followed by ${reason} preserves only the expected missing-audio consequence`, { timeout: 5000 }, async t => {
      const h = await settlementFixture(t, { reason, refusal });
      const expected = reason === 'missing-audio' && refusal !== 'missing-playback-stop';
      await assert.rejects(h.runSample(), error => {
        assert.equal(error instanceof IncompleteMediaEvidence, expected);
        assert.equal(error.reason, expected ? refusal : reason); return true;
      });
      assert.deepEqual(h.timings, []);
    });
  }
}

test('late lane events and sample-complete admission stay counted after measurement', { timeout: 5000 }, async t => {
  const h = await settlementFixture(t, { lateEvents: true });
  assert.equal((await h.runSample()).hypothesis, 'Wien');
  assert.equal(h.timings.length, 4);
  assert.ok(h.timings.every(event => event.kind === 'post-measurement'));
  assert.deepEqual(h.acknowledgements.map(row => row.refused), ['sample-complete']);
  assert.deepEqual(JSON.parse(await readFile(h.countPath())), { counts: { 'post-measurement': 4 } });
});

for (const outcome of ['result', 'failure', 'refusal']) {
  test(`count write failure preserves the original ${outcome} and records no values`, { timeout: 5000 }, async t => {
    const h = await settlementFixture(t, { countWriteFailure: true,
      ...(outcome === 'failure' ? { reason: 'stop-failed' } : outcome === 'refusal' ? { reason: 'missing-audio', refusal: 'late-first-audio' } : {}) });
    if (outcome === 'result') assert.equal((await h.runSample()).hypothesis, 'Wien');
    else await assert.rejects(h.runSample(), error => {
      assert.equal(error.reason, outcome === 'failure' ? 'stop-failed' : 'late-first-audio'); return true;
    });
    assert.deepEqual(h.warnings, [['Qualification post-measurement count write failed', { code: 'QUALIFICATION_COUNT_WRITE_FAILED' }]]);
    assert.ok(!JSON.stringify(h.warnings).includes(sentinel));
  });
}

test('a rejected close acknowledgement preserves an observed server failure', { timeout: 5000 }, async t => {
  const h = await settlementFixture(t, { reason: 'stop-failed', closeFailure: true });
  await assert.rejects(h.runSample(), { reason: 'stop-failed' });
});

test('an expected refusal consequence cannot hide a subsequent close failure', { timeout: 5000 }, async t => {
  const h = await settlementFixture(t, { reason: 'missing-audio', refusal: 'late-first-audio', closeFailure: true });
  await assert.rejects(h.runSample(), { reason: 'stop-failed' });
});

test('an unknown server failure uses the fixed generic reason without trusting its payload', { timeout: 5000 }, async t => {
  const h = await settlementFixture(t, { reason: sentinel, refusal: 'late-first-audio' });
  await assert.rejects(h.runSample(), { reason: 'sample-failed', message: QUALIFICATION_SAMPLE_FAILURES['sample-failed'] });
});

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
  await assert.rejects(host.runSample(await sampleFixture(fixture.path)), error => {
    assert.match(error.message, /null or unverified audio output/);
    refused = error.physicalBrowserMedia;
    assert.equal(refused.verified, false);
    const { osDefaultOutput, commandLine, browserUser, refusedOutputFlags, verified, ...rendering } = refused;
    assert.equal(osDefaultOutput.source, 'system_profiler SPAudioDataType -json');
    assert.equal(commandLine.verified, true);
    assert.equal(browserUser.verified, true);
    assert.equal(browserUser.uid, process.getuid());
    assert.deepEqual(refusedOutputFlags, []);
    assert.deepEqual(rendering, evidence); return true;
  });
  const run = createHash('sha256').update('probe-refusal').digest('hex').slice(0, 24);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.directory, run, 'candidate-physical-browser-media.json'))).physicalBrowserMedia, refused);
  assert.equal(killed, 1);
});

test('launcher must arm watchdog; wall-clock timeout and host close kill even a pending launch', async t => {
  const fixture = await keysFixture(t);
  const unguarded = createQualificationHost({ ...hostOptions(fixture.directory), launchBrowser: async () => inertBrowser({}) });
  await assert.rejects(unguarded.runSample(await sampleFixture(fixture.path)), /without an armed/);
  for (const closeEarly of [false, true]) {
    let killed = 0;
    const started = Promise.withResolvers();
    const host = createQualificationHost({ ...hostOptions(fixture.directory), sampleTimeoutMs: closeEarly ? 10_000 : 100,
      launchBrowser(_options, lifetime) {
        lifetime.registerProcessGroup({ watchdogArmed: true, kill() { killed++; } }); started.resolve();
        return new Promise(() => {});
      } });
    const pending = host.runSample(await sampleFixture(fixture.path));
    pending.catch(() => {}); await started.promise;
    if (closeEarly) await host.close();
    await assert.rejects(pending, closeEarly ? /host closed/ : /wall-clock timeout/);
    assert.ok(killed >= 1);
  }
});

test('connected launcher output overrides refuse before control/admission despite advancing rendering', async t => {
  const fixture = await keysFixture(t);
  for (const flag of ['--disable-audio-output', '-disable-audio-output']) await t.test(flag, async t => {
    let killed = 0;
    const host = createQualificationHost({ ...hostOptions(fixture.directory), launchBrowser: async (_settings, lifetime) => {
      lifetime.registerProcessGroup({ watchdogArmed: true, kill() { killed++; } });
      return inertBrowser({ renderingVerified: true, outputLatency: 0.016 }, { args: ['/fixture/chrome', flag] });
    } });
    t.after(() => host.close());
    await assert.rejects(host.runSample(await sampleFixture(fixture.path)), error => {
      assert.match(error.message, /null or unverified audio output/);
      assert.equal(error.physicalBrowserMedia.renderingVerified, true);
      assert.deepEqual(error.physicalBrowserMedia.refusedOutputFlags, [flag]);
      assert.equal(error.physicalBrowserMedia.verified, false); return true;
    });
    assert.equal(killed, 1);
  });
});

test('unavailable actual command line refuses even with clean requested and local spawn arguments', async t => {
  const fixture = await keysFixture(t);
  const host = createQualificationHost({ ...hostOptions(fixture.directory), launchBrowser: async (_settings, lifetime) => {
    lifetime.registerProcessGroup({ watchdogArmed: true, kill() {} });
    return { ...inertBrowser({ renderingVerified: true }, { commandLineUnavailable: true }),
      process: () => ({ pid: process.pid, spawnargs: ['/fixture/chrome', '--enable-automation'] }) };
  } });
  t.after(() => host.close());
  await assert.rejects(host.runSample(await sampleFixture(fixture.path)), error => {
    assert.equal(error.physicalBrowserMedia.commandLine.verified, false);
    assert.equal(error.physicalBrowserMedia.verified, false); return true;
  });
});

test('actual Chrome evidence binds local/connected CDP PID and executable before the probe UID', async () => {
  for (const local of [false, true]) {
    const browser = inertBrowser({});
    if (local) browser.process = () => ({ pid: process.pid, spawnargs: ['ignored', '--mute-audio'] });
    const evidence = await readBrowserEvidence(browser);
    assert.equal(evidence.commandLine.verified, true);
    assert.deepEqual(evidence.commandLine.arguments, [process.execPath, '--enable-automation']);
    assert.equal(evidence.browserUser.verified, true);
    assert.equal(evidence.browserUser.uid, process.getuid());
    assert.equal(evidence.browserUser.pidSource, 'CDP SystemInfo.getProcessInfo');
    assert.equal(evidence.browserUser.pid, process.pid);
    assert.equal(evidence.browserUser.executable, process.execPath);
    if (local) assert.equal(evidence.browserUser.localPid, process.pid);
    assert.equal(combineOutputEvidence({ renderingVerified: true }, { verified: true, uid: process.getuid() }, evidence).verified, true);
  }
});

test('Chrome process binding refuses mismatched local PID, absent local process and different executable', async t => {
  for (const [name, browser] of [
    ['mismatched local PID', { ...inertBrowser({}), process: () => ({ pid: process.pid + 1 }) }],
    ['no local process for CDP PID', inertBrowser({}, { processInfo: [{ type: 'browser', id: 2_147_483_647 }] })],
    ['local executable differs from CDP', inertBrowser({}, { args: ['/other/chrome', '--enable-automation'] })],
    ['missing local launcher PID', { ...inertBrowser({}), process: () => ({}) }],
    ['CDP PID unavailable despite local launcher', { ...inertBrowser({}, { processInfo: [] }), process: () => ({ pid: process.pid }) }],
  ]) await t.test(name, async () => {
    let uidReads = 0;
    const evidence = await readBrowserEvidence(browser, async () => { uidReads++; return process.getuid(); });
    assert.equal(evidence.commandLine.verified, true);
    assert.equal(evidence.browserUser.verified, false);
    assert.equal(uidReads, 0, 'Refuse process binding before checking UID');
    assert.equal(combineOutputEvidence({ renderingVerified: true }, { verified: true, uid: process.getuid() }, evidence).verified, false);
  });
});

test('Chrome UID mismatch, unknown UID/PID and unavailable or malformed command line all fail closed', async () => {
  for (const uid of [undefined, NaN, -1, process.getuid() + 1]) {
    const evidence = await readBrowserEvidence(inertBrowser({}), async () => uid);
    assert.equal(evidence.browserUser.verified, false);
    assert.equal(combineOutputEvidence({ renderingVerified: true }, { verified: true, uid: process.getuid() }, evidence).verified, false);
  }
  for (const processInfo of [undefined, null, [], [{ type: 'browser', id: 0 }], [{ type: 'browser', id: 1 }, { type: 'browser', id: 2 }]]) {
    const browser = inertBrowser({});
    browser.target = () => ({ async createCDPSession() { return {
      async send(method) { return method === 'Browser.getBrowserCommandLine' ? { arguments: ['/fixture/chrome'] } : { processInfo }; }, async detach() {},
    }; } });
    assert.equal((await readBrowserEvidence(browser)).browserUser.verified, false);
  }
  for (const args of [undefined, [], [42], ['']]) {
    const browser = inertBrowser({}, { args });
    // Override the default argument for the undefined response as well.
    browser.target = () => ({ async createCDPSession() { return {
      async send() { return { arguments: args, processInfo: [{ type: 'browser', id: process.pid }] }; }, async detach() {},
    }; } });
    assert.equal((await readBrowserEvidence(browser)).commandLine.verified, false);
    assert.equal((await readBrowserEvidence(browser)).browserUser.verified, false);
  }
  assert.equal((await readBrowserEvidence(inertBrowser({}, { commandLineUnavailable: true }))).commandLine.verified, false);
  assert.equal(combineOutputEvidence({ renderingVerified: true }, { verified: true }).verified, false);
});

test('output override policy handles both switch forms, service wrappers and audio feature overrides', () => {
  const flags = ['mute-audio', 'disable-audio-output', 'fail-audio-stream-creation', 'alsa-output-device=null',
    'use-cras', 'force-wave-audio', 'audio-service-use-fake-device', 'utility-cmd-prefix=wrapper',
    'browser-subprocess-path=/other/chrome', 'service-sandbox-type=none', 'utility-sub-type=audio.mojom.AudioService',
    'type=utility', 'disable-features=Other,AudioServiceOutOfProcess', 'enable-features=AudioServiceSandbox'];
  for (const prefix of ['--', '-']) for (const flag of flags) {
    assert.deepEqual(findRefusedOutputFlags([prefix + flag]), [prefix + flag.split('=')[0]]);
  }
  assert.deepEqual(findRefusedOutputFlags(['/fixture/chrome', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=/corpus.wav', '--disable-features=AudioServiceSandbox,Other', '--no-sandbox']), []);
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
  const browser = { commandLine: { verified: true, arguments: ['/fixture/chrome'] }, browserUser: { verified: true, uid: 501, probeUid: 501 } };
  for (const renderingVerified of [false, true]) for (const verified of [false, true]) {
    const rendering = { renderingVerified, realAudioOutputs: 0, fakeAudioOutputs: 3, sinkId: '' };
    const osDefaultOutput = { verified, uid: 501, name: 'MacBook Pro-Lautsprecher', transport: 'coreaudio_device_type_builtin', builtIn: true };
    const evidence = combineOutputEvidence(rendering, osDefaultOutput, browser);
    assert.equal(evidence.verified, renderingVerified && verified);
    assert.equal(evidence.fakeAudioOutputs, 3);
    assert.deepEqual(evidence.osDefaultOutput, osDefaultOutput);
  }
  for (const flag of ['--disable-audio-output', '--mute-audio', '--fail-audio-stream-creation', '--alsa-output-device=null']) {
    const evidence = combineOutputEvidence({ renderingVerified: true }, { verified: true, uid: 501 },
      { ...browser, commandLine: { verified: true, arguments: ['/fixture/chrome', flag] } });
    assert.equal(evidence.verified, false);
    assert.deepEqual(evidence.refusedOutputFlags, [flag.split('=')[0]]);
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

test('independent watchdog kills browser group after runner SIGKILL', { timeout: 10_000 }, async t => {
  const controller = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { controller.kill('SIGKILL'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const ended = once(child, 'exit');
  guardBrowserProcessGroup(child.pid, { deadlineAt: Date.now() + 8000, controllerPid: controller.pid });
  controller.kill('SIGKILL');
  const [code, signal] = await ended;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
});

test('paid conversation watchdog acknowledges a shorter deadline and kills without CDP cooperation', { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const ended = once(child, 'exit'), deadlineAt = Date.now() + 8000;
  const guard = guardBrowserProcessGroup(child.pid, { deadlineAt });
  // Synthetic deadlines exercise the existing watchdog contract, not a quality
  // threshold: a paid binding must shorten the launch/sample wall-clock bound.
  await assert.rejects(guard.limitDeadline(deadlineAt + 1), /Invalid browser duration bound/);
  await guard.limitDeadline(Date.now() + 500);
  assert.deepEqual(await ended, [null, 'SIGKILL']);
});

for (const action of ['measurement-terminal', 'close']) test(`server ${action} fences late admission without a reservation or dispatch`, async t => {
  const { control, budget } = await controlFixture(t);
  let admit;
  const answer = Promise.withResolvers(); answer.promise.catch(() => {});
  const mount = createQualificationMount({ enabled: true, control, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
    authenticateRelay: () => 'owner', networkRelay: { handle() {} },
    async createSample(ports) { admit = ports.admit; return { grant: {}, result: answer.promise, async close() {} }; } });
  t.after(() => mount.close());
  const post = async input => {
    const response = await mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
      headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': control.capability }, body: JSON.stringify(input) }));
    assert.equal(response.status, 200); return response.json();
  };
  const { sampleId } = await post({ action: 'start', lane: 'candidate', runId: control.runId, item: { id: 'one' } });
  await post({ action: 'poll', sampleId });
  await post({ action, sampleId });
  assert.deepEqual(await admit(attemptSpec('late-attempt')), { refused: 'sample-complete' });
  assert.equal(budget.snapshot().records.length, 0);
});

for (const reason of [...Object.keys(QUALIFICATION_SAMPLE_FAILURES), 'untyped', 'invalid-pcm']) {
  test(`server publishes only a fixed settlement for ${reason} after measurement`, async t => {
    const { control } = await controlFixture(t);
    const answer = Promise.withResolvers(); answer.promise.catch(() => {});
    const mount = createQualificationMount({ enabled: true, control, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
      authenticateRelay: () => 'owner', networkRelay: { handle() {} },
      async createSample() { return { grant: {}, result: answer.promise, async close() {} }; } });
    t.after(() => mount.close());
    const post = async input => {
      const response = await mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
        headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': control.capability }, body: JSON.stringify(input) }));
      assert.equal(response.status, 200); return response.json();
    };
    const { sampleId } = await post({ action: 'start', lane: 'candidate', runId: control.runId, item: { id: 'one' } });
    assert.equal((await post({ action: 'poll', sampleId })).event.type, 'ready');
    await post({ action: 'measurement-terminal', sampleId });
    if (reason === 'invalid-pcm') answer.resolve({ ttsPCM: null });
    else answer.reject(reason === 'untyped' ? Object.assign(new Error(sentinel), { reason: 'missing-audio' }) : new QualificationSampleFailure(reason));
    const expected = reason === 'untyped' ? 'sample-failed' : reason === 'invalid-pcm' ? 'pcm-bound' : reason;
    assert.deepEqual((await post({ action: 'poll', sampleId })).event,
      { type: 'failure', reason: expected, error: QUALIFICATION_SAMPLE_FAILURES[expected] });
  });
}

for (const dispatched of [false, true]) test(`measurement fence preserves an already ${dispatched ? 'dispatched' : 'reserved'} attempt`, async t => {
  const { control, budget } = await controlFixture(t);
  let admit;
  const mount = createQualificationMount({ enabled: true, control, hostname: '127.0.0.1', relayOrigin: 'http://127.0.0.1:4567',
    authenticateRelay: () => 'owner', networkRelay: { handle() {} }, async createSample(ports) {
      admit = ports.admit; return { grant: {}, result: new Promise(() => {}), async close() {} };
    } });
  t.after(() => mount.close());
  const post = async input => {
    const response = await mount.handle(new Request('http://localhost/composed/qualification/control', { method: 'POST',
      headers: { host: '127.0.0.1:4567', 'x-aithema-qualification-control': control.capability }, body: JSON.stringify(input) }));
    assert.equal(response.status, 200); return response.json();
  };
  const { sampleId } = await post({ action: 'start', lane: 'candidate', runId: control.runId, item: { id: 'one' } });
  await post({ action: 'poll', sampleId });
  const spec = attemptSpec('racing-attempt'), pending = admit(spec);
  const { event } = await post({ action: 'poll', sampleId });
  const reserved = await budget.admit({ ...spec, runId: control.runId });
  const { attemptId, claimId, maxMicro } = reserved.attempt;
  if (!dispatched) await post({ action: 'measurement-terminal', sampleId });
  await post({ action: 'ack', sampleId, id: event.id, value: { attemptId, claimId, maxMicro } });
  const granted = await pending;
  if (dispatched) {
    const consuming = granted.attempt.consume();
    const { event } = await post({ action: 'poll', sampleId });
    await reserved.attempt.consume(); await post({ action: 'ack', sampleId, id: event.id }); await consuming;
    await post({ action: 'measurement-terminal', sampleId });
    const reporting = granted.report({ attemptId, outcome: 'uncertain' });
    const { event: report } = await post({ action: 'poll', sampleId });
    await reserved.report({ attemptId, outcome: 'uncertain' });
    await post({ action: 'ack', sampleId, id: report.id }); await reporting;
  } else assert.deepEqual(granted, { refused: 'sample-complete' });
  assert.deepEqual(await admit(attemptSpec('late-attempt')), { refused: 'sample-complete' });
  const { event: late } = await post({ action: 'poll', sampleId });
  assert.equal(late.type, 'post-measurement');
  await post({ action: 'close', sampleId });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.exposureMicro, 100);
  assert.equal(snapshot.records[0].state, dispatched ? 'settled' : 'reserved');
  if (dispatched) assert.equal(snapshot.records[0].outcome, 'uncertain');
});
