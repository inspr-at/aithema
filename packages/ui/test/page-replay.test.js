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
