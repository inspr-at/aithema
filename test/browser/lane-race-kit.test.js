import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { lanePairs } from '../fixtures/lane-race-harness.js';
import { shadow, until } from './start2-display-helpers.js';

test('AIT-201 all six real lane pairs render settled states in both orders; one Retry after unbilled 400', { timeout: 90_000 }, async t => {
  const fixture = await startChild(new URL('../fixtures/lane-race-browser.js', import.meta.url));
  const browser = await browserForFile(), page = await browser.newPage(), errors = [];
  t.after(async () => { await browser.close(); await fixture.kill(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
  const retryLanes = new Set();
  for (const pair of lanePairs) for (const order of [pair, [...pair].reverse()]) for (const failed of [false, true]) {
    const result = await page.evaluate(async (pair, order, failed) => {
      await fetch('/begin?pair=' + pair.join(','));
      return (await fetch('/finish?order=' + order.join(',') + (failed ? '&failure=' + order[0] : ''))).json();
    }, pair, order, failed);
    assert.deepEqual(result.session.operations.running, []);
    for (const c of Object.values(result.counters)) {
      assert.equal(c.started, c.completed + c.superseded + c.deferred + c.aborted + c.uncertain + c.failed);
      assert.equal(c.inFlight, 0);
    }
    assert.ok(result.attempts.every(a => a.state === 'settled' && a.charged < a.maximum));
    if (failed) assert.ok(result.attempts.some(a => a.charged === 0));
    await shadow(page, async (c, session) => {
      const { de: copy } = await import('/packages/ui/src/i18n/de.js');
      c.setAttribute('motion', 'off'); c.configure({ session, copy });
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, result.session);
    const state = await shadow(page, c => {
      const r = c.shadowRoot;
      return { retries: [...r.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length,
        notice: r.querySelector('.notice').textContent, summary: r.querySelector('.summary-text').textContent };
    });
    const failureLane = result.session.operations.lastFailure?.lane;
    if (['reaction', 'understanding'].includes(failureLane)) {
      assert.equal(state.retries, 1, JSON.stringify({ pair, order, failed, state }));
      retryLanes.add(failureLane);
    } else assert.ok(state.retries <= 1, JSON.stringify({ pair, order, failed, state }));
    if (pair.includes('understanding') && !(failed && order[0] === 'understanding')) assert.equal(state.summary, 'Ein Überblick. An overview.');
    assert.doesNotMatch(state.notice, /wird erstellt|wird aktualisiert|building|updating/iu, 'no overview stays busy after work settled');
  }
  assert.deepEqual([...retryLanes].sort(), ['reaction', 'understanding'], 'both retryable failure lanes require exactly one Retry');
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'ait201-lane-races-390.png'), fullPage: false, captureBeyondViewport: false }); }
  assert.deepEqual(errors, []);
});
