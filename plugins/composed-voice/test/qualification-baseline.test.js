import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFailureDiagnostic, assertNoFailureDiagnostic } from './qualification-failure-fixture.js';
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

const binding = { baselineOrigin: 'https://start2.example', maxDurationSeconds: 1, baselineReasoningCeilingMicro: 23,
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
  await assert.rejects(host.runSample({ item: { id: 'fake', utterancePath: path, bargeInPath: path }, lane: 'baseline', runId: 'fake',
    admit() { assert.fail('must not admit'); }, onTiming() {} }), /Baseline auth/);
});

async function productionFixture(t, { duration = false, refusal, duplicate = false, configured = binding, admit, invalidEvidence, mediaRefusal, diagnosticsMissing = false, resultError = false, afterResultError = false } = {}) {
  const order = [], sent = [], identities = [], reports = [], timings = [], aborts = [], evidence = [];
  const expiry = Promise.withResolvers(); expiry.promise.catch(() => {});
  const page = new EventEmitter(), cdp = new EventEmitter();
  cdp.send = async (method, params) => { sent.push({ method, params }); };
  page.createCDPSession = async () => cdp;
  page.exposeFunction = async () => {};
  page.evaluateOnNewDocument = async fn => { assert.ok(['installQualificationOutputProbe', 'installBaselineProbe'].includes(fn.name)); };
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
  page.waitForFunction = async () => { if (duration) await expiry.promise; if (mediaRefusal) { const error = new Error('Synthetic media wait timeout'); error.name = 'TimeoutError'; throw error; } };
  page.evaluate = async (fn, input) => {
    if (/Probe\??\.diagnostics/u.test(fn.toString())) {
      if (diagnosticsMissing) return undefined;
      return { failure: invalidEvidence, hasHypothesis: true, speechEndAt: 50,
        firstAudioAt: mediaRefusal === 'late-first-audio' ? undefined : 100,
        bargeInAt: mediaRefusal === 'missing-playback-stop' ? 200 : undefined,
        source: { started: true, barged: mediaRefusal !== 'late-first-audio' } };
    }
    if (/Probe\??\.trace/u.test(fn.toString())) return [{ kind: 'capture', captureAt: 10, voiced: true, durationMs: 64 }];
    if (fn.toString().includes('Probe.result') && (invalidEvidence || resultError)) throw new Error('Invalid production media evidence');
    if (fn.toString().includes('Probe.result')) return { hypothesis: 'Wien', ttsPCM: Buffer.from(new Float32Array([0.5]).buffer).toString('base64'),
      ttsFormat: { encoding: 'pcm_f32le', sampleRateHz: 48000, channels: 1 }, trace: [
        { kind: 'capture', voiced: true, captureAt: 10, durationMs: 40 },
        { kind: 'playback-start', firstAudioAt: 100 }, { kind: 'capture', voiced: true, captureAt: 200, durationMs: 40 },
        { kind: 'playback-stop', stoppedAt: 250 },
      ] };
    if (input?.visitorSessionId) { order.push('stop'); if (afterResultError) throw new Error('Post-result protocol failure'); }
  };
  const run = () => runProductionBaseline({ page, binding: configured, item: { id: 'corpus' }, runId: 'fake-run',
    auth: { username: 'fake-operator', password: secret }, consentDecision: { items: ['voice-elevenlabs', 'models-international'] },
    bounded: promise => Promise.race([promise, expiry.promise]), abort(error) { aborts.push(error.message); expiry.reject(error); },
    preflight: async () => ({ verified: true }), boundConversation: async deadlineAt => {
      assert.ok(deadlineAt > Date.now()); order.push('duration-watchdog');
    }, recordIdentity: async value => identities.push(value), recordEvidence: async value => evidence.push(value), onTiming: event => timings.push(event),
    async admit(spec) {
      order.push('admit'); if (refusal === 'admit') throw new Error('fake admission denied');
      // Source: explicit synthetic tariff 1001 micro/min * binding 1 s / 60,
      // rounded up, plus 23 micro for production facade reasoning.
      assert.equal(spec.maxMicro, 40); assert.equal(spec.request.visitorSessionId, 'production-visitor');
      assert.equal(spec.request.baselineReasoningCeilingMicro, 23);
      if (admit) {
        const claim = await admit(spec);
        return { ...claim, attempt: { ...claim.attempt, async consume() { await claim.attempt.consume(); order.push('consume'); } } };
      }
      return { attempt: { attemptId: spec.attemptId, async consume() { if (refusal === 'consume') throw new Error('fake consume denied'); order.push('consume'); } },
        report: async terminal => reports.push(terminal) };
    } });
  return { run, page, sent, order, reports, identities, timings, aborts, evidence };
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
  assert.equal(h.evidence[0].status, 'invalid'); assert.equal(h.evidence[0].reason, 'duration-bound');
});

