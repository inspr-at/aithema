import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { motionPreference, rememberMotion, MOTION_KEY, connectionTime, ConnectionTimer, footerMode, ConversationFold } from '../src/layout.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { palette } from '../src/styles.js';
import { contrast, mix } from '../../../test/contrast.js';

test('motion defaults to the system and persists an explicit browser choice, including denied storage', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(motionPreference(storage, false), true); assert.equal(motionPreference(storage, true), false);
  rememberMotion(storage, false); assert.equal(values.get(MOTION_KEY), 'off'); assert.equal(motionPreference(storage, false), false);
  rememberMotion(storage, true); assert.equal(values.get(MOTION_KEY), 'on'); assert.equal(motionPreference(storage, true), true);
  values.set(MOTION_KEY, 'invalid'); assert.equal(motionPreference(storage, true), false);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(motionPreference(denied, true), false); assert.doesNotThrow(() => rememberMotion(denied, true));
});

test('connection time crosses minute and hour boundaries, pads fields and uses elapsed wall time', () => {
  for (const [ms, expected] of [[0, '0:00'], [999, '0:00'], [1000, '0:01'], [59_999, '0:59'], [60_000, '1:00'],
    [3_599_999, '59:59'], [3_600_000, '1:00:00'], [36_661_000, '10:11:01'], [-1, '0:00'], [NaN, '0:00']]) assert.equal(connectionTime(ms), expected);
  const element = { textContent: '' }; let now = 1000;
  const timer = new ConnectionTimer(element, () => now);
  timer.setConnected(true); assert.equal(element.textContent, '0:00');
  now += 3_601_000; timer.setConnected(true); timer.paint(); assert.equal(element.textContent, '1:00:01', 'renders do not reset a live connection');
  timer.setConnected(false); assert.equal(element.textContent, '0:00');
  now += 1000; timer.setConnected(true); timer.paint(); assert.equal(element.textContent, '0:00', 'a reconnect starts a new interval'); timer.destroy();
});

test('footer narrowing reserves the 1024 credit gap with 1100/680 boundaries', () => {
  assert.deepEqual(footerMode(1440), { voice: true, identity: true, limit: true, connected: true, unit: true });
  assert.equal(footerMode(1100).voice, true); assert.equal(footerMode(1099).voice, false); assert.equal(footerMode(1024).voice, false);
  assert.deepEqual(footerMode(768), { voice: false, identity: true, limit: true, connected: true, unit: true });
  assert.equal(footerMode(680).identity, true); assert.equal(footerMode(679).identity, false);
  for (const width of [700, 701]) assert.deepEqual(footerMode(width), { voice: false, identity: true, limit: true, connected: true, unit: true });
  for (const width of [680, 699]) assert.deepEqual(footerMode(width), { voice: false, identity: true, limit: false, connected: false, unit: true });
  assert.deepEqual(footerMode(600), { voice: false, identity: false, limit: false, connected: false, unit: true });
  for (const width of [599, 390, 360]) assert.deepEqual(footerMode(width), { voice: false, identity: false, limit: false, connected: false, unit: true });
  for (const width of [359, 320]) assert.deepEqual(footerMode(width), { voice: false, identity: false, limit: false, connected: false, unit: false });
});

test('fold hides the whole middle, updates its two-line message and restores both scroll positions through incoming content', async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  const root = window.document.createElement('div');
  root.innerHTML = '<div class="workspace"><div class="conversation"><div class="transcript-shell"></div></div><aside class="understanding"><div class="analysis-content"></div></aside><button class="fold"></button><section class="fold-view" hidden><button class="fold-strip"><span class="fold-text"></span><span class="fold-who"></span><span class="fold-question" hidden></span></button><div class="canvas-empty"><span></span></div></section></div>';
  const changes = [], fold = new ConversationFold({ root, copy: de, onChange: on => changes.push(on) });
  const transcript = root.querySelector('.transcript-shell'), pane = root.querySelector('.analysis-content');
  transcript.scrollTop = 143; pane.scrollTop = 279;
  root.querySelector('.fold').click();
  assert.equal(fold.folded, true); assert.equal(root.querySelector('.fold').getAttribute('aria-expanded'), 'false');
  for (const selector of ['.conversation', '.understanding']) assert.equal(root.querySelector(selector).hidden, true);
  assert.equal(root.querySelector('.fold-view').hidden, false);
  fold.update({ transcript: [{ role: 'assistant', content: 'Old', erased: true }, { role: 'user', content: 'Latest' }], openQuestion: {} });
  assert.equal(root.querySelector('.fold-text').textContent, 'Latest'); assert.equal(root.querySelector('.fold-who').textContent, 'Sie');
  assert.equal(root.querySelector('.fold-question').hidden, false);
  transcript.scrollTop = 0; pane.scrollTop = 0;
  fold.setCopy(en); root.querySelector('.fold-strip').click();
  assert.equal(fold.folded, false); assert.equal(root.querySelector('.fold').title, en.layout.fold);
  assert.equal(transcript.scrollTop, 143); assert.equal(pane.scrollTop, 279); assert.deepEqual(changes, [true, false]);
  fold.update({ transcript: [], openQuestion: null }); assert.equal(root.querySelector('.fold-question').hidden, true);
});

test('round-2 band, strip and footer text tokens retain 4.5:1 contrast in both themes', () => {
  for (const [theme, tokens] of Object.entries(palette)) {
    const backgrounds = [tokens.paper, tokens.surface, mix(tokens.accent, tokens.paper, .07), mix(tokens.surface, tokens.paper, .75)];
    for (const token of ['ink', 'muted', 'accent', 'warning', 'error']) for (const background of backgrounds)
      assert.ok(contrast(tokens[token], background) >= 4.5, `${theme}: ${token} on ${background}`);
    assert.ok(contrast(tokens.paper, tokens.ink) >= 4.5, `${theme}: popup text`);
  }
});


test('AIT-188 L2c: composer ellipsis stays attached to the preceding word in DE/EN', () => {
  for (const copy of [de, en]) assert.match(copy.placeholder, /\u00a0…$/u);
});
