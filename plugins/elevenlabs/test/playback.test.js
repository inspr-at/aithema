import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { watchVoicePlayback } from '../src/playback.js';

test('SDK DOM playback discovery, user-gesture retry and teardown belong to the browser adapter', async t => {
  const window = new Window(), document = window.document;
  t.after(() => window.happyDOM.close());
  let tries = 0;
  const blocked = Promise.withResolvers(), watcher = watchVoicePlayback(document, () => blocked.resolve());
  t.after(() => watcher.destroy());
  const audio = document.createElement('audio'); audio.autoplay = true;
  audio.play = async () => { if (++tries === 1) throw new window.DOMException('policy', 'NotAllowedError'); };
  document.body.append(audio); await blocked.promise;
  assert.equal(tries, 1);
  await watcher.retry(); assert.equal(tries, 2);
  audio.remove(); await watcher.retry(); assert.equal(tries, 2);
  watcher.destroy(); document.body.append(audio);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(tries, 2);
});