test('baseline launcher gets fresh profile and scripted capture, with no loopback headers, control or provider credentials', async t => {
  const { dir, path } = await fixture(t), launches = [], permissions = [], evaluations = [];
  const forbidden = ['LOOPBACK_OWNER_SENTINEL', 'b'.repeat(64), 'PROVIDER_KEY_SENTINEL', secret];
  const page = new EventEmitter();
  const cdp = new EventEmitter(); cdp.send = async () => {};
  page.createCDPSession = async () => cdp;
  page.exposeFunction = async () => {};
  page.evaluateOnNewDocument = async (...args) => evaluations.push(args.map(String));
  page.evaluate = async (...args) => evaluations.push(args.map(String));
  page.goto = async url => { assert.equal(url, binding.baselineOrigin + '/'); return { ok: () => false }; };
  page.setExtraHTTPHeaders = () => assert.fail('Baseline must not receive owner headers');
  const corpus = join(dir, 'utterance.wav'), wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  await writeFile(corpus, wav);
  const host = createQualificationHost({ binding: { ...binding, baselineAuthFile: path },
    hostOrigin: 'http://127.0.0.1:4567', runDirectory: dir, ownerHeaders: { cookie: forbidden[0] }, controlCapability: forbidden[1],
    keys: { ELEVENLABS_API_KEY: forbidden[2] }, verifyCeiling() {}, verifyReceipt() {}, reconcile() {},
    async launchBrowser(options, lifetime) {
      launches.push(options); lifetime.registerProcessGroup({ watchdogArmed: true, kill() {} });
      return { defaultBrowserContext: () => ({ async overridePermissions(origin) { permissions.push(origin); } }),
        newPage: async () => page, async close() {} };
    } });
  t.after(() => host.close());
  for (let i = 0; i < 2; i++) await assert.rejects(host.runSample({ item: { id: 'one', utterancePath: corpus, bargeInPath: corpus }, lane: 'baseline', runId: 'fake',
    admit() { assert.fail('Navigation failed before admission'); }, onTiming() {} }), /Production baseline failed/);
  assert.notEqual(launches[0].userDataDir, launches[1].userDataDir);
  assert.deepEqual(permissions, [binding.baselineOrigin, binding.baselineOrigin]);
  for (const launch of launches) {
    assert.ok(!launch.args.some(arg => /fake-device|fake-audio|fake-ui/.test(arg)));
    assert.deepEqual(launch.ignoreDefaultArgs, ['--mute-audio']);
  }
  for (const value of forbidden) assert.equal(JSON.stringify({ launches, evaluations }).includes(value), false);
});

import { runInNewContext } from 'node:vm';
import { installBaselineProbe } from '../ops/qualification-baseline-probe.js';
import { installQualificationOutputProbe } from '../ops/qualification-output-timing.js';
import { pageFixture } from './qualification-page-fixture.js';

