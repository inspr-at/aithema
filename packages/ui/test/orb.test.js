import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createOrb } from '../src/orb.js';

function fixture(t, motion = true, reduced = false) {
  const window = new Window(), listeners = new Set();
  const media = { matches: reduced, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  window.matchMedia = () => media;
  const orb = createOrb(window.document, { motion }); window.document.body.append(orb.element); orb.mount();
  t.after(async () => { orb.destroy(); await window.happyDOM.close(); });
  return { window, orb, media, change(value) { media.matches = value; for (const listener of listeners) listener(); }, listeners };
}

test('AIT-140: glass has five edges and a front, the inline aperture, diamond and one warm light', t => {
  const { orb } = fixture(t), root = orb.element, slabs = [...root.querySelectorAll('.orb__slab')];
  assert.deepEqual(slabs.map(layer => layer.style.transform), ['translateZ(-2.4px)', 'translateZ(-1.4px)', 'translateZ(-0.4px)', 'translateZ(0.6px)', 'translateZ(1.6px)', 'translateZ(2.4px)']);
  assert.equal(root.querySelectorAll('.orb__slab--front').length, 1);
  for (const layer of slabs) { assert.equal(layer.querySelectorAll('svg:first-child path[fill-rule="evenodd"]').length, 2); assert.ok(layer.querySelector('path[d^="m627 500"]')); }
  assert.equal(root.querySelectorAll('.orb__light').length, 1); assert.equal(root.querySelector('canvas'), null);
  assert.equal(root.querySelector('[href],[src]'), null, 'no hot-linked logo');
});

test('AIT-140: every orb has independent gradient IDs', t => {
  const { window, orb } = fixture(t), other = createOrb(window.document); t.after(() => other.destroy());
  const ids = [...orb.element.querySelectorAll('[id]'), ...other.element.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('AIT-140: voice states and measured energy keep the existing contract', t => {
  const { orb } = fixture(t);
  for (const state of ['idle', 'listening', 'speaking', 'paused', 'recovering', 'ended']) { orb.setVoice(state); assert.equal(orb.element.dataset.voice, state); }
  for (const [value, result] of [[-.1, '0'], [.6, '0.6'], [2, '1'], [NaN, '0']]) { orb.setEnergy(value); assert.equal(orb.element.style.getPropertyValue('--orb-energy'), result); assert.equal(orb.element.hasAttribute('data-measured'), true); }
  orb.setEnergy(.4, false); assert.equal(orb.element.hasAttribute('data-measured'), false);
});

test('AIT-140: motion can change while speaking without changing the voice state', t => {
  const { orb } = fixture(t); orb.setVoice('speaking'); orb.setEnergy(.9);
  orb.setMotion(false); assert.equal(orb.element.dataset.orbMotion, 'off');
  orb.setMotion(true); assert.equal(orb.element.dataset.orbMotion, 'on'); assert.equal(orb.element.dataset.voice, 'speaking');
});

test('AIT-140: system reduced motion is honoured initially and on change, including setMotion(true)', t => {
  const { orb, change } = fixture(t, true, true);
  assert.equal(orb.element.dataset.orbMotion, 'off'); orb.setMotion(true); assert.equal(orb.element.dataset.orbMotion, 'off');
  change(false); assert.equal(orb.element.dataset.orbMotion, 'on');
  orb.setMotion(false); change(true); change(false); assert.equal(orb.element.dataset.orbMotion, 'off');
});

test('AIT-140: hidden tabs pause the orb and mounting after destroy reconnects its listeners', t => {
  const { window, orb, listeners } = fixture(t); let hidden = true;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  window.document.dispatchEvent(new window.Event('visibilitychange')); assert.equal(orb.element.hasAttribute('data-orb-paused'), true);
  hidden = false; window.document.dispatchEvent(new window.Event('visibilitychange')); assert.equal(orb.element.hasAttribute('data-orb-paused'), false);
  orb.destroy(); assert.equal(listeners.size, 0); assert.equal(orb.element.hasAttribute('data-orb-paused'), true);
  orb.mount(); assert.equal(listeners.size, 1); assert.equal(orb.element.hasAttribute('data-orb-paused'), false);
});

test('AIT-140: the internal reveal event colours the face and resets it on exit', t => {
  const { window, orb } = fixture(t, false);
  orb.element.dispatchEvent(new window.CustomEvent('aithema-orb-reveal', { detail: true }));
  assert.equal(orb.element.hasAttribute('data-orb-reveal'), true); assert.equal(orb.element.querySelector('.orb__prism').style.transform, 'rotateX(0deg) rotateY(0deg)');
  orb.element.dispatchEvent(new window.CustomEvent('aithema-orb-reveal', { detail: false })); assert.equal(orb.element.hasAttribute('data-orb-reveal'), false);
});
