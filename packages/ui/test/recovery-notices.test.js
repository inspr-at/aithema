import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, copy) {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const events = voiceEvents(), replays = [];
  const session = { callId: 'call', providerSessionId: 'provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async replayLastReply() { replays.push('last'); return { kind: 'text', text: 'Exact last reply.\nWith paragraphs.' }; },
    async close() { events.end(); return { closureConfirmed: true }; } };
  const rail = new AudioRail({ root, copy, client: { async start() { return session; } }, feature: () => ({ available: true }), context: () => ({}) });
  t.after(async () => { await rail.close(); rail.destroy(); await window.happyDOM.close(); });
  await rail.start();
  const push = async event => { events.push({ callId: 'call', ...event }); await tick(); };
  const recover = recovery => push({ type: 'recovered', recovery });
  return { root, rail, push, recover, replays };
}

for (const [locale, copy] of [['de', de], ['en', en]]) {
  for (const [key, flags] of [
    ['voiceRecovered', {}], ['voiceUserUnconfirmed', { userUnconfirmed: true }],
    ['voiceReplyIncomplete', { deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Last reply' }],
  ]) test(`AIT-138 c: ${locale} ${key} triggers once and clears on the next turn`, async t => {
    const f = await fixture(t, copy);
    const region = f.root.querySelector('.voice-notices');
    assert.ok(region, 'notice space exists before recovery');
    assert.equal(region.querySelector('[role="status"]').textContent, '');
    await f.recover(flags);
    assert.ok(region.textContent.includes(copy[key]));
    const live = region.querySelector('[role="status"]');
    assert.equal(live.getAttribute('aria-atomic'), 'true');
    const mutations = [], observer = new f.root.ownerDocument.defaultView.MutationObserver(records => mutations.push(...records));
    observer.observe(live, { subtree: true, childList: true, characterData: true });
    f.rail.render(); f.rail.render(); await tick(); observer.disconnect();
    assert.equal(mutations.length, 0, 'repainting does not announce a notice again');
    await f.push({ type: 'partial', turnId: 'next', role: 'user', text: 'Next utterance' });
    assert.equal(live.textContent, '');
    assert.equal(region.querySelector('.voice-repeat').hidden, true);
  });

  test(`AIT-138 c: ${locale} explicit repeat uses only the last reply and displays the provider fallback`, async t => {
    const f = await fixture(t, copy);
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Exact last reply.\nWith paragraphs.' });
    const button = f.root.querySelector('.voice-repeat');
    assert.equal(button.textContent, copy.voiceRepeatReply); assert.equal(button.disabled, false);
    assert.deepEqual(f.replays, [], 'recovery never automatically repeats');
    button.click(); await tick();
    assert.deepEqual(f.replays, ['last']);
    const dialog = f.root.querySelector('.voice-reply-dialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.voice-reply-text').textContent, 'Exact last reply.\nWith paragraphs.');
    assert.equal(dialog.querySelector('.voice-reply-note').textContent, copy.voiceReplayTextOnly);
    await f.push({ type: 'final', role: 'user', turnId: 'next', text: 'Next' });
    assert.equal(dialog.open, false);
  });

  test(`AIT-138 c: ${locale} waiting controls explain Resume and replay follows pause/hold/end`, async t => {
    const f = await fixture(t, copy);
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Last reply' });
    const button = f.root.querySelector('.voice-repeat');
    await f.rail.pause(true); assert.equal(button.disabled, true); button.click(); await tick(); assert.deepEqual(f.replays, []);
    await f.rail.pause(false); assert.equal(button.disabled, false);
    await f.push({ type: 'waiting' }); assert.equal(button.disabled, true);
    for (const name of ['input', 'output']) { assert.equal(f.rail.button(name).disabled, true); assert.equal(f.rail.button(name).title, copy.voiceResumeFirst); }
    await f.rail.close(); assert.equal(button.hidden, true); button.click(); await tick(); assert.deepEqual(f.replays, []);
  });
}

test('AIT-138 c: evidenced heard prefix never offers unknown-position replay', async t => {
  const f = await fixture(t, de);
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: false, lastReplyText: 'Known reply' });
  assert.equal(f.root.querySelector('.voice-repeat').hidden, true);
});

for (const stop of ['pause', 'waiting', 'hangup', 'next-turn']) test(`AIT-138 c: a late repeat result stays fenced after ${stop}`, async t => {
  const f = await fixture(t, en);
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Late reply' });
  let resolve;
  f.rail.session.replayLastReply = () => new Promise(r => { resolve = r; });
  f.root.querySelector('.voice-repeat').click(); await tick();
  if (stop === 'pause') { await f.rail.pause(true); await f.rail.pause(false); }
  if (stop === 'waiting') await f.push({ type: 'waiting' });
  if (stop === 'hangup') await f.rail.close();
  if (stop === 'next-turn') await f.push({ type: 'final', turnId: 'next', role: 'assistant', text: 'New reply' });
  resolve({ kind: 'text', text: 'Late reply' }); await tick();
  assert.equal(f.root.querySelector('.voice-reply-dialog').open, false);
});