async function probeFixture(scripted, { onClose = () => {}, onTerminal = () => {} } = {}) {
  if (scripted && !scripted.stopInput) scripted.stopInput = () => {};
  if (scripted && !scripted.diagnostics) scripted.diagnostics = () => ({ started: true, barged: false });
  const contexts = [], observers = []; let now = 0;
  class Element { attachShadow() { return {}; } }
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() {}
  }
  const rail = { matches: selector => selector === '.audio-rail', getAttribute: () => rail.state, state: 'listening' };
  const mode = state => {
    const oldValue = rail.state; rail.state = state;
    for (const observer of observers) observer.callback([{ target: rail, attributeName: 'data-state', oldValue }]);
  };
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
  const runtime = { qualificationScriptedCapture: scripted, Element, MutationObserver, document: { querySelector: () => ({ shadowRoot: { querySelector: () => ({ click: onClose }) } }) },
    qualificationMeasurementTerminal: async () => onTerminal(), AudioNode: Node, AudioContext: Context, MediaStream, HTMLMediaElement: MediaElement,
    navigator: { mediaDevices: { getUserMedia: async () => new MediaStream() } },
    location: { origin: binding.baselineOrigin, href: binding.baselineOrigin + '/' }, URL,
    performance: { now: () => now }, fetch: async () => ({}), setTimeout, clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64') };
  runtime.window = runtime;
  runInNewContext(`(${installQualificationOutputProbe.toString()})()`, runtime);
  runInNewContext(`(${installBaselineProbe.toString()})()`, runtime);
  const probe = runtime.qualificationBaselineProbe; probe.arm();
  await runtime.navigator.mediaDevices.getUserMedia({ audio: true });
  if (scripted) new Context({ sampleRate: 16000 });
  const capture = contexts[0];
  const audio = new Context(), other = new Context();
  new Node(audio).connect(audio.destination); new Node(other).connect(other.destination);
  const emit = (context, time, level, sampleCount = 1024) => {
    // Synthetic device timestamps test graph attribution, never qualify audio.
    now = time * 1000; context.currentTime = time + .1;
    const samples = new Float32Array(sampleCount).fill(level);
    context.processors[0].onaudioprocess({ playbackTime: time + samples.length / context.sampleRate,
      inputBuffer: { duration: samples.length / context.sampleRate, getChannelData: () => samples } });
  };
  const final = event => runtime.fetch('/api/sessions/visitor/voice/call/events', { body: JSON.stringify({ event }) });
  const opener = async () => {
    mode('speaking'); emit(audio, .1, .6);
    await final({ type: 'final', role: 'assistant', turnId: 'opener', text: 'AI notice. How can I help?' });
    now = 200; mode('listening'); emit(audio, .25, 0);
  };
  const silence = (context, time) => {
    for (let i = 0; i < 48; i++) emit(context, time + i * 1024 / context.sampleRate, 0);
  };
  return { probe, capture, audio, other, emit, silence, final, mode, opener };
}

