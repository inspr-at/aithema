import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { voiceEvents } from '../../core/src/live-voice.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, copy, { bubble = true } = {}) {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const events = voiceEvents(), replays = [];
  const session = { callId: 'call', providerSessionId: 'provider', events,
    async setInput() {}, async setOutput() {}, async updateContext() {},
    async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async replayLastReply() { replays.push('last'); return { kind: 'text', text: 'Exact last reply.\nWith paragraphs.' }; },
    async close() { events.end(); return { closureConfirmed: true }; } };
  const rail = new AudioRail({ root, copy, client: { async start() { return session; } }, feature: () => ({ available: true }), context: () => ({}), replyVisible: text => bubble && Boolean(text) });
  t.after(async () => { await rail.close(); rail.destroy(); await window.happyDOM.close(); });
  await rail.start();
  const push = async event => { events.push({ callId: 'call', ...event }); await tick(); };
  const recover = recovery => push({ type: 'recovered', recovery });
  return { root, rail, push, recover, replays };
}

for (const [locale, copy, wording] of [
  ['de', de, { notice: 'Letzte Antwort vielleicht nicht ganz zu hören', button: 'Antwort wiederholen', title: 'Letzte Antwort',
    note: 'Der vollständige Text der letzten Antwort, Wort für Wort.', close: 'Schließen', tooltip: 'Erst fortsetzen' }],
  ['en', en, { notice: 'Last reply may not have played in full', button: 'Replay reply', title: 'Last reply',
    note: 'The full text of the last reply, word for word.', close: 'Close', tooltip: 'Resume first' }],
]) {
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

  test(`AIT-138 c: ${locale} Read full reply uses exact copy and the last reply's text`, async t => {
    const f = await fixture(t, copy);
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Exact last reply.\nWith paragraphs.' });
    const button = f.root.querySelector('.voice-repeat');
    assert.equal(f.root.querySelector('.voice-notice--reply span').textContent, wording.notice);
    assert.equal(button.textContent, wording.button); assert.equal(button.disabled, false);
    assert.equal(button.title, wording.button); assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
    assert.deepEqual(f.replays, [], 'recovery never automatically repeats');
    button.click(); await tick();
    assert.deepEqual(f.replays, ['last']);
    const dialog = f.root.querySelector('.voice-reply-dialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.voice-reply-text').textContent, 'Exact last reply.\nWith paragraphs.');
    assert.equal(dialog.querySelector('#voice-reply-title').textContent, wording.title);
    assert.equal(dialog.querySelector('.voice-reply-note').textContent, wording.note);
    assert.equal(dialog.querySelector('.voice-reply-close').textContent, wording.close);
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
    for (const name of ['input', 'output']) { assert.equal(f.rail.button(name).disabled, true); assert.equal(f.rail.button(name).title, wording.tooltip); }
    await f.rail.close(); assert.equal(button.hidden, true); button.click(); await tick(); assert.deepEqual(f.replays, []);
  });
}

test('AIT-138 c: evidenced heard prefix never offers unknown-position replay', async t => {
  const f = await fixture(t, de);
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: false, lastReplyText: 'Known reply' });
  assert.equal(f.root.querySelector('.voice-repeat').hidden, true);
});

for (const [locale, copy] of [['de', de], ['en', en]]) {
  for (const [name, selector, expected] of [
    ['notice', '.voice-notice--reply span', ''],
    ['announcement', '.voice-notice-live', copy.voiceRecovered],
  ]) test(`AIT-138 c fix1: ${locale} incomplete ${name} requires an unknown playback position`, async t => {
    const f = await fixture(t, copy);
    for (const playbackPositionUnknown of [false, undefined]) {
      await f.recover({ deliveryUncertain: true, playbackPositionUnknown, lastReplyText: 'Known reply' });
      assert.equal(f.root.querySelector(selector).textContent, expected);
      assert.equal(f.root.querySelector('.voice-repeat').hidden, true);
    }
  });
}

test('AIT-138 c: unknown playback without a complete reply keeps the button visibly disabled', async t => {
  const f = await fixture(t, de);
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: null });
  const button = f.root.querySelector('.voice-repeat');
  assert.equal(button.hidden, false); assert.equal(button.disabled, true); assert.equal(button.title, de.voiceReplyUnavailable);
  button.click(); await tick(); assert.deepEqual(f.replays, []);
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

for (const [locale, copy, labels] of [
  ['de', de, ['Antwort wiederholen', 'Wiederholung stoppen', 'Ganze Antwort lesen', 'Text lesen']],
  ['en', en, ['Replay reply', 'Stop replay', 'Read full reply', 'Read text']],
]) {
  test(`AIT-154 round 2: ${locale} replay label switches to Stop and back in the same button`, async t => {
    const f = await fixture(t, copy);
    f.rail.session.replayLastReply = async () => ({ kind: 'audio' });
    f.rail.session.stopReplay = async () => {};
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply' });
    const button = f.root.querySelector('.voice-repeat');
    assert.equal(button.textContent, labels[0]);
    button.click(); await tick(); assert.equal(button.textContent, labels[1]);
    assert.equal(button, f.root.querySelector('.voice-repeat'));
    button.click(); await tick(); assert.equal(button.textContent, labels[0]);
  });
  test(`AIT-154 round 2: ${locale} unavailable audio changes to the full-text fallback`, async t => {
    const f = await fixture(t, copy);
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Exact last reply.\nWith paragraphs.' });
    f.root.querySelector('.voice-repeat').click(); await tick();
    assert.equal(f.root.querySelector('.voice-repeat').textContent, labels[2]);
  });
  test(`AIT-154 round 2: ${locale} Read text opens the approved dialog without synthesis`, async t => {
    const f = await fixture(t, copy);
    await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply' });
    const link = f.root.querySelector('.voice-read-text'); assert.ok(link); assert.equal(link.textContent, labels[3]);
    link.click(); await tick(); assert.equal(f.rail.notices.dialog.open, true);
    assert.equal(f.root.querySelector('.voice-reply-text').textContent, 'Reply'); assert.deepEqual(f.replays, []);
  });
}
test('AIT-154 round 2: acknowledged recovery without its assistant bubble hides replay and text actions', async t => {
  const f = await fixture(t, en, { bubble: false });
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Acknowledged but missing' });
  assert.equal(f.root.querySelector('.voice-repeat').hidden, true);
  assert.equal(f.root.querySelector('.voice-read-text').hidden, true);
  f.root.querySelector('.voice-repeat').click(); await tick(); assert.deepEqual(f.replays, []);
});

