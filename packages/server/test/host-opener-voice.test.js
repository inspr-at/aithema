import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceHandlers } from '../src/voice-handlers.js';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../../../plugins/elevenlabs/src/callbacks.js';
const instant = 1_800_000_000_000;
const opener = { en: 'Welcome. Your AI assistant is ready.' };
async function fixture(t, { native = true, presentation, history = false, refused = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: instant });
  const storage = new SQLiteStorage(':memory:', { now: () => instant });
  const session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  if (history) storage.append(session.id, 'turn.final', { id: 'old', role: 'user', content: 'Earlier input.' });
  const published = [], starts = [], secrets = createFacadeSecrets();
  const handlers = createVoiceHandlers({ storage, secrets: native ? secrets : undefined, opener, presentation,
    ownership: { token: () => 'fixture-owner' }, readBody: async r => new Uint8Array(await r.arrayBuffer()),
    now: () => instant, publish: (id, event) => published.push(event), onTurn() {},
    runtime: { voiceServerAdapters: () => native ? [elevenLabsCallbackPort] : [], async checkVoice() {},
      async admitVoice({ options }) {
        if (refused) throw new TypeError('Fixture refusal');
        return { binding: { maxDurationSeconds: 120, publicFacadeBaseUrl: 'https://host.example.test' }, options, finish() {},
          plugin: { manifest: { liveVoice: { capabilities: { interruption: 'native' }, ownership: { turnTaking: 'provider' } } },
            ports: { serverAdapter: native ? elevenLabsCallbackPort : undefined }, async start(request, opts) {
              starts.push(request);
              return { callId: request.callId, providerSessionId: 'fixture-generation', signal: new AbortController().signal,
                spendDeadlineAt: opts.spendDeadlineAt, browserLivenessDeadlineAt: opts.browserLivenessDeadlineAt,
                snapshot: () => ({}), close: async () => ({ closureConfirmed: true, outcome: 'cancelled' }) };
            } } };
      } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const post = (path, body) => handlers.handle(new Request(`https://host.example.test/api/sessions/${session.id}/voice${path}`, {
    method: 'POST', body: JSON.stringify(body) }));
  const start = () => post('', { callId: 'fixture-call' });
  const event = value => post('/fixture-call/events', { providerSessionId: 'fixture-generation', event: {
    callId: 'fixture-call', turnId: 'fixture-generation:assistant:0', ...value } });
  return { storage, session, published, starts, start, event, post };
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