test('injected probe ignores silence in unrelated audio contexts after barge-in', async () => {
  const { probe, capture, audio, other, emit, silence, final, opener } = await probeFixture();
  await opener();
  emit(capture, .5, .2); emit(capture, .6, 0);
  for (const event of [{ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' }, { type: 'final', role: 'assistant', text: 'Danke.' }]) {
    await final(event);
  }
  emit(audio, 1, .2); emit(capture, 2, .2);
  silence(other, 2.1);
  assert.equal(probe.complete(), false, 'a silent microphone graph cannot establish agent stop');
  emit(audio, 2.2, .2); assert.equal(probe.complete(), false, 'agent is still audible');
  emit(audio, 2.3, 0); assert.equal(probe.complete(), false, 'one quiet block cannot establish stop');
  silence(audio, 2.3); assert.equal(probe.complete(), true);
  const result = probe.result();
  assert.equal(result.hypothesis, 'Wien'); assert.ok(result.ttsPCM.length > 0);
  assert.equal(result.trace.filter(event => event.kind === 'playback-stop').length, 1);
  await probe.close();
});

import { initializeQualificationBudget, openPersistedQualificationBudget } from '../src/persisted-budget.js';

test('production baseline reserves ElevenLabs plus facade reasoning in the persisted cap until combined receipts reconcile', async t => {
  const { dir } = await fixture(t), path = join(dir, 'budget.sqlite');
  initializeQualificationBudget({ path, capMicro: 40 });
  const ports = { verifyCeiling: async spec => ({ ...spec, verified: true, reference: 'synthetic combined price proof', expiresAt: Date.now() + 60000 }),
    verifyReceipt: async receipt => receipt.conversationAuthenticated && receipt.reasoningAuthenticated };
  const budget = openPersistedQualificationBudget({ path, ...ports });
  t.after(() => budget.close());
  const h = await productionFixture(t, { admit: spec => budget.admit(spec) });
  await h.run();
  const snapshot = budget.snapshot(), row = snapshot.records[0];
  assert.equal(snapshot.exposureMicro, 40); assert.equal(row.maxMicro, 40);
  assert.equal(row.outcome, 'uncertain'); assert.equal(row.receipt, undefined);
  const restarted = openPersistedQualificationBudget({ path, ...ports }); t.after(() => restarted.close());
  assert.equal(restarted.snapshot().exposureMicro, 40);
  await assert.rejects(restarted.admit({ ...row, attemptId: 'extra-dispatch', maxMicro: 1, request: {} }), { code: 'not-admitted' });
  const receipt = { attemptId: row.attemptId, receiptId: 'combined-receipt', provider: row.provider, model: row.model,
    operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 9, estimated: false,
    conversationAuthenticated: true, reasoningAuthenticated: false };
  await assert.rejects(restarted.reconcile(receipt), { code: 'not-admitted' });
  assert.equal(restarted.snapshot().exposureMicro, 40, 'ElevenLabs receipt alone cannot release reasoning exposure');
  await restarted.reconcile({ ...receipt, reasoningAuthenticated: true });
  assert.equal(budget.snapshot().exposureMicro, 9);
});

for (const ceiling of [undefined, null, -1, .5, '23', Number.MAX_SAFE_INTEGER]) {
  test(`production baseline refuses invalid reasoning ceiling ${ceiling} before navigation or admission`, async t => {
    const h = await productionFixture(t, { configured: { ...binding, baselineReasoningCeilingMicro: ceiling } });
    h.page.goto = () => assert.fail('invalid combined ceiling must refuse before navigation');
    await assert.rejects(h.run(), /ceiling|binding/i);
    assert.deepEqual(h.order, []);
  });
}

for (const assistantFinal of ['late', 'missing']) test(`probe retains reply before ordinal-1 final with ${assistantFinal} reply final`, async () => {
  const { probe, capture, audio, emit, silence, final, opener } = await probeFixture();
  await opener();
  emit(capture, .5, .2); emit(capture, .7, 0);
  emit(audio, 1, .2); emit(audio, 1.2, .1);
  assert.equal(probe.diagnostics().firstAudioAt, undefined, 'ordinal 1 must anchor attribution');
  await final({ type: 'final', role: 'user', userTurnOrdinal: 2, text: 'Wrong ordinal' });
  assert.equal(probe.diagnostics().firstAudioAt, undefined);
  await final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  if (assistantFinal === 'late') await final({ type: 'final', role: 'assistant', turnId: 'reply', text: 'Danke.' });
  emit(capture, 2, .2); emit(audio, 2.1, .1); silence(audio, 2.2);
  assert.equal(probe.complete(), true);
  const result = probe.result(), start = result.trace.find(event => event.kind === 'playback-start');
  assert.ok(Math.abs(start.firstAudioAt - 1000) < .001);
  const bytes = Uint8Array.from(Buffer.from(result.ttsPCM, 'base64')), pcm = new Float32Array(bytes.buffer);
  assert.equal(pcm.length, 3 * 1024); assert.equal(pcm[0], Math.fround(.2));
  assert.equal(pcm[1024], Math.fround(.1)); assert.ok(pcm.every(value => value < .3));
  assert.ok(Math.abs(probe.diagnostics().bargeInAt - 1900) < .001);
  assert.ok(Math.abs(result.trace.find(event => event.kind === 'playback-stop').stoppedAt - 2200) < .001);
  assert.equal(result.hypothesis, 'Wien');
  await probe.close();
});

test('probe internal utterance pause cannot promote output before the ordinal-1 final', async () => {
  const { probe, capture, audio, emit, silence, final, opener } = await probeFixture();
  await opener();
  emit(capture, .5, .2); emit(capture, .6, 0); // Internal pause, not utterance completion.
  emit(audio, .65, .6); emit(audio, .75, 0); // Output during the internal pause is not the final reply.
  emit(capture, .8, .2); emit(capture, .9, 0);
  emit(audio, 1, .2);
  assert.equal(probe.diagnostics().firstAudioAt, undefined);
  await final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  emit(capture, 2, .2); silence(audio, 2.2);
  assert.equal(probe.complete(), true);
  const evidence = probe.result();
  assert.ok(Math.abs(evidence.trace.find(e => e.kind === 'playback-start').firstAudioAt - 1000) < .001);
  assert.equal(evidence.trace.filter(e => e.kind === 'capture' && e.voiced && e.captureAt < 1000).length, 2);
  await probe.close();
});

for (const delayed of [false, true]) test(`probe refuses ${delayed ? 'an opener starting after speech end' : 'an opener still playing at speech start'}`, async () => {
  const { probe, capture, audio, emit, final, mode } = await probeFixture();
  mode('speaking');
  if (!delayed) emit(audio, .1, .6);
  emit(capture, .3, .2); emit(capture, .5, 0);
  if (delayed) emit(audio, .7, .6);
  await final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  emit(audio, .8, .6); emit(capture, 1, .2); emit(audio, 1.2, 0);
  assert.equal(probe.complete(), true, 'invalid evidence terminates the attempt immediately');
  assert.equal(probe.diagnostics().failure, 'opener-overlap');
  assert.equal(probe.diagnostics().firstAudioAt, undefined);
  assert.throws(() => probe.result(), /Invalid production media evidence: opener-overlap/);
  await probe.close();
});

test('opener sentence pause and an assistant text final do not establish playback completion', async () => {
  const { probe, capture, audio, emit, final, mode } = await probeFixture();
  mode('speaking'); emit(audio, .1, .6); emit(audio, .2, 0);
  await final({ type: 'final', role: 'assistant', turnId: 'opener', text: 'AI notice. How can I help?' });
  emit(capture, .3, .2);
  assert.equal(probe.diagnostics().failure, 'opener-overlap');
  await probe.close();
});

test('missing ordinal-1 final cannot release buffered reply evidence', async () => {
  const { probe, capture, audio, emit, final, opener } = await probeFixture();
  await opener(); emit(capture, .5, .2); emit(capture, .7, 0);
  emit(audio, 1, .2); emit(capture, 2, .2); emit(audio, 2.2, 0);
  await final({ type: 'final', role: 'user', userTurnOrdinal: 2, text: 'Bitte aufhören' });
  assert.equal(probe.complete(), false);
  assert.equal(probe.diagnostics().firstAudioAt, undefined);
  assert.throws(() => probe.result(), /Incomplete production media evidence/);
  await probe.close();
});

test('opener overlap is recorded as invalid, closes once and retains uncertain exposure without a retry', async t => {
  const h = await productionFixture(t, { invalidEvidence: 'opener-overlap' });
  await assert.rejects(h.run(), /invalid evidence \(opener-overlap\)/);
  assert.equal(h.order.filter(step => step === 'admit').length, 1);
  assert.equal(h.order.filter(step => step === 'conversation').length, 1);
  assert.equal(h.order.filter(step => step === 'stop').length, 1);
  assert.equal(h.evidence.length, 1); assert.equal(h.evidence[0].status, 'invalid');
  assert.equal(h.evidence[0].reason, 'opener-overlap');
  assert.equal(h.evidence[0].providerSessionId, 'conv_fake');
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
});


for (const stoppedBeforeFinal of [false, true]) test(`probe refuses barge-in before user final (${stoppedBeforeFinal ? 'stopped' : 'playing'})`, async t => {
  const { probe, capture, audio, emit, final, opener } = await probeFixture();
  t.after(() => probe.close());
  await opener();
  emit(capture, .5, .2); emit(capture, .7, 0);
  emit(audio, 1, .2); emit(audio, 1.2, .1);
  emit(capture, 2, .2); emit(capture, 2.1, 0);
  if (stoppedBeforeFinal) emit(audio, 2.2, 0);
  await final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'PRIVATE_CORPUS_SENTINEL' });
  assert.equal(probe.complete(), true, 'refusal must terminate rather than fold barge-in into speech end');
  assert.equal(probe.diagnostics().failure, 'barge-in-before-user-final');
  assert.equal(probe.diagnostics().hasHypothesis, false);
  assert.throws(() => probe.result(), /Invalid production media evidence: barge-in-before-user-final/);
  assert.doesNotMatch(JSON.stringify(probe.diagnostics()), /PRIVATE_CORPUS_SENTINEL/);
});

