import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createOrb } from '../src/orb.js';
import { createReveal } from '../src/reveal.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

function fixture(t, { motion = true, reduced = false, copy = en, shadow = false } = {}) {
  const window = new Window(), document = window.document, listeners = new Set();
  const media = { matches: reduced, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media; window.HTMLCanvasElement.prototype.getContext = () => null;
  let now = 0, next = 0; const timers = new Map();
  window.setTimeout = (fn, duration = 0) => { const id = ++next; timers.set(id, { fn, at: now + duration }); return id; };
  window.clearTimeout = id => timers.delete(id);
  const advance = ms => {
    const end = now + ms;
    for (;;) { const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); }
    now = end;
  };
  const host = document.createElement('div'); document.body.append(host); const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const band = document.createElement('header'), orb = createOrb(document, { motion }), controls = [];
  band.style.position = 'relative'; band.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 76 });
  orb.element.getBoundingClientRect = () => ({ left: 54, right: 94, top: 18, width: 40, height: 40 });
  band.append(orb.element);
  for (let index = 0; index < 4; index++) {
    const node = document.createElement('button'); node.textContent = `control ${index}`; node.setAttribute('data-reveal', '');
    node.getBoundingClientRect = () => ({ left: 108 + index * 200, top: 16, width: 44, height: 44 }); band.append(node); controls.push(node);
    node.getClientRects = () => [node.getBoundingClientRect()];
  }
  root.append(band); orb.mount(); const version = { product: 'Aithema 2026.10', commit: 'd886da3', date: '2026-10-12' };
  const reveal = createReveal({ band, orb, controls, links: copy.reveal.links, version, copy, motion });
  const event = (node, type, init = {}) => node.dispatchEvent(type === 'keydown' ? new window.KeyboardEvent(type, { bubbles: true, composed: true, ...init }) : new window.Event(type, init));
  const state = () => band.dataset.aithemaRevealState;
  t.after(async () => { reveal.destroy(); orb.destroy(); await window.happyDOM.close(); });
  return { window, document, band, orb, controls, reveal, root, advance, event, state, timers,
    change(value) { media.matches = value; for (const listener of listeners) listener(); } };
}

test('AIT-140: hover requires a full 350ms rest', t => {
  const f = fixture(t); f.event(f.orb.element, 'mouseenter'); f.advance(349); assert.equal(f.state(), 'closed');
  f.advance(1); assert.equal(f.state(), 'open'); assert.equal(f.orb.element.getAttribute('aria-expanded'), 'true');
  assert.ok(f.controls.every(node => node.inert));
});

for (const kind of ['hidden', 'transparent', 'no rects']) test(`AIT-131 B6: ${kind} controls get no dissolve proxy or stagger and stay untouched`, t => {
  const f = fixture(t), node = f.controls[0];
  if (kind === 'hidden') node.style.visibility = 'hidden';
  if (kind === 'transparent') node.style.opacity = '0';
  if (kind === 'no rects') node.getClientRects = () => [];
  const before = node.outerHTML;
  f.orb.element.click();
  assert.equal(node.outerHTML, before, 'skipped controls retain their own attributes and styles');
  assert.ok(![...f.band.querySelectorAll('.aithema-reveal__proxy')].some(proxy => proxy.textContent === node.textContent));
  assert.equal(f.band.querySelectorAll('.aithema-reveal__proxy').length, 3, 'visible controls still dissolve');
  f.reveal.close(); f.advance(1500); assert.equal(node.outerHTML, before);
});

test('AIT-140: a quick pass on the orb never opens the reveal', t => {
  const f = fixture(t); f.event(f.orb.element, 'mouseenter'); f.advance(200); f.event(f.orb.element, 'mouseleave'); f.advance(1000); assert.equal(f.state(), 'closed');
});

test('AIT-140: assistive activation opens without DOM focus and is removed on destroy', t => {
  const f = fixture(t); const before = f.document.activeElement;
  f.orb.element.click(); assert.equal(f.state(), 'open'); assert.equal(f.document.activeElement, before);
  assert.equal(f.orb.element.getAttribute('aria-expanded'), 'true'); assert.ok(f.controls.every(node => node.inert));
  f.reveal.destroy(); f.orb.element.click(); assert.equal(f.band.querySelector('nav'), null); assert.equal(f.timers.size, 0);
});

