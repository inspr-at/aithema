import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { motionPreference, rememberMotion, MOTION_KEY, connectionTime, ConnectionTimer, footerMode, fitFooter, PhoneComposerViewport, ConversationFold } from '../src/layout.js';
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

test('footer narrowing reserves the 1024 credit gap and keeps product identity down to 600px', () => {
  assert.deepEqual(footerMode(1440), { voice: true, identity: true, limit: true, connected: true, unit: true });
  assert.equal(footerMode(1100).voice, true); assert.equal(footerMode(1099).voice, false); assert.equal(footerMode(1024).voice, false);
  assert.deepEqual(footerMode(768), { voice: false, identity: true, limit: true, connected: true, unit: true });
  assert.equal(footerMode(600).identity, true); assert.equal(footerMode(599).identity, false);
  for (const width of [700, 701]) assert.deepEqual(footerMode(width), { voice: false, identity: true, limit: true, connected: true, unit: true });
  for (const width of [600, 680, 699]) assert.deepEqual(footerMode(width), { voice: false, identity: true, limit: false, connected: false, unit: true });
  for (const width of [599, 390, 360]) assert.deepEqual(footerMode(width), { voice: false, identity: false, limit: false, connected: false, unit: true });
  for (const width of [359, 320]) assert.deepEqual(footerMode(width), { voice: false, identity: false, limit: false, connected: false, unit: false });
});

test('AIT-294: measured footer drops AI copy, then timer, then role and restores them when space returns', () => {
  let available = 1000;
  const measured = [], widths = { full: 1000, identity: 800, timer: 700, role: 500 };
  const footer = { dataset: {}, querySelector: () => ({
    children: [{ hidden:false, getClientRects: () => [1], getBoundingClientRect: () => {
      measured.push(footer.dataset.fit); return { left:0, right:widths[footer.dataset.fit] };
    } }], getBoundingClientRect: () => ({ left:0, right:available }),
    get clientWidth() { return available; },
    get scrollWidth() { return widths[footer.dataset.fit]; },
  }) };
  for (const [width, mode, attempts] of [[1000, 'full', ['full']], [999, 'identity', ['full', 'identity']],
    [799, 'timer', ['full', 'identity', 'timer']], [699, 'role', ['full', 'identity', 'timer', 'role']],
    [1000, 'full', ['full']]]) {
    available = width; measured.length = 0;
    assert.equal(fitFooter(footer), mode); assert.deepEqual(measured, attempts);
  }
});

test('AIT-294: footer collisions yield the timer even when scrollWidth fits', () => {
  const footer = { dataset: {}, querySelector: () => row };
  const zone = (left, right) => ({ hidden:false, clientWidth:100, scrollWidth:100,
    getClientRects: () => [1], getBoundingClientRect: () => ({ left, right }) });
  const row = { clientWidth:600, scrollWidth:600, getBoundingClientRect: () => ({ left:0, right:600 }),
    get children() { return [zone(0, 100), zone(200, 350), zone(footer.dataset.fit === 'timer' ? 374 : 330, 600)]; } };
  assert.equal(fitFooter(footer), 'timer');
});