for (const reason of ['trace-bound', 'output-queue-bound']) test(`probe names ${reason} failure`, async t => {
  const { probe, capture, audio, emit } = await probeFixture();
  t.after(() => probe.close());
  if (reason === 'trace-bound') {
    for (let i = 0; i <= 100_000; i++) emit(capture, i / 16000, 0, 1);
  } else {
    // A stalled device clock leaves > 8 seconds pending (browser-audio.js bound).
    audio.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
    for (let i = 0; i < 377; i++) emit(audio, 1 + i * 1024 / 48000, .2);
  }
  assert.equal(probe.complete(), true);
  assert.equal(probe.diagnostics().failure, reason);
  assert.throws(() => probe.result(), new RegExp(`Invalid production media evidence: ${reason}`));
});

test('barge-in-before-user-final refusal records once without content or retry', async t => {
  const h = await productionFixture(t, { invalidEvidence: 'barge-in-before-user-final' });
  await assert.rejects(h.run(), /invalid evidence \(barge-in-before-user-final\)/);
  assert.equal(h.evidence.length, 1);
  assert.equal(h.evidence[0].status, 'invalid');
  assert.equal(h.evidence[0].reason, 'barge-in-before-user-final');
  assert.doesNotMatch(JSON.stringify(h.evidence), /hypothesis|ttsPCM|text|FAKE_BASIC_AUTH/);
  assert.equal(h.order.filter(step => step === 'admit').length, 1);
  assert.equal(h.order.filter(step => step === 'conversation').length, 1);
  assert.equal(h.order.filter(step => step === 'stop').length, 1);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
});

