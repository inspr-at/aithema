import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import './fixtures/page-origin.js';
import { OverviewStatusSize } from '../src/overview-status-size.js';
import { overviewStatusCatalog, overviewStatusCandidates, overviewStatusText } from '../src/overview-status-copy.js';
import { reasonText } from '../src/settings-dialog.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

// Deterministic layout oracle: candidate text contributes its natural height;
// the production measurer still builds the real consent and Retry DOM.
function harness(copy) {
  const window = new Window();
  globalThis.document = window.document;
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
  let frame;
  const flush = () => { const callback = frame; frame = null; callback?.(); };
  size.view = { removeEventListener() {}, requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; }, getComputedStyle: () => ({ display: 'flex', fontFamily: 'test', fontSize: '13px', lineHeight: '18px', columnGap: '8px' }) };
  size.connected = true;
  return { size, slot, text, pane, measured, copy, flush };
}

for (const shipped of [en, de]) test(`AIT-547 ${shipped.display.locale}: reserve includes every resolved availability reason and host override`, () => {
  const copy = structuredClone(shipped);
  copy.reasons['host-specific'] = 'A host supplied availability reason';
  copy.reasons['document text not covered by reasoning scope'] = 'A host supplied document processing explanation '.repeat(4);
  const h = harness(copy);
  h.size.render(copy, copy.display.locale); h.flush();
  for (const reason of Object.keys(copy.reasons)) {
    if (reason === 'delegated' || reason === 'current processing consent required') continue;
    assert.ok(h.measured.includes(reasonText(copy, reason, 'analysis')), `missing candidate: ${reason}`);
  }
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= copy.reasons['document text not covered by reasoning scope'].length);
});

test('AIT-547: unexpected rendered copy grows the reserve without changing the candidate signature', () => {
  const h = harness(en);
  h.size.render(en, 'en'); h.flush();
  const before = parseFloat(h.pane.style.getPropertyValue('--overview-status-height'));
  h.text.textContent = 'An unforeseen provider explanation '.repeat(20);
  h.size.render(en, 'en'); h.flush();
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= h.text.textContent.length, 'runtime guard fits all rendered text');
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) > before);
  h.text.textContent = 'Current'; h.size.render(en, 'en'); h.flush();
  assert.ok(parseFloat(h.pane.style.getPropertyValue('--overview-status-height')) >= 'An unforeseen provider explanation '.repeat(20).length, 'state changes cannot shrink the reserve');
});

for (const copy of [en, de]) test(`AIT-547 ${copy.display.locale}: every render path is generated into the candidate catalog`, () => {
  const locale = copy.display.locale, candidates = overviewStatusCandidates(copy, locale);
  const base = { hasPersonTurn: true, readinessAssessed: true, analysis: { available: true } };
  const paths = [
    { hasPersonTurn: false }, { updatingOverview: true }, { preparing: true },
    { failedOverview: true }, { failedOverview: true, replyFailed: true }, { failure: true },
    { analysis: { available: false, reason: 'An arbitrary resolved reason' } },
    { readinessAssessed: false, replyFailed: true, missingReply: true },
    { readinessAssessed: false }, { stale: true }, { draft: true }, {},
  ];
  const visited = new Set();
  for (const fields of paths) {
    const context = { ...base, ...fields }, state = overviewStatusCatalog.find(state => state.when(context));
    visited.add(state.id);
    const variants = state.variants(copy, locale);
    assert.ok(variants.length > 0, `${state.id} has candidates`);
    for (const variant of variants) assert.ok(candidates.some(candidate => candidate.state === state.id && candidate.text === variant.text && candidate.retry === variant.retry), `${state.id} variant included`);
    if (!state.render) assert.ok(candidates.some(candidate => candidate.text === overviewStatusText(copy, locale, context)), `${state.id} rendered text included`);
  }
  assert.deepEqual([...visited].sort(), overviewStatusCatalog.map(state => state.id).sort(), 'every render path is exercised');
  for (const rawReason of Object.keys(copy.reasons).filter(reason => reason !== 'delegated')) {
    for (const reason of [rawReason, `delegated reasoning: ${rawReason}`]) {
      const resolved = reasonText(copy, reason, 'analysis');
      assert.ok(candidates.some(candidate => candidate.rawReason === reason && candidate.text === resolved), `${reason} resolved candidate`);
    }
  }
});

test('AIT-547: catalog writes precede reads in an isolated holder and triggers coalesce per frame', () => {
  const h = harness(en), clone = h.slot.cloneNode.bind(h.slot);
  const candidates = overviewStatusCandidates(en, 'en');
  let reads = 0;
  h.slot.cloneNode = (...args) => {
    const probe = clone(...args), bounds = probe.getBoundingClientRect.bind(probe);
    probe.getBoundingClientRect = () => {
      reads++;
      const holder = probe.parentElement;
      assert.equal(holder.children.length, candidates.length, 'every candidate is built before the first read');
      assert.equal(holder.parentElement.className, 'analysis-stack', 'holder is outside the reading grid');
      assert.equal(holder.style.position, 'absolute');
      assert.equal(holder.style.contain, 'strict');
      assert.equal(holder.style.width, '297px');
      assert.equal(holder.style.height, '0px');
      assert.equal(holder.style.visibility, 'hidden');
      assert.equal(holder.style.pointerEvents, 'none');
      assert.equal(holder.getAttribute('aria-hidden'), 'true');
      return bounds();
    };
    return probe;
  };
  h.size.render(en, 'en');
  for (let i = 0; i < 10; i++) { h.size.refresh(); h.size.fontsChanged(); }
  assert.equal(reads, 0, 'triggers wait for their shared frame');
  h.flush();
  assert.equal(reads, candidates.length, 'one full measurement per frame');
  assert.equal(h.pane.parentElement.children.length, 1, 'holder removed after all reads');
  h.size.fontsChanged(); h.size.disconnect(); h.flush();
  assert.equal(reads, candidates.length, 'disconnect cancels pending measurement');
});

// AIT-587 (AIT-547 gate3 L1): ResizeObserver delivers after layout and before paint. A width change of the
// size-contained stack is measured in that delivery, not one animation frame later with the old reserve painted.
test('AIT-587: a stack width change applies its reserve in the same ResizeObserver delivery', () => {
  const h = harness(en), stack = h.pane.parentElement;
  let width = 297, observed;
  h.slot.getBoundingClientRect = () => ({ width, height: 20, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20 });
  h.size.connected = false;
  h.size.view = { ...h.size.view, addEventListener() {}, ResizeObserver: class { constructor(callback) { observed = callback; } observe() {} disconnect() {} } };
  h.size.connect(); h.size.render(en, 'en'); h.flush();
  const first = h.measured.length;
  assert.ok(first > 0, 'the first frame measures the catalog');
  width = 420;
  observed([{ target: stack, contentRect: { width: 440, height: 600 }, borderBoxSize: [{ inlineSize: 440, blockSize: 600 }] }]);
  assert.ok(h.measured.length > first, 'the width change is measured inside the delivery');
  const after = h.measured.length;
  h.flush();
  assert.equal(h.measured.length, after, 'no second measurement waits in a later frame');
  observed([{ target: h.slot, contentRect: { width: 420, height: 30 }, borderBoxSize: [{ inlineSize: 420, blockSize: 30 }] }]);
  assert.equal(h.measured.length, after, 'a slot-only change (the reserve itself) still waits for its frame');
  h.size.disconnect();
});
