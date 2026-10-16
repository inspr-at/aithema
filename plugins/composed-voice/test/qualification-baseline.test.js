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
  'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://start2.example/', 'https://user:fake@start2.example', 'https://start2.example/path']) {
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