for (const refusal of ['admit', 'consume']) test(`production ${refusal} refusal is not invalid media`, async t => {
  const h = await productionFixture(t, { refusal });
  await assert.rejects(h.run(), /Production baseline failed; not-admitted/);
  assert.equal(h.evidence.length, 1);
  assert.equal(h.evidence[0].status, 'not-admitted');
  assert.equal(h.evidence[0].reason, 'not-admitted');
});

test('production navigation failure is setup-failed rather than invalid media', async t => {
  const h = await productionFixture(t);
  h.page.goto = async () => { throw new Error('PRIVATE_SETUP_SENTINEL'); };
  await assert.rejects(h.run(), /Production baseline failed; setup-failed/);
  assert.equal(h.evidence.length, 1);
  assert.equal(h.evidence[0].status, 'setup-failed');
  assert.equal(h.evidence[0].reason, 'setup-failed');
  assert.doesNotMatch(JSON.stringify(h.evidence), /PRIVATE_SETUP_SENTINEL|hypothesis|ttsPCM/);
  assert.equal(h.reports.length, 0);
});

test('baseline scripted utterance waits for final, speaking/listening edge AND output drain', async () => {
  let starts = 0;
  const scripted = { subscribe() {}, startUtterance() { starts++; }, firstAudio() {} };
  const h = await probeFixture(scripted);
  h.mode('speaking'); h.emit(h.audio, .1, .6); h.emit(h.audio, .2, 0);
  assert.equal(starts, 0, 'sentence silence is not opener completion');
  await h.final({ type: 'final', role: 'assistant', text: 'Opener' });
  h.emit(h.audio, .3, 0); assert.equal(starts, 0, 'final alone is insufficient');
  h.mode('listening'); assert.equal(starts, 0, 'must observe drained output too');
  h.emit(h.audio, .4, 0); assert.equal(starts, 1);
  h.emit(h.audio, .5, 0); assert.equal(starts, 1);
});