test('AIT-140: exit waits for the last control to finish its delayed 800ms return', t => {
  const f = fixture(t); f.orb.element.focus(); f.reveal.close();
  f.advance(1161); assert.equal(f.state(), 'exiting'); assert.ok(f.controls.every(node => node.hasAttribute('data-aithema-reveal-control')));
  f.advance(1); assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert && !node.hasAttribute('data-aithema-reveal-control')));
});

test('AIT-140: leaving the band cancels pending intent', t => {
  const f = fixture(t); f.event(f.orb.element, 'mouseenter'); f.advance(300); f.event(f.band, 'mouseleave'); f.advance(1000); assert.equal(f.state(), 'closed');
});

test('AIT-140: leaving only the orb keeps an open reveal available to its links', t => {
  const f = fixture(t); f.event(f.orb.element, 'mouseenter'); f.advance(350); f.event(f.orb.element, 'mouseleave'); f.advance(1200); assert.equal(f.state(), 'open');
  f.event(f.band, 'mouseleave'); assert.equal(f.state(), 'exiting'); f.advance(1500); assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert));
});

test('AIT-140: Esc cancels pending hover', t => {
  const f = fixture(t); f.event(f.orb.element, 'mouseenter'); f.advance(300); f.event(f.document, 'keydown', { key: 'Escape' }); f.advance(500); assert.equal(f.state(), 'closed');
});

for (const [locale, copy] of [['en', en], ['de', de]]) test(`AIT-140: focus opens immediately with real, accessible ${locale} anchors and the supplied version`, t => {
  const f = fixture(t, { copy }); f.orb.element.focus(); assert.equal(f.state(), 'open');
  const row = f.band.querySelector('nav'), links = [...row.querySelectorAll('a')];
  assert.equal(row.inert, false); assert.equal(row.getAttribute('aria-label'), copy.reveal.label);
  assert.deepEqual(links.map(link => [link.querySelector('.aithema-reveal__title').textContent, link.querySelector('.aithema-reveal__subtitle').textContent, link.href.replace(/\/$/u, '')]), copy.reveal.links.map(({ title, subtitle, href }) => [title, subtitle, href]));
  assert.deepEqual(links.map(link => link.title), copy.reveal.links.map(link => link.subtitle));
  assert.equal(row.querySelector('code').textContent, 'd886da3'); assert.ok(row.textContent.includes('Aithema 2026.10'));
  links[0].focus(); assert.equal(f.root.getRootNode().activeElement, links[0]); assert.equal(f.state(), 'open');
});

test('AIT-140: Esc returns focus to the orb, closes once, and restores all controls', t => {
  const f = fixture(t, { shadow: true }); f.orb.element.focus(); f.band.querySelector('a').focus();
  f.event(f.band.querySelector('a'), 'keydown', { key: 'Escape' }); assert.equal(f.state(), 'exiting'); assert.equal(f.root.activeElement, f.orb.element);
  f.advance(1500); assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert && !node.hasAttribute('aria-hidden') && !node.hasAttribute('data-aithema-reveal-control')));
  f.event(f.orb.element, 'keydown', { key: 'Enter' }); assert.equal(f.state(), 'open', 'the focused orb can reopen after Esc inside a shadow root');
});

test('AIT-140: keyboard focus leaving the band closes it', t => {
  const f = fixture(t); f.orb.element.focus(); const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus();
  assert.equal(f.state(), 'exiting'); f.advance(1500); assert.equal(f.state(), 'closed'); assert.equal(f.document.activeElement, outside);
});

test('AIT-140: a pointer reveal moves focus off a control before making it inert', t => {
  const f = fixture(t); f.controls[0].focus(); f.event(f.orb.element, 'mouseenter'); f.advance(350);
  assert.equal(f.state(), 'open'); assert.equal(f.document.activeElement, f.orb.element); assert.equal(f.controls[0].inert, true);
});

