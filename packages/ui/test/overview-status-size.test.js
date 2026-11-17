import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { OverviewStatusSize } from '../src/overview-status-size.js';
import { reasonText } from '../src/settings-dialog.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

// Deterministic layout oracle: candidate text contributes its natural height;
// the production measurer still builds the real consent and Retry DOM.
function harness(copy) {
  const window = new Window();
  const root = window.document.createElement('div');
  root.innerHTML = '<div class="analysis-stack"><div class="analysis-content"><p class="overview-status"><span class="notice-text">Current</span></p></div></div>';
  window.document.body.append(root);
  const slot = root.querySelector('.overview-status'), text = slot.firstChild, pane = root.querySelector('.analysis-content');
  const measured = [];
  const rect = height => ({ width: 297, height, x: 0, y: 0, top: 0, left: 0, right: 297, bottom: height });
  slot.getBoundingClientRect = () => rect(parseFloat(pane.style.getPropertyValue('--overview-status-height')) || 20);
  text.getBoundingClientRect = () => rect(text.textContent.length);
  const clone = slot.cloneNode.bind(slot);
  slot.cloneNode = (...args) => {
    const probe = clone(...args);
    probe.getBoundingClientRect = () => { measured.push(probe.textContent); return rect(probe.textContent.length); };
    return probe;
  };
  const size = new OverviewStatusSize(root);
  size.view = { getComputedStyle: () => ({ display: 'flex', fontFamily: 'test', fontSize: '13px', lineHeight: '18px', columnGap: '8px' }) };
  size.connected = true;
  return { size, slot, text, pane, measured, copy };
}

for (const shipped of [en, de]) test(`AIT-547 ${shipped.display.locale}: reserve includes every resolved availability reason and host override`, () => {
  const copy = structuredClone(shipped);
  copy.reasons['host-specific'] = 'A host supplied availability reason';
  copy.reasons['document text not covered by reasoning scope'] = 'A host supplied document processing explanation '.repeat(4);
  const h = harness(copy);
  h.size.render(copy, copy.display.locale);
  for (const reason of Object.keys(copy.reasons)) {
    if (reason === 'delegated' || reason === 'current processing consent required') continue;
    assert.ok(h.measured.includes(reasonText(copy, reason, 'analysis')), `missing candidate: ${reason}`);
  }
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= copy.reasons['document text not covered by reasoning scope'].length);
});

test('AIT-547: unexpected rendered copy grows the reserve without changing the candidate signature', () => {
  const h = harness(en);
  h.size.render(en, 'en');
  const before = parseFloat(h.pane.style.getPropertyValue('--overview-status-height'));
  h.text.textContent = 'An unforeseen provider explanation '.repeat(20);
  h.size.render(en, 'en');
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= h.text.textContent.length, 'runtime guard fits all rendered text');
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) > before);
  h.text.textContent = 'Current'; h.size.render(en, 'en');
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= 'An unforeseen provider explanation '.repeat(20).length, 'state changes cannot shrink the reserve');
});