for (const reason of ['late-first-audio', 'missing-playback-stop']) test(`production runSample ${reason} is a sample refusal with uncertain exposure`, async t => {
  const h = await productionFixture(t, { mediaRefusal: reason });
  await assert.rejects(h.run(), error => { assert.equal(error.reason, reason); return true; });
  assert.equal(h.evidence.length, 1); assert.equal(h.evidence[0].reason, reason);
  assert.equal(h.timings.length, 1); assert.equal(h.timings[0].kind, 'capture');
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0].outcome, 'uncertain');
});

for (const options of [{ diagnosticsMissing: true }, { resultError: true }, { afterResultError: true },
  { invalidEvidence: 'closure-uncertain' }, { invalidEvidence: 'start-failed' }]) {
  test(`production error stays an abort: ${JSON.stringify(options)}`, async t => {
    const h = await productionFixture(t, options);
    await assert.rejects(h.run(), error => { assert.equal(error.reason, undefined); return /Production baseline failed/u.test(error.message); });
    assert.equal(h.evidence.length, 1);
    assert.ok(!['late-first-audio', 'missing-playback-stop'].includes(h.evidence[0].reason));
    const persisted = await productionFixture(t, options);
    await assertFailureDiagnostic(t, persisted.run, 'baseline');
  });
}

test('late baseline user final consumes source refusal and completes before a duration timer', async () => {
  let capture;
  const scripted = { subscribe(fn) { capture = fn; }, startUtterance() {}, diagnostics: () => ({ started: true, barged: false, refusal: 'late-first-audio' }),
    firstAudio() { capture({ kind: 'capture-outcome', status: 'refused', reason: 'late-first-audio' }); }, async close() {} };
  const h = await probeFixture(scripted);
  await h.opener();
  capture({ kind: 'capture', voiced: true, captureAt: 500, receivedAt: 600, durationMs: 64 });
  h.emit(h.audio, 1, .2); h.emit(h.audio, 2, .2);
  await h.final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  assert.equal(h.probe.complete(), true);
  assert.equal(h.probe.result().refusal, 'late-first-audio');
  assert.equal(h.probe.diagnostics().failure, undefined);
  await h.probe.close();
});

// Both real lane runners consume the same rendered trace, including a near-
// threshold block. Neither an interrupt request nor still-voiced output stops it.
for (const reversed of [false, true]) test(`candidate and baseline use the same rendered silence stop timestamp (reversed ${reversed})`, async () => {
  const baseline = await probeFixture();
  await baseline.opener();
  baseline.emit(baseline.capture, .5, .2); baseline.emit(baseline.capture, .6, 0);
  await baseline.final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  baseline.emit(baseline.audio, 1, .2);
  if (!reversed) baseline.emit(baseline.capture, 2, .2);
  const outputTrace = [{ at: 1000, durationMs: 1024 / 48, rms: Math.fround(.2), voiced: true }];
  const frames = [[2, .2], [2.1, .0021], [2.2, .0019],
    ...Array.from({ length: 47 }, (_, i) => [2.2 + (i + 1) * 1024 / 48000, 0])];
  for (const [seconds, level] of frames) {
    baseline.emit(baseline.audio, seconds, level);
    outputTrace.push({ at: seconds * 1000, contextTime: seconds, durationMs: 1024 / 48, rms: Math.fround(level), voiced: level >= .002,
      timestamp: { contextTime: seconds + .1, performanceTime: (seconds + .1) * 1000 } });
  }
  if (reversed) baseline.emit(baseline.capture, 2, .2);
  const candidate = await pageFixture(undefined, { firstAudio: true, bargeIn: true, productStop: true,
    outputTrace, firstAudioAt: 1000, bargeInAt: 1900, stopBeforeSource: reversed });
  const result = await candidate.run();
  const stop = trace => trace.find(row => row.kind === 'playback-stop').stoppedAt;
  assert.equal(result.refusal, undefined);
  assert.ok(Math.abs(stop(result.trace) - stop(baseline.probe.result().trace)) < .001);
  assert.equal(stop(result.trace), 2200);
  await baseline.probe.close();
});

