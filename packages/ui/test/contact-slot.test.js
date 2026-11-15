import { test, after } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '../../core/src/session.js';
import { en } from '../src/i18n/en.js';
import { firstPaintMarkupFor, firstPaintMarkup } from '../src/first-paint.js';

const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');

test('AIT-517: contact slots keep host nodes outside the scrolling analysis and overlay', () => {
  const c = document.createElement('aithema-session');
  const card = document.createElement('section'); card.slot = 'sidebar-contact';
  const button = document.createElement('button'); button.slot = 'contact-launcher';
  c.append(card, button);
  c.configure({ session: createSession({ demo: true }), copy: en });
  const root = c.shadowRoot, slot = root.querySelector('slot[name="sidebar-contact"]');
  assert.ok(slot, 'pinned contact slot exists');
  assert.equal(slot.parentElement.parentElement, root.querySelector('.understanding'));
  assert.equal(slot.closest('.analysis-stack'), null, 'email-ask overlay cannot cover the host contact');
  assert.equal(slot.closest('.analysis-content'), null, 'analysis scrolling cannot move the host contact');
  assert.ok(root.querySelector('.header-actions slot[name="contact-launcher"]'));
  assert.equal(card.parentElement, c, 'host retains light-DOM ownership');
  assert.equal(button.parentElement, c);
});

test('AIT-517: first-paint opt-in reserves one additional 44 px action at both header widths', () => {
  assert.equal(firstPaintMarkupFor(), firstPaintMarkup, 'legacy first paint is unchanged');
  const shell = document.createElement('div');
  shell.innerHTML = firstPaintMarkupFor({ contactLauncher: true });
  assert.equal(shell.querySelectorAll('.header-actions > span').length, 3);
  assert.ok(shell.querySelector('[data-contact-launcher]'), 'declaration drives shared pre-upgrade geometry');
  assert.equal(shell.firstElementChild.inert, true);
  assert.equal(shell.firstElementChild.getAttribute('aria-hidden'), 'true');
  shell.innerHTML = firstPaintMarkupFor({ voice: false, contactLauncher: true });
  assert.equal(shell.querySelector('.audio-rail'), null);
  assert.equal(shell.querySelectorAll('.header-actions > span').length, 3);
});

// Remote unit runs reserve evidence too, including when the behaviour is red.
after(async () => {
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'contact-slot-unit.json'), JSON.stringify({ file: 'packages/ui/test/contact-slot.test.js', tests: 2 }) + '\n');
});
