import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaselineAuth, installBaselineAuth } from '../ops/qualification-production-baseline.mjs';

const secret = 'FAKE_BASIC_AUTH_VALUE_NEVER_IN_EVIDENCE';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baseline-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ username: 'fake-operator', password: secret }), { mode: 0o600 });
  return { path, dir };
}

test('baseline auth refuses missing, relative, wrong mode, wrong owner and symlink without disclosing input', async t => {
  const { path, dir } = await fixture(t);
  const refuses = async (input, options) => assert.rejects(loadBaselineAuth(input, options), error => {
    assert.doesNotMatch(String(error), new RegExp(`${secret}|${dir}|fake-operator`));
    return /baseline.*auth/i.test(error.message);
  });
  await refuses(undefined); await refuses('relative.json');
  await refuses(path, { uid: process.getuid() + 1 });
  await chmod(path, 0o640); await refuses(path); await chmod(path, 0o600);
  const link = join(dir, 'link'); await symlink(path, link); await refuses(link);
  assert.deepEqual(await loadBaselineAuth(path), { username: 'fake-operator', password: secret });
});

test('CDP sends basic auth only for a server challenge from baselineOrigin; other origins get no credential', async () => {
  const handlers = {}, sent = [];
  const cdp = { on(event, handler) { handlers[event] = handler; }, async send(method, params) { sent.push({ method, params }); } };
  await installBaselineAuth(cdp, 'https://start2.example', { username: 'fake-operator', password: secret });
  for (const [origin, source, scheme] of [['https://other.example', 'Server', 'basic'], ['https://start2.example', 'Proxy', 'basic'],
    ['https://start2.example', 'Server', 'digest'], ['https://start2.example', 'Server', 'basic']]) {
    await handlers['Fetch.authRequired']({ requestId: origin + source + scheme, authChallenge: { origin, source, scheme } });
  }
  const replies = sent.filter(row => row.method === 'Fetch.continueWithAuth');
  assert.equal(replies.length, 4);
  for (const reply of replies.slice(0, 3)) {
    assert.equal(reply.params.authChallengeResponse.response, 'CancelAuth');
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(secret));
  }
  assert.equal(replies[3].params.authChallengeResponse.password, secret);
  assert.equal(sent.some(row => row.method === 'Network.setExtraHTTPHeaders'), false);
});

import { EventEmitter } from 'node:events';
import { runProductionBaseline, baselineOrigin } from '../ops/qualification-production-baseline.mjs';
import { startBaselineSample } from '../ops/qualification-live-baseline.mjs';
import { createQualificationHost } from '../ops/qualification-host-template.mjs';

const binding = { baselineOrigin: 'https://start2.example', maxDurationSeconds: 1,
  baseline: { plugin: 'elevenlabs', model: 'agent_fake', agentId: 'agent_fake', accountRef: 'fake-account',
    endpoint: 'https://api.elevenlabs.io', microPerMinute: 1001 } };