for (const locale of ['de', 'en']) test(`AIT-154 round 2: ${locale} no audio credit keeps both text actions usable`, async t => {
  const copy = { de, en }[locale], f = await fixture(t, copy);
  f.rail.usedUp = () => true;
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply' });
  const button = f.root.querySelector('.voice-repeat');
  assert.equal(button.textContent, copy.voiceReadFullReply); assert.equal(button.disabled, false);
  button.click(); await tick(); assert.equal(f.rail.notices.dialog.open, true); assert.deepEqual(f.replays, []);
});

test('AIT-154 round 2: Stop stays usable during synthesis and fences a late result', async t => {
  const f = await fixture(t, en), pending = Promise.withResolvers(); let stops = 0;
  f.rail.session.replayLastReply = () => pending.promise;
  f.rail.session.stopReplay = async () => { stops++; };
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply' });
  const button = f.root.querySelector('.voice-repeat'); button.click(); await tick();
  assert.equal(button.textContent, en.voiceReplayStop); assert.equal(button.disabled, false);
  button.click(); await tick(); assert.equal(stops, 1); assert.equal(button.textContent, en.voiceRepeatReply);
  pending.resolve({ kind: 'audio' }); await tick(); assert.equal(f.rail.notices.playing, false);
});

test('AIT-154 round 2: a newly denied wallet falls back to full text with no error dialog', async t => {
  const f = await fixture(t, en);
  f.rail.session.replayLastReply = async () => { throw Object.assign(new Error(), { code: 'not-admitted', reason: 'host-limit' }); };
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply' });
  f.root.querySelector('.voice-repeat').click(); await tick();
  assert.equal(f.root.querySelector('.voice-repeat').textContent, en.voiceReadFullReply);
  assert.equal(f.rail.notices.dialog.open, true); assert.equal(f.root.querySelector('.voice-reply-text').textContent, 'Reply');
});

for (const [locale, copy] of [['de', de], ['en', en]]) test(`AIT-190: ${locale} cleared recovery actions belong to the exact last reply and retire only after playback`, async t => {
  const { RecoveryNotices } = await import('../src/recovery-notices.js');
  const window = new Window(), host = window.document.createElement('div');
  window.document.body.append(host);
  host.innerHTML = '<div class="turn"><span class="turn-text"></span></div><div class="voice-notices"></div>';
  t.after(() => window.happyDOM.close());
  const bubble = host.querySelector('.turn'), root = host.querySelector('.voice-notices');
  const reply = { turnId: 'last', text: 'Exact reply' };
  bubble.querySelector('span').textContent = reply.text;
  let visible = true;
  const notices = new RecoveryNotices({ root, copy, available: () => true, replay: async () => ({ kind: 'audio' }),
    replyVisible: () => visible, replyTarget: (text, id) => visible && text === reply.text && id === reply.turnId ? bubble : null });
  notices.pageReply = reply;
  notices.recovered({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: reply.text, lastReplyTurnId: reply.turnId });
  const actions = host.querySelector('.voice-reply-actions'), button = notices.button;
  assert.equal(actions.parentElement === root.querySelector('.voice-notice--reply'), true, 'sentence owns actions while present');
  notices.clear();
  assert.equal(actions.parentElement === bubble, true, 'cleared sentence attaches the same controls directly to its bubble');
  assert.equal(bubble.lastElementChild === actions, true);
  assert.equal(button.hidden, false);
  notices.playing = true;
  notices.playbackEnded(false);
  assert.equal(button.hidden, false, 'Stop/hold does not count as played through');
  visible = false;
  notices.playbackEnded(true);
  assert.equal(button.hidden, true, 'a missing exact bubble cannot keep actions');
  visible = true; notices.render();
  assert.equal(button.hidden, true, 'fully visible plus completed playback retires the row');
  notices.clear(); notices.render();
  assert.equal(button.hidden, true, 'ordinary repaint/clear cannot resurrect a completed reply');
  notices.pageReply = { turnId: 'next', text: reply.text }; notices.render();
  assert.equal(button.hidden, false, 'completion is scoped to turn identity, not identical text');
});

for (const completed of [false, true]) test(`AIT-190: in-call replay completion=${completed} preserves interruption controls and retires played-through replies`, async t => {
  const f = await fixture(t, en);
  await f.recover({ deliveryUncertain: true, playbackPositionUnknown: true, lastReplyText: 'Reply', lastReplyTurnId: 'last' });
  await f.push({ type: 'speaking', replay: true });
  await f.push({ type: 'listening', replay: true, completed });
  assert.equal(f.rail.notices.button.hidden, completed);
  assert.equal(f.rail.notices.readText.hidden, completed);
  f.rail.render();
  assert.equal(f.rail.notices.button.hidden, completed, 'render preserves the completion verdict');
});
