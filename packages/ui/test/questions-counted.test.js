import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import './fixtures/page-origin.js';
import { createSession, inputRevision } from '@inspr/aithema-core';
import * as copyTools from '../src/copy-resolve.js';
import { plural as uploadPlural } from '../src/uploads.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(async () => window.happyDOM.close());
function fixture(t, locale, count, copy = locale === 'de' ? de : en) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  session.transcript = [{ id: 'person', role: 'user', content: 'Invoice approvals' }, { id: 'assistant', role: 'assistant', content: 'Tell me more.' }];
  session.transcript[1].inputRevision = inputRevision(session);
  Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true, draft: false,
    summary: 'Invoice approvals', openQuestions: Array.from({ length: count }, (_, i) => `Open question ${i + 1}?`) });
  c.configure({ session, copy, copyForLocale: locale => locale === 'de' ? de : en });
  t.after(() => c.remove()); return c;
}
for (const locale of ['en', 'de']) for (const count of [0, 1, 3]) test(`AIT-516 counted heading ${locale}/${count} and accessible list name`, t => {
  const c = fixture(t, locale, count), root = c.shadowRoot, title = root.querySelector('#open-questions-title');
  const expected = locale === 'de' ? count === 0 ? 'Offene Fragen' : count === 1 ? '1 offene Frage' : '3 offene Fragen'
    : count === 0 ? 'Open questions' : count === 1 ? '1 open question' : '3 open questions';
  assert.equal(title.textContent, expected);
  assert.equal(title.hasAttribute('data-copy'), false);
  assert.equal(root.getElementById(root.querySelector('.questions').getAttribute('aria-labelledby')).textContent, expected);
  assert.equal(root.querySelector('.questions .none-yet') !== null, count === 0);
});
for (const locale of ['en', 'de']) for (const key of ['questions', 'questionsCounted']) test(`AIT-516 ${locale}: host string override for ${key}`, t => {
  const copy = structuredClone(locale === 'de' ? de : en); copy[key] = 'Host heading';
  const c = fixture(t, locale, 3, copy);
  assert.equal(c.shadowRoot.querySelector('#open-questions-title').textContent, 'Host heading');
});
for (const locale of ['en', 'de']) test(`AIT-516 ${locale}: old bundle falls back to shipped counted forms`, t => {
  const copy = structuredClone(locale === 'de' ? de : en); delete copy.questionsCounted;
  const c = fixture(t, locale, 1, copy);
  assert.equal(c.shadowRoot.querySelector('#open-questions-title').textContent, locale === 'de' ? '1 offene Frage' : '1 open question');
});
for (const locale of ['en', 'de']) for (const count of [1, 2]) test(`AIT-516 overflow ${locale}/${count}: singular plus legacy more override`, t => {
  const copy = structuredClone(locale === 'de' ? de : en), c = fixture(t, locale, count, copy);
  assert.equal(typeof copy.more, 'string');
  assert.equal(c.shadowRoot.querySelector('.overflow').textContent, locale === 'de'
    ? count === 1 ? '1 weiterer offener Punkt' : '2 weitere offene Punkte'
    : count === 1 ? '1 more open point' : '2 more open points');
  copy.more = '{count} host points'; c.configure({ session: c.session, copy });
  assert.equal(c.shadowRoot.querySelector('.overflow').textContent, `${count} host points`);
});
for (const locale of ['en', 'de']) test(`AIT-516 erased-view locale repaint ${locale}: zero count in active language`, async t => {
  const c = fixture(t, locale, 3);
  c.receive({ seq: c.session.seq + 1, type: 'session.erased', data: {} });
  assert.equal(c.shadowRoot.querySelector('#open-questions-title').textContent, locale === 'de' ? 'Offene Fragen' : 'Open questions');
  const next = locale === 'de' ? 'en' : 'de'; await c.changeLocale(next);
  assert.equal(c.shadowRoot.querySelector('#open-questions-title').textContent, next === 'de' ? 'Offene Fragen' : 'Open questions');
  assert.equal(c.shadowRoot.querySelectorAll('.open-question').length, 0);
});
test('AIT-516 plural is shared, supports zero forms and string overrides, and preserves upload callers', () => {
  assert.equal(typeof copyTools.plural, 'function');
  assert.equal(uploadPlural, copyTools.plural);
  for (const [count, expected] of [[0, 'No items'], [1, '1 item'], [5, '5 items']])
    assert.equal(copyTools.plural({ zero: 'No items', one: '{count} item', other: '{count} items' }, count), expected);
  assert.equal(copyTools.plural('{count} host items', 3), '3 host items');
  assert.equal(copyTools.plural({ one: '{count} upload', other: '{count} uploads' }, 0), '0 uploads');
});
for (const locale of ['en', 'de']) test(`AIT-516 ${locale}: an incomplete host form never empties the heading`, t => {
  const copy = { ...(locale === 'de' ? de : en), questionsCounted: { other: '{count} host questions' } };
  const c = fixture(t, locale, 1, copy);
  assert.equal(c.shadowRoot.querySelector('#open-questions-title').textContent, locale === 'de' ? '1 offene Frage' : '1 open question');
});
