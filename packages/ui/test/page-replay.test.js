import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageReplay } from '../src/page-replay.js';

test('AIT-154: page audio uses the same capability and stops on an external hold', async () => {
  const held = new AbortController(), requests = []; let stops = 0;
  const player = createPageReplay({ control: { async speakText(request) { requests.push(request); return { kind: 'audio', audio: {} }; } },
    playAudio: async () => ({ stop() { stops++; }, finished: new Promise(() => {}) }) });
  assert.equal((await player.replay({ turnId: 'shown-reply', text: 'Shown reply.' }, { holdSignal: held.signal })).kind, 'audio');
  assert.equal(requests[0].turnId, 'shown-reply'); assert.match(requests[0].replayId, /^[a-f0-9-]{36}$/u); held.abort(); assert.equal(stops, 1); assert.equal(player.active, false);
});

test('AIT-154: a newer shown reply refuses page playback while synthesis is pending', async () => {
  let release, current = true, plays = 0;
  const player = createPageReplay({ control: { speakText: () => new Promise(resolve => { release = resolve; }) },
    playAudio: async () => { plays++; } });
  const pending = player.replay({ turnId: 'old', text: 'Old.' }, { current: () => current });
  await Promise.resolve(); current = false; release({ kind: 'audio', audio: {} });
  await assert.rejects(pending, { code: 'unavailable' }); assert.equal(plays, 0);
});

for (const ending of ['complete', 'Stop', 'error']) test(`AIT-190: page replay reports ${ending} separately from played-through audio`, async () => {
  const finished = Promise.withResolvers(), states = [];
  const player = createPageReplay({ control: { speakText: async () => ({ kind: 'audio', audio: {} }) },
    playAudio: async () => ({ stop() {}, finished: finished.promise }) });
  await player.replay({ turnId: 'last', text: 'Last reply' }, { onState: (playing, detail) => states.push({ playing, completed: Boolean(detail?.completed) }) });
  if (ending === 'Stop') player.stop();
  else finished.resolve(ending === 'complete');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, [{ playing: true, completed: false }, { playing: false, completed: ending === 'complete' }]);
});

for (const ending of ['ended', 'error', 'Stop']) test(`AIT-190: the PCM element's ${ending} signal cannot confuse completion and interruption`, async () => {
  const { playReplyAudio } = await import('../src/reply-audio.js');
  const audio = new EventTarget(), attributes = new Map();
  Object.assign(audio, { srcObject: null, getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name), play: async () => {}, pause() {} });
  const player = await playReplyAudio({ format: 'pcm_16000', data: btoa('\0\0') }, { document: { createElement: () => audio } });
  if (ending === 'Stop') player.stop(); else audio.dispatchEvent(new Event(ending));
  assert.equal(await player.finished, ending === 'ended');
});
