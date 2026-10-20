import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, htmlPreviewHostPolicy } from '../../packages/core/src/index.js';
import { previewFixture } from './html-preview-route.js';
import { browserForFile } from '../browser/shared-browser.js';

export async function artifactConsentFrames(t) {
  const root = new URL('../../', import.meta.url).pathname, preview = previewFixture(), requests = [];
  const session = createSession({ demo: true }); session.id = 'ait374'; session.consentRevision = 1;
  session.settings.origin = 'chosen'; session.settings.visuals = 'html'; session.visualsBound = true;
  session.conceptVisualKind = 'html'; session.conceptCost = { maxMicro: 0 }; session.conceptStatus = { phase: 'ready' };
  session.transcript = [{ id: 'source', role: 'user', content: 'Offline dashboard' }]; session.inputRevision = 1;
  session.concepts = ['first', 'bad', 'last'].map(id => ({ id, mediaType: 'text/html', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } }));
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'html', 'images'].map(f => [f, { available: true }])) };
  const coverage = { consentRevision: 1, selected: ['drafts', 'old-drafts'], features: { html: ['drafts', 'old-drafts'] },
    artifacts: { first: { purposes: ['drafts'], unavailable: false }, bad: { purposes: ['old-drafts'], unavailable: true }, last: { purposes: ['drafts'], unavailable: false } } };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} aithema-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}</style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';import {ConceptView} from '/packages/ui/src/concept-view.js';
    const update=ConceptView.prototype.update;ConceptView.prototype.update=function(){window.view=this;return update.apply(this,arguments);};
    const locale=new URLSearchParams(location.search).get('locale');const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
    window.c=document.createElement('aithema-session');const session=await(await fetch('/api/sessions/ait374')).json();
    c.configure({session,copy,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
    c.setAttribute('theme','light');c.setAttribute('motion','off');document.documentElement.lang=locale;document.body.append(c);window.ready=true;
    window.boxes=()=>Object.fromEntries(['.concept-stage','.concept-html','.concept-viewer-head','.concept-viewer-controls','.concept-feedback','.concept-reject','.drafts-canvas','.composer','.concept-access'].map(s=>{const b=c.shadowRoot.querySelector(s).getBoundingClientRect();return[s,[b.x,b.y,b.width,b.height]];}));
  </script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (await preview(req, res)) return;
      const path = new URL(req.url, 'http://fixture').pathname;
      const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (path.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': connected\n\n'); }
      if (path.endsWith('/consent')) return json(coverage);
      if (path.endsWith('/concepts/bad/reject')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({ path, method: req.method, vote: body.vote, chips: body.chips });
        return json({ event: { seq: session.seq + 1, type: 'concept.feedback',
          data: { artifactId: 'bad', vote: 'down', chips: body.chips, archived: true } } });
      }
      if (path.endsWith('/preview')) {
        requests.push(path);
        if (path.includes('/bad/')) { res.writeHead(403); return res.end(); }
        const id = path.split('/').at(-2);
        return preview({ url: '/fixture/mint', method: 'POST', headers: req.headers,
          async *[Symbol.asyncIterator]() { yield `<!doctype html><html><head><title>Draft</title></head><body><h1>${id}</h1></body></html>`; } }, res);
      }
      if (path.endsWith('/settings')) return json({ presets: {} });
      if (path.startsWith('/api/')) return json(session);
      if (path === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`) }); return res.end(html); }
      if (/^\/packages\/(ui|core)\/src\/[\w/-]+\.(js|json)$/u.test(path)) { res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' }); return res.end(await readFile(join(root, path))); }
      res.writeHead(404); res.end();
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await page.close(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], shots = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const [width, locale] of [[390, 'de'], [390, 'en'], [1440, 'de']]) await t.test(`${width}/light/${locale}`, async () => {
    await page.setViewport({ width, height: 900 }); await page.goto(`http://127.0.0.1:${server.address().port}/?locale=${locale}`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate(coverage => { view.update(c.session, { ...coverage, artifacts: Object.fromEntries(Object.entries(coverage.artifacts).map(([id, value]) => [id, { ...value, unavailable: false }])) }); view.open('bad'); }, coverage);
    await page.waitForFunction(() => c.shadowRoot.querySelector('.concept-html').state === 'failure');
    // Baseline uses the same revision and fixed preview slot before resolution fails.
    const baseline = await page.evaluate(() => boxes());
    await page.evaluate(coverage => view.update(c.session, coverage), coverage);
    const state = await page.evaluate(() => {
      const r = c.shadowRoot, p = r.querySelector('.concept-html'), s = p.shadowRoot, message = s.querySelector('.state');
      return { ids: view.items.map(i => i.id), order: view.displayItems?.map(i => i.id), open: view.dialog.open,
        state: p.state, text: s.querySelector('.state-message').textContent, name: message.getAttribute('aria-label'), tabIndex: message.tabIndex,
        retry: !s.querySelector('.reload').disabled, icon: getComputedStyle(s.querySelector('.state-icon')).visibility,
        color: getComputedStyle(message).color, iconColor: getComputedStyle(s.querySelector('.state-icon')).color,
        muted: getComputedStyle(r.querySelector('.concept-activity-text')).getPropertyValue('--aithema-muted').trim(),
        frame: !!s.querySelector('iframe'), notice: r.querySelector('.concept-withdrawn').textContent, boxes: boxes(),
        dismiss: { disabled: r.querySelector('.concept-reject').disabled, label: r.querySelector('.concept-reject').textContent },
        otherActionsDisabled: [...r.querySelectorAll('.concept-download, .concept-regenerate, .concept-up, .concept-down, .concept-guidance-options button')].every(button => button.disabled) };
    });
    assert.deepEqual(state.ids, ['first', 'last']); assert.deepEqual(state.order, ['first', 'bad', 'last']); assert.equal(state.open, true);
    assert.equal(state.state, 'unavailable'); assert.equal(state.text, locale === 'de' ? 'Diese Vorschau ist nicht verfügbar.' : "This preview isn't available.");
    assert.equal(state.name, state.text); assert.equal(state.tabIndex, 0); assert.equal(state.retry, false); assert.equal(state.icon, 'visible');
    assert.equal(state.iconColor, state.color); assert.equal(state.frame, false); assert.equal(state.notice, '');
    assert.deepEqual(state.boxes, baseline, '0 px across the unavailable revision');
    assert.deepEqual(state.dismiss, { disabled: false, label: locale === 'de' ? 'Ablehnen und ausblenden' : 'Reject and archive' });
    assert.equal(state.otherActionsDisabled, true, 'AIT-424: other artifact actions stay disabled');
    // The modal Tab trap must reach the unavailable message, with its exact accessible name.
    await page.evaluate(() => c.shadowRoot.querySelector('.concept-close').focus()); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => c.shadowRoot.querySelector('.concept-html').shadowRoot.activeElement === c.shadowRoot.querySelector('.concept-html').shadowRoot.querySelector('.state')), true);
    const accessible = await page.$(`aria/${state.text}`); assert.ok(accessible, 'neutral message is exposed by its accessible name'); await accessible.dispose();
    await page.evaluate(async () => { c.shadowRoot.activeElement?.shadowRoot?.activeElement?.blur(); c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
    await page.mouse.move(-10, -10);
    const file = `ait374-${width}-light-${locale}.png`; if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file);
    if (evidence && width === 390) {
      const dismissFile = `ait424-${width}-light-${locale}.png`;
      await page.screenshot({ path: join(evidence, dismissFile), fullPage: false, captureBeyondViewport: false }); shots.push(dismissFile);
    }
    for (const [delta, id] of [[-1, 'first'], [1, 'bad'], [1, 'last']]) {
      await page.evaluate(delta => view.navigate(delta), delta);
      await page.waitForFunction(id => view.current()?.id === id && c.shadowRoot.querySelector('.concept-html').state === (id === 'bad' ? 'unavailable' : 'ready'), {}, id);
      assert.deepEqual(await page.evaluate(() => boxes()), baseline, `${id} keeps its size and position (0 px)`);
    }
    await page.evaluate(() => { view.open('bad'); c.shadowRoot.querySelector('.concept-reject').click(); });
    await page.waitForFunction(() => !view.dialog.open && c.session.concepts.find(item => item.id === 'bad').archived);
    assert.deepEqual(await page.evaluate(() => view.displayItems.map(item => item.id)), ['first', 'last']);
    assert.deepEqual(requests.filter(request => request.path).at(-1), { path: '/api/sessions/ait374/concepts/bad/reject', method: 'POST', vote: 'down', chips: [] });
    checks.push({ width, height: 900, locale, theme: 'light', ...state, movementPx: 0, siblingOrder: ['first', 'bad', 'last'], siblingsReady: true,
      keyboardReachedMessage: true, accessibleNameVerified: true, viewportOnly: true, settled: true, blurred: true, pinnedFonts: true });
  });
  if (evidence) await writeFile(join(evidence, 'ait374-checks.json'), JSON.stringify({ shots, checks, offline: true }, null, 2));
}