for (const origin of [undefined, 'http://start2.example', 'https://localhost', 'https://127.1', 'https://127.0.0.2',
  'https://localhost.', 'https://sub.localhost.', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://start2.example/', 'https://user:fake@start2.example', 'https://start2.example/path']) {
  test(`baselineOrigin rejects ${origin === undefined ? 'missing' : new URL(origin).hostname}`, () => {
    assert.throws(() => baselineOrigin(origin), /baselineOrigin/);
  });
}

test('stale loopback baseline wiring hard refuses', async () => {
  await assert.rejects(startBaselineSample({}), /Loopback baseline refused/);
});

test('baseline missing auth refuses before browser, control or admission', async t => {
  const { dir, path } = await fixture(t);
  const host = createQualificationHost({ binding, hostOrigin: 'http://127.0.0.1:4567', runDirectory: dir,
    ownerHeaders: { cookie: 'LOOPBACK_OWNER_NEVER_BASELINE' }, controlCapability: 'a'.repeat(64),
    verifyCeiling() {}, verifyReceipt() {}, reconcile() {}, launchBrowser() { assert.fail('must not launch'); } });
  await assert.rejects(host.runSample({ item: { id: 'fake', wavPath: path }, lane: 'baseline', runId: 'fake',
    admit() { assert.fail('must not admit'); }, onTiming() {} }), /Baseline auth/);
});

async function productionFixture(t, { duration = false, refusal, duplicate = false } = {}) {
  const order = [], sent = [], identities = [], reports = [], timings = [], aborts = [];
  const expiry = Promise.withResolvers(); expiry.promise.catch(() => {});
  const page = new EventEmitter(), cdp = new EventEmitter();
  cdp.send = async (method, params) => { sent.push({ method, params }); };
  page.createCDPSession = async () => cdp;
  page.evaluateOnNewDocument = async fn => { assert.equal(fn.name, 'installBaselineProbe'); };
  page.url = () => binding.baselineOrigin + '/';
  const response = (path, body) => page.emit('response', { url: () => binding.baselineOrigin + path, ok: () => true,
    request: () => ({ method: () => 'POST' }), json: async () => body });
  page.goto = async () => { response('/api/sessions', { id: 'production-visitor' }); return { ok: () => true }; };
  page.waitForSelector = async () => {};
  page.$ = async () => true; page.$eval = async () => false;
  page.click = async selector => {
    if (selector.endsWith('.ready__start')) {
      order.push('conversation');
      assert.ok(order.includes('consume'));
      cdp.emit('Fetch.requestPaused', { requestId: 'start-1', request: { url: binding.baselineOrigin + '/api/sessions/production-visitor/voice',
        method: 'POST', postData: JSON.stringify({ callId: 'fake-call' }) } });
      if (duplicate) cdp.emit('Fetch.requestPaused', { requestId: 'start-2', request: {
        url: binding.baselineOrigin + '/api/sessions/production-visitor/voice', method: 'POST' } });
      response('/api/sessions/production-visitor/voice', { providerSessionId: 'conv_fake', callId: 'fake-call', epoch: 0 });
    }
  };
  page.waitForFunction = async () => { if (duration) await expiry.promise; };
  page.evaluate = async (fn, input) => {
    if (fn.toString().includes('Probe.result')) return { hypothesis: 'Wien', ttsPCM: Buffer.from(new Float32Array([0.5]).buffer).toString('base64'),
      ttsFormat: { encoding: 'pcm_f32le', sampleRateHz: 48000, channels: 1 }, trace: [
        { kind: 'capture', voiced: true, captureAt: 10, durationMs: 40 },
        { kind: 'playback-start', firstAudioAt: 100 }, { kind: 'capture', voiced: true, captureAt: 200, durationMs: 40 },
        { kind: 'playback-stop', stoppedAt: 250 },
      ] };
    if (input?.visitorSessionId) order.push('stop');
  };
  const run = () => runProductionBaseline({ page, binding, item: { id: 'corpus' }, runId: 'fake-run',
    auth: { username: 'fake-operator', password: secret }, consentDecision: { items: ['voice-elevenlabs', 'models-international'] },
    bounded: promise => Promise.race([promise, expiry.promise]), abort(error) { aborts.push(error.message); expiry.reject(error); },
    preflight: async () => ({ verified: true }), boundConversation: async deadlineAt => {
      assert.ok(deadlineAt > Date.now()); order.push('duration-watchdog');
    }, recordIdentity: async value => identities.push(value), onTiming: event => timings.push(event),
    async admit(spec) {
      order.push('admit'); if (refusal === 'admit') throw new Error('fake admission denied');
      // Source: explicit synthetic tariff 1001 micro/min * binding 1 s / 60,
      // rounded up by the shared integer-micro accounting contract.
      assert.equal(spec.maxMicro, 17); assert.equal(spec.request.visitorSessionId, 'production-visitor');
      return { attempt: { attemptId: spec.attemptId, async consume() { if (refusal === 'consume') throw new Error('fake consume denied'); order.push('consume'); } },
        report: async terminal => reports.push(terminal) };
    } });
  return { run, page, sent, order, reports, identities, timings, aborts };
}

test('production flow admits/consumes once before conversation, labels both identities and retains uncertain terminal', async t => {
  const h = await productionFixture(t, { duplicate: true }), result = await h.run();
  assert.deepEqual(h.order, ['admit', 'duration-watchdog', 'consume', 'conversation', 'stop']);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
  assert.equal(h.reports[0].chargedMicro, undefined);
  assert.equal(result.baselineSession.visitorSessionId, 'production-visitor');
  assert.equal(result.baselineSession.providerSessionId, 'conv_fake');
  assert.equal(result.ttsPCM.byteLength, 4); assert.equal(h.timings.length, 4);
  assert.ok(h.sent.some(row => row.method === 'Fetch.failRequest' && row.params.requestId === 'start-2'));
  const evidence = JSON.stringify({ result, identities: h.identities, reports: h.reports });
  assert.doesNotMatch(evidence, /FAKE_BASIC_AUTH|fake-operator|LOOPBACK_OWNER|qualification-control|API_KEY/);
});

for (const refusal of ['admit', 'consume']) test(`production refused ${refusal} prevents conversation`, async t => {
  const h = await productionFixture(t, { refusal }); await assert.rejects(h.run(), /Production baseline failed/);
  assert.equal(h.order.includes('conversation'), false);
  assert.equal(h.reports.length, refusal === 'consume' ? 1 : 0);
  if (h.reports.length) assert.equal(h.reports[0].outcome, 'cancelled');
});

test('binding hard duration stops an idle production conversation and reports uncertainty', { timeout: 4000 }, async t => {
  const h = await productionFixture(t, { duration: true }); await assert.rejects(h.run(), /Production baseline failed/);
  assert.equal(h.order.includes('stop'), true);
  assert.equal(h.aborts.length, 1); assert.match(h.aborts[0], /duration bound/);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
});

test('baseline launcher gets fresh profile and corpus flags, with no loopback headers, control or provider credentials', async t => {
  const { dir, path } = await fixture(t), launches = [], permissions = [], evaluations = [];
  const forbidden = ['LOOPBACK_OWNER_SENTINEL', 'b'.repeat(64), 'PROVIDER_KEY_SENTINEL', secret];
  const page = new EventEmitter();
  const cdp = new EventEmitter(); cdp.send = async () => {};
  page.createCDPSession = async () => cdp;
  page.evaluateOnNewDocument = async (...args) => evaluations.push(args.map(String));
  page.evaluate = async (...args) => evaluations.push(args.map(String));
  page.goto = async url => { assert.equal(url, binding.baselineOrigin + '/'); return { ok: () => false }; };
  page.setExtraHTTPHeaders = () => assert.fail('Baseline must not receive owner headers');
  const host = createQualificationHost({ binding: { ...binding, baselineAuthFile: path },
    hostOrigin: 'http://127.0.0.1:4567', runDirectory: dir, ownerHeaders: { cookie: forbidden[0] }, controlCapability: forbidden[1],
    keys: { ELEVENLABS_API_KEY: forbidden[2] }, verifyCeiling() {}, verifyReceipt() {}, reconcile() {},
    async launchBrowser(options, lifetime) {
      launches.push(options); lifetime.registerProcessGroup({ watchdogArmed: true, kill() {} });
      return { defaultBrowserContext: () => ({ async overridePermissions(origin) { permissions.push(origin); } }),
        newPage: async () => page, async close() {} };
    } });
  t.after(() => host.close());
  for (let i = 0; i < 2; i++) await assert.rejects(host.runSample({ item: { id: 'one', wavPath: path }, lane: 'baseline', runId: 'fake',
    admit() { assert.fail('Navigation failed before admission'); }, onTiming() {} }), /Production baseline failed/);
  assert.notEqual(launches[0].userDataDir, launches[1].userDataDir);
  assert.deepEqual(permissions, [binding.baselineOrigin, binding.baselineOrigin]);
  for (const launch of launches) {
    assert.ok(launch.args.includes(`--use-file-for-fake-audio-capture=${path}`));
    assert.ok(launch.args.includes('--use-fake-device-for-media-stream'));
    assert.deepEqual(launch.ignoreDefaultArgs, ['--mute-audio']);
  }
  for (const value of forbidden) assert.equal(JSON.stringify({ launches, evaluations }).includes(value), false);
});

import { runInNewContext } from 'node:vm';
import { installBaselineProbe } from '../ops/qualification-baseline-probe.js';

test('injected probe ignores silence in unrelated audio contexts after barge-in', async () => {
  const contexts = []; let now = 0;
  class Node {
    constructor(context) { this.context = context; }
    connect(destination) { return destination; }
    disconnect() {}
  }
  class Context {
    constructor(options = {}) { this.sampleRate = options.sampleRate ?? 48000; this.currentTime = 0; this.processors = [];
      this.destination = new Node(this); contexts.push(this); }
    createScriptProcessor() { const node = new Node(this); this.processors.push(node); return node; }
    createGain() { const node = new Node(this); node.gain = { value: 1 }; return node; }
    createMediaStreamSource() { return new Node(this); }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: this.currentTime * 1000 }; }
    async resume() {} async close() {}
  }
  class MediaStream {}
  class MediaElement { play() {} }
  const runtime = { AudioNode: Node, AudioContext: Context, MediaStream, HTMLMediaElement: MediaElement,
    navigator: { mediaDevices: { getUserMedia: async () => new MediaStream() } },
    location: { origin: binding.baselineOrigin, href: binding.baselineOrigin + '/' }, URL,
    performance: { now: () => now }, fetch: async () => ({}), setTimeout, clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64') };
  runtime.window = runtime;
  runInNewContext(`(${installBaselineProbe.toString()})()`, runtime);
  const probe = runtime.qualificationBaselineProbe; probe.arm();
  await runtime.navigator.mediaDevices.getUserMedia({ audio: true });
  const capture = contexts[0];
  const audio = new Context(), other = new Context();
  new Node(audio).connect(audio.destination); new Node(other).connect(other.destination);
  const emit = (context, time, level) => {
    // Synthetic device timestamps test graph attribution, never qualify audio.
    now = time * 1000; context.currentTime = time + .1;
    const samples = new Float32Array(1024).fill(level);
    context.processors[0].onaudioprocess({ playbackTime: time + samples.length / context.sampleRate,
      inputBuffer: { duration: samples.length / context.sampleRate, getChannelData: () => samples } });
  };
  emit(capture, .5, .2);
  for (const event of [{ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' }, { type: 'final', role: 'assistant', text: 'Danke.' }]) {
    await runtime.fetch('/api/sessions/visitor/voice/call/events', { body: JSON.stringify({ event }) });
  }
  emit(audio, 1, .2); emit(capture, 2, .2);
  emit(other, 2.1, 0);
  assert.equal(probe.complete(), false, 'a silent microphone graph cannot establish agent stop');
  emit(audio, 2.2, .2); assert.equal(probe.complete(), false, 'agent is still audible');
  emit(audio, 2.3, 0); assert.equal(probe.complete(), true);
  const result = probe.result();
  assert.equal(result.hypothesis, 'Wien'); assert.ok(result.ttsPCM.length > 0);
  assert.equal(result.trace.filter(event => event.kind === 'playback-stop').length, 1);
  await probe.close();
});