test('AIT-294: an open absolute popover does not consume footer space', () => {
  const zone = { hidden:false, clientWidth:100, scrollWidth:372, getClientRects: () => [1],
    getBoundingClientRect: () => ({ left:0, right:100 }) };
  const row = { children:[zone], clientWidth:600, scrollWidth:900,
    getBoundingClientRect: () => ({ left:0, right:600 }) };
  const footer = { dataset:{}, querySelector: () => row };
  assert.equal(fitFooter(footer), 'full');
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


test('AIT-298: same-width footer text mutations keep the fit cache; changed zone width refits', async t => {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  const root = window.document.createElement('div');
  root.innerHTML = `<div class="workspace"><div class="band"></div><div class="concept-bar"><div class="voice-notices"></div></div>
    <div class="transcript-shell"><ol></ol></div><div class="composer-dock"></div>
    <footer class="display-foot"><div class="display-foot__row"><span>0:01</span><span>Connected</span></div></footer></div>`;
  const footer = root.querySelector('footer'), zone = footer.querySelector('span');
  let width = 40;
  zone.getBoundingClientRect = () => ({ width, left: 0, right: width });
  zone.getClientRects = () => [zone.getBoundingClientRect()];
  const viewport = new PhoneComposerViewport(root);
  t.after(() => viewport.destroy());
  const changes = [], observer = new window.MutationObserver(records => changes.push(...records));
  observer.observe(footer, { attributes: true, attributeFilter: ['data-fit'] });
  t.after(() => observer.disconnect());
  zone.textContent = '0:02';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes.length, 0, 'a timer tick with the same geometry does not refit');
  width = 80; zone.textContent = 'Longer text';
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(changes.length > 0, 'text that changes a zone width must refit');
});

for (const label of ['ai-notice__label', 'connection-timer', 'actor-role']) test(`AIT-299: compact footer restores full fit after hidden ${label} text shrinks`, async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  const root = window.document.createElement('div');
  root.innerHTML = `<div class="workspace"><div class="band"></div><div class="concept-bar"><div class="voice-notices"></div></div>
    <div class="transcript-shell"><ol></ol></div><div class="composer-dock"></div>
    <footer class="display-foot"><div class="display-foot__row"><div class="footer-left"><span class="${label}">A very long label</span></div></div></footer></div>`;
  const footer = root.querySelector('footer'), text = footer.querySelector('span');
  // Model actual full/compact layout: the hidden label no longer contributes
  // to its visible zone, but its natural width still changes.
  t.mock.method(window.HTMLElement.prototype, 'getBoundingClientRect', function () {
    const owner = this.closest('footer'), long = owner?.querySelector('span').textContent.length > 5;
    const width = this.matches('.display-foot__row') ? 100 : this.matches('.footer-left') ? owner.dataset.fit === 'full' ? long ? 200 : 80 : 40 : 0;
    return { width, left: 0, right: width };
  });
  t.mock.method(window.HTMLElement.prototype, 'getClientRects', function () { return [this.getBoundingClientRect()]; });
  const viewport = new PhoneComposerViewport(root); t.after(() => viewport.destroy());
  assert.equal(footer.dataset.fit, 'identity');
  const compactChanges = [], compactObserver = new window.MutationObserver(records => compactChanges.push(...records));
  compactObserver.observe(footer, { attributes: true, attributeFilter: ['data-fit'] });
  text.textContent = 'An equally long text';
  await new Promise(resolve => setImmediate(resolve));
  compactObserver.disconnect();
  assert.equal(compactChanges.length, 0, 'equal hidden natural width does not refit compact controls');
  text.textContent = 'Short';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(footer.dataset.fit, 'full', 'the shorter hidden label makes the full form fit again');
  const changes = [], observer = new window.MutationObserver(records => changes.push(...records));
  observer.observe(footer, { attributes: true, attributeFilter: ['data-fit'] }); t.after(() => observer.disconnect());
  text.textContent = 'Other';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes.length, 0, 'equal natural geometry does not refit');
});

test('AIT-299: a footer refit reads shadow focus only when its host owns document focus', async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  const root = window.document.createElement('div');
  root.innerHTML = `<div class="workspace"><div class="band"></div><div class="concept-bar"><div class="voice-notices"></div></div>
    <div class="transcript-shell"><ol></ol></div><div class="composer-dock"></div>
    <footer class="display-foot"><div class="display-foot__row"><span>Connected</span></div></footer></div>`;
  Object.defineProperty(root, 'activeElement', { get() { throw new Error('Another shadow root owns focus'); } });
  const viewport = new PhoneComposerViewport(root); t.after(() => viewport.destroy());
  root.querySelector('footer span').textContent = 'Still connected';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(viewport.connected, true);
});