test('AIT-140: early exit preserves prior inert, aria-hidden, disabled and inline styles', t => {
  const f = fixture(t); f.controls[0].inert = true; f.controls[0].setAttribute('aria-hidden', 'true'); f.controls[1].disabled = true;
  f.controls[2].style.setProperty('--ar-delay', '17ms', 'important'); f.controls[3].style.opacity = '.7';
  const snapshot = () => f.controls.map(node => [node.inert, node.getAttribute('aria-hidden'), node.disabled, node.style.cssText]);
  const original = snapshot(); f.event(f.orb.element, 'mouseenter'); f.advance(350); f.reveal.close(); f.advance(1500);
  assert.deepEqual(snapshot(), original); assert.equal(f.band.querySelector('.aithema-reveal__dissolves'), null); assert.equal(f.band.querySelector('canvas'), null);
});

test('AIT-140: interrupted exit can reopen and the eventual exit restores every control', t => {
  const f = fixture(t); f.orb.element.focus(); f.reveal.close(); f.advance(300); f.event(f.orb.element, 'focus'); assert.equal(f.state(), 'open');
  f.advance(1500); assert.equal(f.state(), 'open'); f.reveal.close(); f.advance(1500); assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert));
});

test('AIT-140: motion off uses a 200ms crossfade without particles or dissolve copies', t => {
  const f = fixture(t, { motion: false }); f.orb.element.focus(); assert.equal(f.band.dataset.aithemaRevealMotion, 'off');
  assert.equal(f.band.querySelector('canvas'), null); assert.equal(f.band.querySelector('.aithema-reveal__proxy'), null);
  f.reveal.close(); f.advance(199); assert.equal(f.state(), 'exiting'); f.advance(1); assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert));
});

test('AIT-140: system reduced motion overrides an on request and follows preference changes', t => {
  const f = fixture(t, { reduced: true }); f.reveal.setMotion(true); assert.equal(f.band.dataset.aithemaRevealMotion, 'off');
  f.change(false); assert.equal(f.band.dataset.aithemaRevealMotion, 'on'); f.reveal.setMotion(false); f.change(true); f.change(false); assert.equal(f.band.dataset.aithemaRevealMotion, 'off');
});

test('AIT-140: switching motion off during exit shortens cleanup to the crossfade', t => {
  const f = fixture(t); f.orb.element.focus(); f.reveal.close(); f.advance(50); f.reveal.setMotion(false); f.advance(200);
  assert.equal(f.state(), 'closed'); assert.ok(f.controls.every(node => !node.inert));
});

test('AIT-140: hidden tabs cancel hover intent and pause decorative animations', t => {
  const f = fixture(t); let hidden = true; Object.defineProperty(f.document, 'hidden', { configurable: true, get: () => hidden });
  const animation = { playState: 'running', pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; } }; f.band.getAnimations = () => [animation];
  f.event(f.orb.element, 'mouseenter'); f.event(f.document, 'visibilitychange'); f.advance(1000); assert.equal(f.state(), 'closed'); assert.equal(animation.playState, 'paused');
  hidden = false; f.event(f.document, 'visibilitychange'); assert.equal(animation.playState, 'running'); assert.equal(f.band.hasAttribute('data-aithema-reveal-paused'), false);
});

test('AIT-140: geometry is read once before control writes, and never from a particle frame', t => {
  const f = fixture(t); let writes = false, reads = 0;
  for (const node of f.controls) { const read = node.getBoundingClientRect, write = node.setAttribute.bind(node);
    node.getBoundingClientRect = () => { assert.equal(writes, false, 'all bounds precede mutations'); reads++; return read(); };
    node.setAttribute = (...args) => { writes = true; return write(...args); };
  }
  f.orb.element.focus(); assert.equal(reads, f.controls.length);
});

test('AIT-140: destroying an open reveal restores attributes, styles and listeners', t => {
  const f = fixture(t); f.orb.element.focus(); f.reveal.destroy(); f.reveal.destroy();
  assert.equal(f.band.querySelector('nav'), null); assert.equal(f.band.querySelector('.aithema-reveal__fx'), null); assert.equal(f.band.hasAttribute('data-aithema-reveal-state'), false);
  assert.equal(f.orb.element.getAttribute('aria-hidden'), 'true'); assert.equal(f.orb.element.hasAttribute('tabindex'), false); assert.equal(f.band.style.getPropertyValue('--ar-x'), '');
  assert.ok(f.controls.every(node => !node.inert)); f.event(f.orb.element, 'mouseenter'); f.advance(1000); assert.equal(f.timers.size, 0);
});
