import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '../../core/src/session.js';
import { en } from '../src/i18n/en.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = () => ({ ...createSession({ demo: true }), opener: { text: 'Welcome from a host.', locale: 'en' },
  settings: { ...createSession().settings, origin: 'chosen' },
  featureMatrix: { best: { text: { available: true }, analysis: { available: true } } } });
test('AIT-505: render-only opener reconciles in place without visitor input or restore', async t => {
  const c = document.createElement('aithema-session');
  c.configure({ copy: en, session: session() }); t.after(() => c.remove());
  c.shadowRoot.querySelector('.ready__start').click(); await tick();
  assert.equal(c.session.transcript.length, 0);
  const row = c.shadowRoot.querySelector('[data-id="host:opener"]');
  assert.ok(row, 'host opener is visible immediately after Start');
  assert.match(row.textContent, /Welcome from a host/u);
  assert.equal(c.shadowRoot.querySelector('.workspace').dataset.understanding, 'absent');
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: 'Welcome from a host.' } });
  assert.equal(c.shadowRoot.querySelector('[data-id="host:opener"]'), row);
  assert.equal(c.shadowRoot.querySelector('.workspace').dataset.understanding, 'absent');
});
