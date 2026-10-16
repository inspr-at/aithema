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
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
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
    // The subscription can start real recovery after the settled direct-lane
    // snapshot. Observe and settle that work rather than asserting idle early.
    const observed = await page.evaluate(async () => (await fetch('/observe-recovery')).json());
    if (observed.operations.running.includes('understanding') && !observed.understanding.readinessAssessed) {
      await until(page, () => document.querySelector('aithema-session').session.operations?.running.includes('understanding'));
      const pendingNotice = await shadow(page, c => c.shadowRoot.querySelector('.notice').textContent);
      assert.match(pendingNotice, /wird erstellt|building/iu, 'real recovery owns the preparation slot until settled');
    }
    const recovery = await page.evaluate(async () => (await fetch('/settle-recovery')).json());
    assert.deepEqual(recovery.session.operations.running, []);
    for (const c of Object.values(recovery.counters)) {
      assert.equal(c.started, c.completed + c.superseded + c.deferred + c.aborted + c.uncertain + c.failed);
      assert.equal(c.inFlight, 0, 'reconnect recovery leaves no admitted attempt pending');
    }
    await until(page, () => document.querySelector('aithema-session').session.operations?.running.length === 0);
    const state = await shadow(page, c => {
      const r = c.shadowRoot;
      return { retries: [...r.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length,
        notice: r.querySelector('.notice').textContent, summary: r.querySelector('.summary-text').textContent, renderedSession: c.session };
    });
    assert.deepEqual(state.renderedSession.operations.running, []);
    const failureLane = recovery.session.operations.lastFailure?.lane;
    if (['reaction', 'understanding'].includes(failureLane)) {
      assert.equal(state.retries, 1, JSON.stringify({ pair, order, failed, state }));
    } else assert.ok(state.retries <= 1, JSON.stringify({ pair, order, failed, state }));
    if (pair.includes('understanding') && !(failed && order[0] === 'understanding')) assert.equal(state.summary, 'Ein Überblick. An overview.');
    assert.doesNotMatch(state.notice, /wird erstellt|wird aktualisiert|building|updating/iu, `no overview stays busy after work settled: ${JSON.stringify({ pair, order, failed, state, session: result.session })}`);
  }
  // Direct lane races do not record handler failures. Exercise the real retry
  // scheduler as well, so the UI receives each retryable failure in its snapshot.
  for (const lane of ['reaction', 'understanding']) {
    const session = await page.evaluate(async lane => {
      const response = await fetch('/retry-failure?lane=' + lane);
      if (!response.ok) throw new Error(`Retry failure fixture returned HTTP ${response.status}`);
      return response.json();
    }, lane);
    assert.equal(session.operations.lastFailure.lane, lane);
    assert.equal(session.operations.lastFailure.retryable, true);
    await shadow(page, async (c, session) => {
      const { de: copy } = await import('/packages/ui/src/i18n/de.js');
      c.setAttribute('motion', 'off'); c.configure({ session, copy });
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, session);
    await page.evaluate(async () => (await fetch('/settle-recovery')).json());
    await until(page, () => document.querySelector('aithema-session').session.operations?.running.length === 0);
    const retries = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length);
    assert.equal(retries, 1, `${lane} failure shows exactly one Retry`);
  }
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) {
    await shadow(page, async c => {
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true })
        .filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'ait201-lane-races-390.png'), fullPage: false, captureBeyondViewport: false }); }
  assert.deepEqual(errors, []);
});

// These projections model the event-order gaps between a facade person final,
// lane.status, pause, and assistant final. Provider/settlement coverage stays in
// the real-lane matrix above; detached elements keep automatic refreshes from
// racing the deliberately held event boundary.
for (const scenario of ['e155043 pause retains pending overview', 'be304ae reply ends preparation', 'e5bb795 purpose stop versus stuck reply']) {
  test(`AIT-197 ${scenario}`, { timeout: 30_000 }, async t => {
    const fixture = await startChild(new URL('../fixtures/lane-race-browser.js', import.meta.url));
    const browser = await browserForFile(), page = await browser.newPage();
    t.after(async () => { await browser.close(); await fixture.kill(); });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.shadowRoot);
    const result = await page.evaluate(async scenario => {
      const { de: copy } = await import('/packages/ui/src/i18n/de.js');
      const { inputRevision } = await import('/packages/core/src/session.js');
      const c = document.createElement('aithema-session');
      c.setAttribute('motion', 'off');
      const session = await (await fetch('/snapshot')).json();
      const revision = inputRevision(session);
      session.operations = { inputRevision: revision, running: [], lastFailure: null };
      const configure = () => c.configure({ session: structuredClone(session), copy });
      const state = () => ({ notice: c.shadowRoot.querySelector('.notice').textContent,
        preparing: c.shadowRoot.querySelector('.notice').textContent === copy.preparingOverview,
        stuck: !c.shadowRoot.querySelector('.overview-retry').hidden,
        retries: [...c.shadowRoot.querySelectorAll('.overview-retry, .retry')].filter(e => !e.hidden).length });
      if (scenario.startsWith('e155043')) {
        session.transcript.at(-1).voiceCallId = 'pending-facade';
        configure(); const pending = state();
        session.paused = true; configure(); const paused = state();
        session.paused = false; configure(); const resumed = state();
        // The reply and overview both settle after resuming.
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Which work?', inputRevision: revision } });
        const settled = state();
        return { pending, paused, resumed, settled };
      }
      if (scenario.startsWith('be304ae')) {
        session.voiceLifecycle = { callId: 'active-call', providerSessionId: 'provider', epoch: 1, state: 'active' };
        configure(); const pending = state();
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Which work?', inputRevision: revision } });
        return { pending, settled: state() };
      }
      session.paused = true; session.pauseReason = 'purpose'; configure(); const purpose = state();
      session.pauseReason = null; configure(); const stuck = state();
      session.paused = false; configure(); const unpausedStuck = state();
      return { purpose, stuck, unpausedStuck, failedCopy: copy.understandingFailed };
    }, scenario);
    if (scenario.startsWith('e155043')) {
      for (const name of ['pending', 'paused', 'resumed']) {
        assert.equal(result[name].preparing, true, `${name}: pending overview stays visible`);
        assert.equal(result[name].stuck, false);
      }
      assert.equal(result.settled.preparing, false); assert.equal(result.settled.stuck, false);
    } else if (scenario.startsWith('be304ae')) {
      assert.equal(result.pending.preparing, true);
      assert.equal(result.settled.preparing, false, 'assistant final ends wird erstellt even while voice remains active');
      assert.doesNotMatch(result.settled.notice, /wird erstellt|building/iu);
      assert.equal(result.settled.stuck, false);
    } else {
      assert.equal(result.purpose.stuck, false, 'purpose stop is deliberate, not a stuck reply');
      assert.equal(result.purpose.retries, 0, 'purpose stop offers no replacement reply');
      for (const name of ['stuck', 'unpausedStuck']) {
        assert.equal(result[name].stuck, true, `${name}: genuinely missing reply remains actionable`);
        assert.match(result[name].notice, new RegExp(result.failedCopy, 'u'));
      }
    }
  });
}