for (const gapMs of [120, 250]) test(`baseline sustained silence resets after a ${gapMs} ms gap and resumed speech`, async () => {
  const h = await probeFixture();
  await h.opener();
  h.emit(h.capture, .5, .2); h.emit(h.capture, .6, 0);
  await h.final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
  h.emit(h.audio, 1, .2); h.emit(h.capture, 2, .2);
  for (let ms = 0; ms < gapMs; ms += 20) h.emit(h.audio, 2.1 + ms / 1000, 0, 48 * Math.min(20, gapMs - ms));
  assert.equal(h.probe.complete(), false);
  h.emit(h.audio, 2.1 + gapMs / 1000, .1);
  assert.equal(h.probe.complete(), false);
  h.silence(h.audio, 2.5);
  assert.equal(h.probe.complete(), true);
  assert.equal(h.probe.result().trace.find(row => row.kind === 'playback-stop').stoppedAt, 2500);
  await h.probe.close();
});

for (const refused of [false, true]) test(`baseline terminal outcome fences input and ignores late product events (refused ${refused})`, async t => {
  const run = async input => {
    const order = []; let capture;
    const scripted = { subscribe(fn) { capture = fn; }, startUtterance() {}, firstAudio() {
      if (refused) capture({ kind: 'capture-outcome', status: 'refused', reason: 'late-first-audio' });
    }, stopInput() { order.push('input-fence'); }, async close() {} };
    const h = await probeFixture(scripted, { onClose: () => order.push('session-close'), onTerminal: () => order.push('node-close') });
    await h.opener(); capture({ kind: 'capture', voiced: true, captureAt: 500, receivedAt: 600, durationMs: 64 });
    await h.final({ type: 'final', role: 'user', userTurnOrdinal: 1, text: 'Wien' });
    h.emit(h.audio, 1, .2); capture({ kind: 'capture', voiced: true, captureAt: 1900, receivedAt: 2000, durationMs: 64 });
    h.silence(h.audio, 2.1);
    assert.equal(h.probe.complete(), true); assert.deepEqual(order, ['input-fence', 'session-close', 'node-close']);
    for (const event of [{ type: 'waiting', reason: 'provider' }, { type: 'waiting', reason: 'not-admitted' },
      { type: 'ended', reason: 'closure-uncertain' }]) await h.final(event);
    const result = h.probe.result();
    assert.equal(result.refusal, refused ? 'late-first-audio' : undefined);
    assert.equal(result.trace.filter(e => e.kind === 'post-measurement').length, 3);
    assert.equal(h.probe.diagnostics().failure, undefined);
    result.trace.forEach(input.onTiming); await h.probe.close();
  };
  if (refused) await run({ onTiming() {} });
  else await assertNoFailureDiagnostic(t, run, 'baseline');
});

for (const reason of ['limit', 'provider']) test(`baseline waiting:${reason} before terminal outcome aborts with failure.json`, async t => {
  const run = async () => {
    const h = await probeFixture();
    try { await h.final({ type: 'waiting', reason }); assert.equal(h.probe.complete(), true); h.probe.result(); }
    finally { await h.probe.close(); }
  };
  await assert.rejects(run(), /Invalid production media evidence: media-waiting/); await assertFailureDiagnostic(t, run, 'baseline');
});

for (const state of ['waiting', 'failed']) test(`baseline production rail ${state} before measurement aborts`, async () => {
  const h = await probeFixture();
  try { h.mode(state); assert.equal(h.probe.complete(), true); assert.throws(() => h.probe.result(), /Invalid production media evidence: media-/); }
  finally { await h.probe.close(); }
});
