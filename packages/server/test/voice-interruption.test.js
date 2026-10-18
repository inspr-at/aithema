import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { buildVoiceReplyRequest } from '../src/voice-handlers.js';
import { temporaryDb } from '../../../test/helpers.js';

for (const beforeFinal of [false, true]) test(`AIT-349: interruption ${beforeFinal ? 'before' : 'after'} final survives reload/recovery without truncation or a heard event`, async t => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path); t.after(() => storage.close());
  const session = storage.create(), callId = 'call', provider = 'generation', turnId = `${provider}:reply`;
  const full = 'The full generated reply. Including its unheard ending.';
  const post = event => storage.postVoiceEvent(session.id, callId, provider, { callId, providerSessionId: provider, turnId, ...event });
  const final = () => post({ type: 'final', role: 'assistant', text: full });
  if (!beforeFinal) final();
  const first = post({ type: 'interrupted', heardLength: 'unknown' });
  assert.equal(post({ type: 'interrupted', heardLength: 'unknown' }).replayed, true);
  if (beforeFinal) final();
  assert.equal(first.event.type, 'voice.interrupted');
  storage.close(); storage = new SQLiteStorage(path);
  const recovered = storage.get(session.id), turn = recovered.transcript.find(t => t.id === turnId);
  assert.equal(turn.content, full); assert.deepEqual(turn.interruption, { heardLength: 'unknown' });
  assert.equal(storage.read(session.id).filter(e => e.type === 'voice.interrupted').length, 1);
  assert.equal(storage.read(session.id).some(e => e.type === 'heard' || e.type === 'turn.corrected'), false);
  const request = buildVoiceReplyRequest({ session: recovered, messages: [{ role: 'user', content: 'Continue' }],
    call: { callId, providerSessionId: 'recovered-generation' } });
  assert.match(request.system, /interrupted/iu); assert.match(request.system, /unknown/iu);
  assert.ok(request.messages.some(m => m.content.includes(full)));
  assert.throws(() => post({ type: 'interrupted', heardLength: 42 }), /Invalid voice event/u);
});
