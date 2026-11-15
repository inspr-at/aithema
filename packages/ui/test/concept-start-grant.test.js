import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';

const window = new Window({ url: 'https://example.test/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'sessionStorage']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(() => window.happyDOM.close());

test('AIT-509: a host grants features.images with Start; no idle line or later concept ask appears', async t => {
  const blocked = { available: false, reason: 'current processing consent required' }, allowed = { available: true };
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  session.settings.origin = 'chosen'; session.visualsBound = true; session.conceptCost = { maxMicro: 0 };
  session.featureMatrix = { best: { text: blocked, analysis: blocked, images: blocked } };
  let granted = false;
  const events = [], requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (url.endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision,
      selected: granted ? ['reasoning', 'images'] : [], features: { text: ['reasoning'], analysis: ['reasoning'], images: ['images'] } });
    const snapshot = c.session;
    if (granted) snapshot.featureMatrix.best = { text: allowed, analysis: allowed, images: allowed };
    return Response.json(snapshot);
  });
  c.configure({ session, copy: en }); document.body.append(c);
  t.after(() => { c.remove(); sessionStorage.clear(); });
  c.addEventListener('aithema-consent', event => {
    events.push(event.detail);
    if (event.detail.intent !== 'start') return;
    // One host decision covers every requested purpose, including images.
    assert.ok(event.detail.features.includes('images'));
    granted = true;
    c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: {
      granted: true, changed: ['text', 'analysis', 'images'], removed: [] } });
  });
  assert.equal(c.shadowRoot.querySelector('.concept-activity-text .consent-action'), null);
  c.shadowRoot.querySelector('.ready__start').click();
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(c.shadowRoot.querySelector('.intro').hidden, true, 'the combined covering grant resumes Start');
  assert.equal(c.session.featureMatrix.best.images.available, true);
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'wish', role: 'user', content: 'Please show a visual concept.' } });
  c.receive({ seq: c.session.seq + 1, type: 'concept.state', data: { intent: c.session.conceptIntent, status: { phase: 'waiting' } } });
  assert.equal(c.shadowRoot.querySelector('.concept-activity-text .consent-action'), null);
  assert.deepEqual(events.map(event => event.intent), ['start']);
  assert.equal(requests.filter(request => request.options.body).length, 0, 'the host decision does not manufacture a generation request');
});
