import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSession, applyEvent } from '../../packages/core/src/index.js';

// Reuses AIT-364's browser, page and offline server within its measured file.
export async function scopedConsentEdges({ t, a, isCI, session, setSession, setSelected, features, url, evidence }) {
  const checks = [], shots = [];
  const heldRead = async () => {
    for (let i = 0; i < 300 && !a.heldConsentRead; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(a.heldConsentRead, 'consent read reached the controlled barrier');
    const request = a.heldConsentRead; a.heldConsentRead = null; return request;
  };
  const releaseSnapshots = async (status = 200) => {
    a.holdSnapshot = false;
    for (const request of a.heldSnapshots ?? []) {
      if (status === 200) await request.continue();
      else await request.respond({ status, contentType: 'application/json', body: '{}' });
    }
    a.heldSnapshots = [];
  };
  const init = async (width = 1440, kind = 'html') => {
    a.refreshFailure = null; a.holdConsentRead = false; a.heldConsentRead = null; a.holdSnapshot = false;
    const s = createSession({ demo: true }); s.id = 'ait364'; s.locale = 'de'; s.consentRevision = 1;
    s.settings.origin = 'chosen'; s.settings.visuals = 'auto'; s.visualsBound = true; s.conceptVisualKind = kind; s.conceptCost = { maxMicro: 0 };
    s.transcript = [{ id: 'source', role: 'user', content: 'Keep this transcript.' }]; s.inputRevision = 1;
    s.concepts = ['image', 'html'].map(type => ({ id: type, mediaType: type === 'html' ? 'text/html' : 'image/png', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } }));
    s.conceptStatus = { phase: 'ready' }; s.featureMatrix = { best: Object.fromEntries(Object.keys(features).map(f => [f, { available: true }])) };
    setSession(s); setSelected(['models', 'images', 'drafts']);
    await a.setViewport({ width, height: 900 }); await a.goto(url); await a.waitForFunction(() => window.ready);
    await a.evaluate(async kind => { c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas(); view.open(kind); }, kind);
    await a.waitForFunction(kind => c.shadowRoot.querySelector('.canvas-html').state === 'ready' &&
      (kind === 'html' ? c.shadowRoot.querySelector('.concept-html').state === 'ready' : c.shadowRoot.querySelector('.concept-image').hasAttribute('src')), {}, kind);
  };
  const capture = async (width, state) => {
    await a.evaluate(async () => {
      c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    });
    await a.mouse.move(-10, -10);
    const file = `ait365-${width}-light-de-${state}.png`;
    if (evidence) await a.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
    shots.push(file);
  };
  const event = (changed, removed) => {
    const e = { seq: session().seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, ...(changed ? { changed } : {}), ...(removed ? { removed } : {}) } };
    setSession(applyEvent(session(), e)); return e;
  };
  for (const [width, kind] of [[1440, 'html'], [390, 'html'], [1440, 'image']]) await t.test(`AIT-365 E1 ${width}/${kind}`, async () => {
    await init(width, kind);
    const baseline = await a.evaluate(() => boxes());
    const e = event([kind === 'html' ? 'html-drafts' : 'images']);
    setSelected(kind === 'html' ? ['models', 'images'] : ['models', 'drafts']);
    session().featureMatrix.best[kind === 'html' ? 'html' : 'images'] = { available: false, reason: 'current processing consent required' };
    a.holdSnapshot = true; a.heldSnapshots = [];
    const immediate = await a.evaluate(e => {
      const start = performance.now(); c.receive(e);
      // Deliberately no await or microtask: this is the event handler boundary.
      return { ...inspect(), eventToRemovalMs: performance.now() - start, geometry: boxes() };
    }, e);
    assert.equal(immediate.open, false, 'scoped event closes the revoked viewer before returning');
    assert.equal(immediate.frames.includes(kind), false);
    assert.equal(immediate.images.includes(kind), false, 'all revoked image src values are removed synchronously');
    if (kind === 'html') assert.equal(immediate.iframeCount, 0);
    assert.deepEqual(immediate.ids, [kind === 'html' ? 'image' : 'html']);
    assert.ok(immediate.eventToRemovalMs < (isCI ? 50 : 5), `eventToRemovalMs=${immediate.eventToRemovalMs}`);
    assert.deepEqual(immediate.geometry, baseline, 'event moves thread/composer/rail/header/access/canvas 0 px');
    await capture(width, `scoped-${kind}`);
    await releaseSnapshots(); await a.waitForFunction(() => window.verifiedRevision === c.session.consentRevision);
    const confirmed = await a.evaluate(() => ({ ...inspect(), geometry: boxes() }));
    assert.equal(confirmed.notice, immediate.notice, 'refresh keeps the same withdrawal notice');
    assert.deepEqual(confirmed.ids, immediate.ids); assert.deepEqual(confirmed.geometry, baseline, 'confirmation moves 0 px');
    checks.push({ width, theme: 'light', locale: 'de', edge: 'E1', kind, ...immediate, confirmed, movementPx: 0, sameNotice: true, viewportOnly: true });
  });
  for (const ahead of [false, true]) await t.test(`AIT-365 E3 grant/server-ahead=${ahead}`, async () => {
    await init();
    // The server has coverage; the client document still describes a missing
    // draft selection. Its older revision cannot revoke already delivered bytes.
    await a.evaluate(() => {
      view.update(c.session, { consentRevision: c.session.consentRevision - 1, selected: ['models', 'images'], features: { html: ['drafts'], images: ['images'] } });
      window.grantSource = c.shadowRoot.querySelector('.concept-html').artifact;
      window.grantSurfaces = [...c.shadowRoot.querySelectorAll('aithema-html-preview')].filter(p => p.artifact).map(node => ({ node, source: node.artifact }));
      window.grantSamples = []; window.sampleGrant = true;
      const sample = () => {
        const preview = c.shadowRoot.querySelector('.concept-html'), box = preview.getBoundingClientRect();
        grantSamples.push({ surfaces: grantSurfaces.map(({ node, source }) => { const b = node.getBoundingClientRect(); return { present: node.artifact === source && !!node.shadowRoot.querySelector('iframe'), visible: b.width > 0 && b.height > 0 && getComputedStyle(node).visibility === 'visible' }; }), present: preview.artifact === grantSource && !!preview.shadowRoot.querySelector('iframe'), visible: view.dialog.open && box.width > 0 && box.height > 0 && getComputedStyle(preview).visibility === 'visible' });
        if (sampleGrant) requestAnimationFrame(sample);
      }; requestAnimationFrame(sample);
    });
    const e = event(['html-drafts'], []); a.holdConsentRead = true; a.heldConsentRead = null;
    await a.evaluate(e => c.receive(e), e);
    const first = await heldRead();
    await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (ahead) {
      await first.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ consentRevision: 1, selected: ['models', 'images'], features: { html: ['drafts'], images: ['images'] } }) });
      // Let the stale response schedule its retry before advancing virtual time.
      await a.waitForFunction(() => clock.pending() >= 2);
      await a.evaluate(() => clock.tick(100));
      const next = await heldRead(); a.holdConsentRead = false; await next.continue();
    } else { a.holdConsentRead = false; await first.continue(); }
    await a.waitForFunction(() => window.verifiedRevision === c.session.consentRevision);
    const samples = await a.evaluate(async () => { window.sampleGrant = false; await new Promise(requestAnimationFrame); return grantSamples; });
    assert.ok(samples.length >= 2); assert.ok(samples.every(s => s.present && s.visible), 'every animation frame keeps covered content visible');
    assert.ok(samples.every(s => s.surfaces.length >= 2 && s.surfaces.every(surface => surface.present && surface.visible)), 'viewer and folded canvas both retain their covered frames throughout the grant');
    await a.evaluate(() => clock.tick(2000)); assert.equal(await a.evaluate(() => view.dialog.open), true, 'successful grant clears the original watchdog');
    if (ahead) await capture(1440, 'grant');
    checks.push({ width: 1440, theme: 'light', locale: 'de', state: 'E3', serverAhead: ahead, samples, neverHidden: true, watchdogCleared: true });
  });
  await t.test('AIT-365 E3: lagging document keeps the original deadline', async () => {
    await init();
    await a.evaluate(() => view.update(c.session, { consentRevision: 0, selected: ['models', 'images'], features: { html: ['drafts'], images: ['images'] } }));
    const e = event(['html-drafts'], []); a.holdConsentRead = true; a.heldConsentRead = null;
    await a.evaluate(e => c.receive(e), e);
    const request = await heldRead();
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ consentRevision: 1, selected: ['models', 'images'], features: { html: ['drafts'], images: ['images'] } }) });
    await a.waitForFunction(() => clock.pending() >= 2);
    const at1999 = await a.evaluate(() => { clock.tick(1999); return inspect(); });
    assert.equal(at1999.open, true); assert.deepEqual(at1999.ids, ['image', 'html']);
    const at2000 = await a.evaluate(() => { clock.tick(1); return inspect(); });
    assert.equal(at2000.open, false); assert.deepEqual(at2000.ids, []); assert.deepEqual(at2000.frames, []); assert.deepEqual(at2000.images, []);
    assert.equal(at2000.notice, 'Entwurf zurückgezogen');
    a.holdConsentRead = false; if (a.heldConsentRead) { await a.heldConsentRead.continue(); a.heldConsentRead = null; }
    checks.push({ width: 1440, theme: 'light', locale: 'de', state: 'E3', persistentLag: true, at1999, at2000, deadlineAdvancedMs: 2000, fullWithdrawalCopy: true });
  });
  for (const fail of [false, true]) await t.test(`AIT-365 E4 detach/${fail ? 'failure' : 'success'}`, async () => {
    await init(); const e = event(); a.holdSnapshot = true; a.heldSnapshots = [];
    const immediate = await a.evaluate(e => { c.receive(e); c.remove(); document.body.append(c); return inspect(); }, e);
    assert.deepEqual(immediate.ids, []); assert.deepEqual(immediate.frames, []); assert.deepEqual(immediate.images, []); assert.equal(immediate.open, false);
    await a.waitForFunction(() => window.refreshRounds >= 2);
    if (fail) a.refreshFailure = 'http';
    await releaseSnapshots(fail ? 503 : 200);
    if (!fail) await a.waitForFunction(() => window.verifiedRevision === c.session.consentRevision);
    else await a.waitForFunction(() => c.shadowRoot.querySelector('.concept-access').hasAttribute('data-refresh-failed'));
    const settled = await a.evaluate(() => inspect());
    assert.deepEqual(settled.ids, fail ? [] : ['image', 'html']);
    if (fail) { assert.deepEqual(settled.frames, []); assert.deepEqual(settled.images, []); assert.equal(settled.notice, 'Entwurf zurückgezogen'); }
    checks.push({ width: 1440, theme: 'light', locale: 'de', state: 'E4', fail, immediate, settled, unverifiedSurvivesDetach: true });
  });
  a.refreshFailure = null;
  return { shots, checks };
}
