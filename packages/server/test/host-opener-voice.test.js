import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceHandlers } from '../src/voice-handlers.js';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../../../plugins/elevenlabs/src/callbacks.js';
const instant = 1_800_000_000_000;
const opener = { en: 'Welcome. Your AI assistant is ready.' };
async function fixture(t, { native = true, presentation, history = false, refused = false, configuredOpener = opener, conversationLimit = 'time', failFirstAt } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: instant });
  const storage = new SQLiteStorage(':memory:', { now: () => instant });
  const session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  if (history) storage.append(session.id, 'turn.final', { id: 'old', role: 'user', content: 'Earlier input.' });
  const published = [], starts = [], secrets = createFacadeSecrets();
  let complete, admissions = 0;
  const adapter = { ...elevenLabsCallbackPort, bindCallbacks(operations) { complete = operations.onCompletion; return elevenLabsCallbackPort.bindCallbacks(operations); } };
  const handlers = createVoiceHandlers({ storage, secrets: native ? secrets : undefined, opener: configuredOpener, presentation,
    ownership: { token: () => 'fixture-owner' }, readBody: async r => new Uint8Array(await r.arrayBuffer()),
    now: () => instant, publish: (id, event) => published.push(event), onTurn() {},
    runtime: { conversationLimits: { policy: () => conversationLimit, deadline: () => Infinity }, voiceServerAdapters: () => native ? [adapter] : [], async checkVoice() {},
      async admitVoice({ options }) {
        admissions++;
        if (refused || failFirstAt === 'admission' && admissions === 1) throw new TypeError('Fixture refusal');
        return { binding: { maxDurationSeconds: 120, publicFacadeBaseUrl: 'https://host.example.test' }, options, finish() {},
          plugin: { manifest: { liveVoice: { capabilities: { interruption: 'native' }, ownership: { turnTaking: 'provider' } } },
            ports: { serverAdapter: native ? adapter : undefined }, async start(request, opts) {
              starts.push(request);
              if (failFirstAt === 'start' && admissions === 1) throw new TypeError('Fixture start failure');
              return { callId: request.callId, providerSessionId: starts.length === 1 ? 'fixture-generation' : `fixture-generation-${starts.length}`, signal: new AbortController().signal,
                spendDeadlineAt: opts.spendDeadlineAt, browserLivenessDeadlineAt: opts.browserLivenessDeadlineAt,
                snapshot: () => ({}), close: async () => ({ closureConfirmed: true, outcome: 'cancelled' }) };
            } } };
      } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const post = (path, body) => handlers.handle(new Request(`https://host.example.test/api/sessions/${session.id}/voice${path}`, {
    method: 'POST', body: JSON.stringify(body) }));
  const start = (callId = 'fixture-call') => post('', { callId });
  const event = value => post('/fixture-call/events', { providerSessionId: 'fixture-generation', event: {
    callId: 'fixture-call', turnId: 'fixture-generation:assistant:0', ...value } });
  return { storage, session, published, starts, start, event, post, complete(content) { complete({callId:'fixture-call',providerSessionId:'fixture-generation',replyId:'chatcmpl-real',content,textOrigin:{origin:'ai-generated'},userTurnOrdinal:1}); } };
}
test('AIT-505: successful native connection persists one opener and maps greeting/correction', async t => {
  const f = await fixture(t);
  assert.equal((await f.start()).status, 201);
  assert.equal(f.starts[0].overrides.agent.firstMessage, opener.en);
  assert.deepEqual(f.storage.get(f.session.id).transcript.map(t => t.id), ['host:opener']);
  assert.equal(f.published.filter(e => e.type === 'turn.final').length, 1);
  assert.equal((await f.event({ type: 'final', role: 'assistant', text: opener.en })).status, 200);
  assert.equal((await f.event({ type: 'heard', prefix: 'Welcome.' })).status, 200);
  const turns = f.storage.get(f.session.id).transcript;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, opener.en);
  assert.equal(turns[0].interruption.heardLength, 'Welcome.'.length);
});
for (const state of ['history', 'custom', 'grok', 'refused']) test(`AIT-505: ${state} retains its speech and persistence boundary`, async t => {
  const f = await fixture(t, { history: state === 'history', native: state !== 'grok', refused: state === 'refused',
    ...(state === 'custom' ? { presentation: () => ({ agent: { language: 'en', firstMessage: 'Custom.' } }) } : {}) });
  const response = await f.start();
  assert.equal(response.status, state === 'refused' ? 400 : 201);
  const turns = f.storage.get(f.session.id).transcript;
  assert.equal(turns.some(t => t.id === 'host:opener'), !['history', 'refused'].includes(state));
  if (state === 'custom') assert.equal(f.starts[0].overrides.agent.firstMessage, 'Custom.');
  if (state === 'grok') assert.equal(f.starts[0].overrides, undefined);
  if (state === 'history') assert.notEqual(f.starts[0].overrides?.agent.firstMessage, opener.en);
});

test('AIT-505: greeting dropped while paused never consumes the first real model reply', async t => {
  const f = await fixture(t); await f.start();
  // The SDK drops a paused greeting, so no greeting final reaches the server.
  f.complete('A real reply.');
  const response = await f.event({ type: 'final', role: 'assistant', text: 'A real reply.', replyId: 'chatcmpl-real' });
  assert.equal(response.status, 200);
  const turns = f.storage.get(f.session.id).transcript;
  assert.equal(turns.length, 2);
  assert.equal(turns[0].id, 'host:opener');
  assert.equal(turns[1].content, 'A real reply.');
  assert.equal(turns[1].provenance, 'facade-produced');
});
test('AIT-505: a new call after an earlier connected call uses continuation speech', async t => {
  const f = await fixture(t); await f.start();
  assert.equal((await f.post('/fixture-call/close', {providerSessionId:'fixture-generation',reason:'closed'})).status,200);
  assert.equal((await f.start('fixture-call-two')).status,201);
  assert.notEqual(f.starts[1].overrides.agent.firstMessage,opener.en);
  assert.equal(f.storage.get(f.session.id).transcript.filter(t=>t.id==='host:opener').length,1);
});

test('AIT-505: only one native final can map to the opener', async t => {
  const f = await fixture(t); await f.start();
  await f.event({type:'final',role:'assistant',text:opener.en});
  assert.equal((await f.event({type:'final',role:'assistant',text:'Another response.',turnId:'fixture-generation:assistant:1'})).status,200);
  assert.deepEqual(f.storage.get(f.session.id).transcript.map(t=>t.content),[opener.en,'Another response.']);
});

test('AIT-505: invalid disclosure rejects the server voice mount before accepting traffic', t => {
  const storage = new SQLiteStorage(':memory:', {now:()=>instant});t.after(()=>storage.close());
  assert.throws(()=>createVoiceHandlers({storage,opener:{en:'A human is ready.'},secrets:createFacadeSecrets(),
    runtime:{voiceServerAdapters:()=>[elevenLabsCallbackPort]}}),TypeError);
});

for (const boundary of ['withdrawn-history', 'empty-connected-call']) test(`AIT-505 M1: no opener preserves legacy presentation after ${boundary}`, async t => {
  const contexts = [];
  const f = await fixture(t, { configuredOpener: {}, presentation(locale, context) {
    contexts.push(context); return { agent: { language: locale, firstMessage: 'Custom AI assistant.' } };
  } });
  if (boundary === 'withdrawn-history') {
    f.storage.append(f.session.id, 'turn.final', { id: 'withdrawn', role: 'user', content: 'Earlier input.' });
    f.storage.withdraw(f.session.id, 'withdrawn');
  } else {
    assert.equal((await f.start()).status, 201);
    assert.equal((await f.post('/fixture-call/close', { providerSessionId: 'fixture-generation', reason: 'closed' })).status, 200);
  }
  assert.equal((await f.start(boundary === 'empty-connected-call' ? 'second-call' : 'fixture-call')).status, 201);
  assert.deepEqual(contexts.at(-1), { hasPriorTurns: false });
});

test('AIT-505 L5: host heard length is bounded by canonical text', async t => {
  const f = await fixture(t); await f.start();
  await f.event({ type: 'final', role: 'assistant', text: opener.en });
  assert.equal((await f.event({ type: 'heard', prefix: opener.en + ' extra provider text' })).status, 200);
  const turn = f.storage.get(f.session.id).transcript[0];
  assert.equal(turn.interruption.heardLength, opener.en.length);
  assert.equal(turn.content, opener.en);
});

for (const failFirstAt of ['admission', 'start']) test(`AIT-505 / AIT-508: ${failFirstAt} failure consumes first contact without claiming an opener on the next credits call`, async t => {
  const f = await fixture(t, { conversationLimit: 'credits', failFirstAt });
  assert.equal((await f.start()).status, 400);
  assert.equal(f.storage.voiceLifecycle(f.session.id, 'fixture-call').state, 'ended');
  assert.deepEqual(f.storage.get(f.session.id).transcript, []);
  const response = await f.start('next-call');
  assert.equal(response.status, 201);
  assert.equal((await response.json()).presentation, 'continuation');
  assert.notEqual(f.starts.at(-1).overrides?.agent.firstMessage, opener.en);
  assert.deepEqual(f.storage.get(f.session.id).transcript, [], 'later logical calls cannot newly persist the first-contact opener');
  assert.equal(f.published.filter(e => e.type === 'turn.final').length, 0);
});

test('AIT-505 / AIT-508: ElevenLabs recovery and a fresh credits call after idle never repeat or re-persist the opener', async t => {
  const f = await fixture(t, { conversationLimit: 'credits' });
  assert.equal((await f.start()).status, 201);
  assert.equal(f.starts[0].overrides.agent.firstMessage, opener.en);
  const original = f.storage.get(f.session.id).transcript[0];
  const recovered = await f.post('/fixture-call/recover', { providerSessionId: 'fixture-generation' });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).presentation, 'continuation');
  assert.equal(f.starts[1].overrides.agent.firstMessage, '');
  assert.equal((await f.post('/fixture-call/close', { providerSessionId: 'fixture-generation-2', reason: 'idle' })).status, 200);
  assert.equal(f.storage.voiceLifecycle(f.session.id, 'fixture-call').terminalReason, 'idle');
  const next = await f.start('after-idle');
  assert.equal(next.status, 201);
  assert.equal((await next.json()).presentation, 'continuation');
  assert.notEqual(f.starts[2].overrides.agent.firstMessage, opener.en);
  assert.deepEqual(f.storage.get(f.session.id).transcript, [original]);
  assert.equal(f.storage.read(f.session.id).filter(e => e.type === 'turn.final' && e.data.id === 'host:opener').length, 1);
  assert.equal(f.published.filter(e => e.type === 'turn.final' && e.data.id === 'host:opener').length, 1);
});

test('AIT-505 / AIT-508: no configured opener retains prior-call custom presentation context under credits policy', async t => {
  const contexts = [];
  const f = await fixture(t, { configuredOpener: {}, conversationLimit: 'credits', presentation(locale, context) {
    contexts.push(context); return { agent: { language: locale, firstMessage: 'Your AI assistant is ready.' } };
  } });
  assert.equal((await f.start()).status, 201);
  assert.deepEqual(contexts[0], { hasPriorTurns: false });
  assert.equal((await f.post('/fixture-call/close', { providerSessionId: 'fixture-generation', reason: 'idle' })).status, 200);
  assert.equal((await f.start('after-idle')).status, 201);
  assert.deepEqual(contexts[1], { hasPriorTurns: true, hasPriorCalls: true });
  assert.deepEqual(f.storage.get(f.session.id).transcript, []);
});
