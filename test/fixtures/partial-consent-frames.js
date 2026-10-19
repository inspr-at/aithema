// AIT-364 offline cross-tab wire fixture. The actual Settings consent editor,
// session SSE consumer, preview route and rendering components run in Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, applyEvent, htmlPreviewHostPolicy } from '../../packages/core/src/index.js';
import { previewFixture } from './html-preview-route.js';
import { browserForFile } from '../browser/shared-browser.js';
import { installConsentClock } from './consent-clock.js';
import { scopedConsentEdges } from './scoped-consent-edges.js';

export async function partialConsentFrames(t, { isCI } = {}) {
  const startedAt = performance.now();
  const root = new URL('../../', import.meta.url).pathname, streams = new Set(), preview = previewFixture();
  let session, selected, eventChanged, mints = 0;
  const features = { text: ['models'], analysis: ['models'], html: ['drafts'], images: ['images'] };
  const document = () => ({ contract: 'ait364', consentRevision: session.consentRevision, selected, features,
    items: ['models', 'drafts', 'images'].map(id => ({ id, version: 1, title: { models: 'Models', drafts: 'HTML drafts', images: 'Images' }[id], recipients: 'Offline fixture', text: 'For this conversation.' })) });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} aithema-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}</style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';
    import {ConceptView} from '/packages/ui/src/concept-view.js';
    (${installConsentClock.toString()})();
    const update=ConceptView.prototype.update;
    ConceptView.prototype.update=function(s){window.view=this;const result=update.apply(this,arguments);if(arguments[2])window.verifiedRevision=arguments[1].consentRevision;if(window.watching&&s.featureMatrix.best[window.removedFeature]?.reason==='current processing consent required'&&!window.sameTick)window.sameTick={...window.inspect(),eventToRemovalMs:performance.now()-window.eventAt,refreshRounds:window.refreshRounds};if(window.watchFailClosed&&this.items.length===0&&c.shadowRoot.querySelector('.concept-withdrawn').textContent===copy.conceptWithdrawn)window.failClosedTick={...window.inspect(),eventToRemovalMs:performance.now()-window.eventAt,refreshRounds:window.refreshRounds};return result;};
    window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
    const params=new URLSearchParams(location.search),locale=params.get('locale')||'de';
    const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
    const c=document.createElement('aithema-session');window.c=c;
    const session=await (await fetch('/api/sessions/ait364')).json();
    c.configure({session,copy,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
    const receive=c.receive.bind(c);c.receive=event=>{if(event.type==='consent.revised'&&event.seq>c.session.seq){window.eventAt=performance.now();window.refreshRounds=0;}return receive(event);};
    const nativeFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(window.eventAt&&new URL(url,location.href).pathname==='/api/sessions/ait364')window.refreshRounds++;return nativeFetch(url,options);};
    c.setAttribute('theme',params.get('theme')||'light');c.setAttribute('motion','off');document.documentElement.lang=locale;document.body.append(c);
    window.boxes=()=>Object.fromEntries(['.transcript-shell','.composer','.concept-rail','.band','.concept-access','.drafts-canvas'].map(s=>{const b=c.shadowRoot.querySelector(s).getBoundingClientRect();return[s,[b.x,b.y,b.width,b.height]];}));
    window.inspect=()=>{const r=c.shadowRoot;return {open:window.view.dialog.open,ids:window.view.items.map(i=>i.id),frames:[...r.querySelectorAll('aithema-html-preview')].filter(n=>n.artifact).map(n=>n.dataset.id),images:[...r.querySelectorAll('img[src]')].map(n=>n.dataset.id),focus:r.activeElement?.className,count:r.querySelector('.concept-count').textContent,previousDisabled:r.querySelector('.concept-previous').disabled,nextDisabled:r.querySelector('.concept-next').disabled,iframeCount:[...r.querySelectorAll('aithema-html-preview')].filter(n=>n.shadowRoot.querySelector('iframe')).length,notice:r.querySelector('.concept-withdrawn').textContent,live:r.querySelector('.concept-withdrawn').getAttribute('aria-live'),state:r.querySelector('.concept-access').dataset.state,tooltip:r.querySelector('.concept-backdrop-hint').hasAttribute('data-show'),revoked:window.revoked,transcript:c.session.transcript.map(t=>t.content)};};
    window.ready=true;
  </script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (await preview(req, res)) return;
      if (path.endsWith('/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      if (path.endsWith('/consent')) {
        if (req.method === 'GET') return json(document());
        let body = ''; for await (const chunk of req) body += chunk;
        const decision = JSON.parse(body); assert.equal(decision.processing.revision, session.consentRevision);
        selected = decision.processing.items;
        const event = { seq: session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, ...(eventChanged ? { changed: eventChanged } : {}) } };
        session = applyEvent(session, event);
        session.featureMatrix = { best: Object.fromEntries(Object.entries(features).map(([kind, ids]) => [kind, ids.every(id => selected.includes(id)) ? { available: true } : { available: false, reason: 'current processing consent required' }])) };
        for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
        return json({ granted: true, consentRevision: session.consentRevision, event });
      }
      if (path.endsWith('/preview')) {
        mints++;
        if (!selected.includes('drafts')) { res.writeHead(403); return res.end(); }
        // Production single-use capability route; no provider or executable blob URL.
        const mintReq = { url: '/fixture/mint', method: 'POST', headers: req.headers, async *[Symbol.asyncIterator]() { yield '<!doctype html><html><head><title>Draft</title></head><body><h1>Offline draft</h1></body></html>'; } };
        return preview(mintReq, res);
      }
      if (path.endsWith('/image')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); }
      if (path.endsWith('/settings')) return json({ presets: {} });
      if (path.startsWith('/api/')) return json(session);
      if (path === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': htmlPreviewHostPolicy(`http://${req.headers.host}/_aithema/html-preview`) }); return res.end(html); }
      if (/^\/packages\/(ui|core)\/src\/[\w/-]+\.(js|json)$/u.test(path)) { res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' }); return res.end(await readFile(join(root, path))); }
      res.writeHead(404); res.end();
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); });
  const a = await browser.newPage(), b = await browser.newPage(), checks = [], shots = [];
  await a.setRequestInterception(true);
  a.on('request', request => {
    if (a.holdSnapshot && new URL(request.url()).pathname === '/api/sessions/ait364') { (a.heldSnapshots ??= []).push(request); return; }
    if (a.refreshFailure === 'http' && new URL(request.url()).pathname === '/api/sessions/ait364') { void request.respond({ status: 503, contentType: 'application/json', body: '{}' }); return; }
    if (a.holdConsentRead && request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/consent')) { a.heldConsentRead = request; return; }
    void request.continue();
  });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const configs = [
    { width: 1440, theme: 'light', locale: 'de', kind: 'html', mixed: false },
    { width: 1440, theme: 'light', locale: 'en', kind: 'html', mixed: true },
    { width: 390, theme: 'light', locale: 'de', kind: 'html', mixed: false },
    { width: 1440, theme: 'dark', locale: 'de', kind: 'html', mixed: false },
    { width: 1440, theme: 'light', locale: 'de', kind: 'image', mixed: false },
    { width: 1440, theme: 'light', locale: 'de', kind: 'image', mixed: true },
  ];
  for (const config of configs) await t.test(`${config.kind}/${config.width}/${config.theme}/${config.locale}/${config.mixed ? 'mixed' : 'only'}`, async () => {
    const { width, theme, locale, kind, mixed } = config, feature = kind === 'html' ? 'html' : 'images';
    const artifact = (id, type) => ({ id, mediaType: type === 'html' ? 'text/html' : 'image/png', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } });
    session = createSession({ demo: true }); session.id = 'ait364'; session.locale = locale; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.visuals = 'auto'; session.visualsBound = true; session.conceptVisualKind = kind; session.conceptCost = { maxMicro: 0 };
    session.transcript = [{ id: 'source', role: 'user', content: 'Keep this transcript.' }]; session.inputRevision = 1;
    session.concepts = [...(mixed ? [artifact('retained', kind === 'html' ? 'image' : 'html')] : []), artifact('removed', kind)]; session.conceptStatus = { phase: 'ready' };
    session.featureMatrix = { best: Object.fromEntries(Object.keys(features).map(f => [f, { available: true }])) }; selected = ['models', 'drafts', 'images']; mints = 0;
    const url = `http://127.0.0.1:${server.address().port}/?locale=${locale}&theme=${theme}`;
    await a.setViewport({ width, height: 900 });
    for (const page of [a, b]) { await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.goto(url); await page.waitForFunction(() => window.ready); }
    // The folded canvas and viewer are simultaneously alive in A.
    await a.evaluate(async kind => { if (kind === 'html') { c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas(); } c.shadowRoot.querySelector('.concept-preview').focus(); view.open('removed'); }, kind);
    if (kind === 'html') await a.waitForFunction(() => [...c.shadowRoot.querySelectorAll('aithema-html-preview')].every(p => p.state === 'ready'));
    else await a.waitForFunction(() => c.shadowRoot.querySelector('.concept-image').hasAttribute('src') && c.shadowRoot.querySelector('.concept-backdrop img[src]'));
    const baseline = await a.evaluate(() => boxes());
    const beforeMints = mints;
    await a.evaluate(feature => { window.removedFeature = feature; window.watching = true; window.noticeChanges = []; new MutationObserver(() => noticeChanges.push(c.shadowRoot.querySelector('.concept-withdrawn').textContent)).observe(c.shadowRoot.querySelector('.concept-withdrawn'), { childList: true, subtree: true, characterData: true }); }, feature);
    a.holdConsentRead = true; a.heldConsentRead = null;
    // B uses the real Settings dialog and save action. A receives SSE, never reloads.
    await b.evaluate(() => view.consent(c.shadowRoot.querySelector('.concept-preview')));
    await b.waitForFunction(() => c.shadowRoot.querySelector('.consent-items input[value="drafts"]'));
    await b.evaluate(kind => { c.shadowRoot.querySelector('.consent-items input[value="' + (kind === 'html' ? 'drafts' : 'images') + '"]').click(); c.shadowRoot.querySelector('.done').click(); }, kind);
    await a.waitForFunction(() => window.sameTick, { timeout: 5000 });
    const result = await a.evaluate(() => sameTick);
    a.holdConsentRead = false; if (a.heldConsentRead) await a.heldConsentRead.continue();
    await a.waitForFunction(() => window.verifiedRevision === c.session.consentRevision);
    assert.ok(result.eventToRemovalMs >= 0 && result.eventToRemovalMs < 1000, `one-round removal took ${result.eventToRemovalMs} ms`);
    assert.equal(result.refreshRounds, 1, 'removal happens within the first snapshot refresh round');
    assert.equal(result.open, false, 'W1 viewer closes in the update tick');
    assert.equal(result.frames.includes('removed'), false, 'W2 no revoked frame artifact');
    assert.equal(result.images.includes('removed'), false, 'no revoked thumbnail/backdrop/viewer/canvas bytes');
    assert.equal(result.tooltip, false);
    assert.equal(result.focus, 'concept-preview', 'focus returns to concept access control');
    assert.deepEqual(result.ids, mixed ? ['retained'] : []);
    assert.equal(result.count, mixed ? locale === 'en' ? '1 of 1' : '1 von 1' : '', 'W5 count updates in the same tick, before reopening');
    assert.equal(result.previousDisabled, true); assert.equal(result.nextDisabled, true);
    assert.equal(result.iframeCount, 0, 'revoked preview frames are removed from the DOM');
    if (kind === 'image') assert.ok(result.revoked.length > 0, 'object URLs revoked in the same tick');
    const copy = locale === 'de' ? kind === 'html' ? 'Entwurf entfernt. Die Einwilligung für Entwürfe wurde widerrufen.' : 'Bild entfernt. Die Einwilligung für Bilder wurde widerrufen.'
      : 'Draft removed. Consent for drafts was withdrawn.';
    assert.equal(result.notice, width === 390 ? 'Entwurf entfernt' : copy);
    assert.equal(result.live, 'polite'); assert.deepEqual(result.transcript, ['Keep this transcript.']);
    assert.deepEqual(await a.evaluate(() => boxes()), baseline, '0 px across withdrawal, including canvas/access slots');
    const capture = async state => {
      await a.evaluate(async () => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
      await a.mouse.move(-10, -10);
      if (evidence && (!mixed || locale === 'en')) { const file = `ait364-${width}-${theme}-${locale}-${state}.png`; await a.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file); }
    };
    const removedLoad = await a.evaluate(() => view.load('removed'));
    assert.equal(removedLoad, null, 'removed cached draft cannot be read');
    assert.equal(await a.evaluate(() => view.previewSource('removed').mint().then(() => false, () => true)), true, 'removed scope cannot mint a preview');
    await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const noFlash = await a.evaluate(() => { view.render(); return inspect(); });
    assert.equal(noFlash.frames.includes('removed'), false, 'no removed frame is repainted');
    assert.equal(noFlash.images.includes('removed'), false, 'no revoked image is repainted');
    let after4s = null, retainedOpenable = false;
    await capture(kind === 'html' ? 'w1-w2-w3' : 'images-w1-w3');
    if (!mixed) {
      assert.equal(await a.evaluate(() => c.shadowRoot.querySelector('.canvas-empty').hidden), false);
      if (width === 1440 && theme === 'light' && locale === 'de') {
        await a.evaluate(() => clock.tick(4000));
        await a.waitForFunction(() => !c.shadowRoot.querySelector('.concept-withdrawn').textContent, { timeout: 5500 });
        const after = await a.evaluate(() => ({ state: inspect().state, text: c.shadowRoot.querySelector('.concept-activity-text').textContent, announcements: noticeChanges.filter(Boolean) }));
        assert.equal(after.state, 'consent'); assert.match(after.text, new RegExp(kind === 'html' ? 'Entwürfe brauchen Ihre Einwilligung' : 'Bilder brauchen Ihre Einwilligung'));
        assert.deepEqual(after.announcements, [copy], 'notice announced once'); after4s = after;
        assert.deepEqual(await a.evaluate(() => boxes()), baseline); await capture(kind + '-w4');
      }
    } else {
      await a.evaluate(() => view.open('retained'));
      assert.equal(await a.evaluate(() => view.dialog.open), true); retainedOpenable = true;
      assert.equal(await a.evaluate(() => c.shadowRoot.querySelector('.concept-count').textContent), locale === 'en' ? '1 of 1' : '1 von 1');
    }
    if (kind === 'html') assert.equal(mints, beforeMints, 'no preview mint retries after the removed scope');
    checks.push({ ...config, ...result, movementPx: 0, synchronousRedaction: true, viewportOnly: true, noReload: true, removedCachedLoad: removedLoad, removedScopeMintBlocked: true, slowConsentReadCannotDelayRedaction: true, noFlash, after4s, retainedOpenable, noPreviewRetry: kind !== 'html' || mints === beforeMints });
  });
  await t.test('full withdrawal retains its copy and synchronous redaction', async () => {
    const result = await a.evaluate(() => {
      c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
      return inspect();
    });
    assert.equal(result.open, false); assert.deepEqual(result.frames, []); assert.deepEqual(result.images, []);
    assert.equal(result.notice, 'Entwurf zurückgezogen');
    checks.push({ width: 1440, theme: 'light', locale: 'de', kind: 'full', ...result, synchronousRedaction: true, unchangedCopy: true });
  });
  for (const [width, failure, changed] of [[1440, 'http'], [390, 'document-stall'], [1440, 'http', ['future-scope']], [390, 'document-stall', ['future-scope']]]) await t.test(`v1.1 fail-closed ${failure}/${width} and recovery`, async () => {
    eventChanged = changed;
    session = createSession({ demo: true }); session.id = 'ait364'; session.locale = 'de'; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.visuals = 'auto'; session.visualsBound = true; session.conceptVisualKind = 'html'; session.conceptCost = { maxMicro: 0 };
    session.transcript = [{ id: 'source', role: 'user', content: 'Keep this transcript.' }]; session.inputRevision = 1;
    session.concepts = ['image', 'html'].map(kind => ({ id: kind, mediaType: kind === 'html' ? 'text/html' : 'image/png', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } }));
    session.conceptStatus = { phase: 'ready' };
    session.featureMatrix = { best: Object.fromEntries(Object.keys(features).map(f => [f, { available: true }])) }; selected = ['models', 'drafts', 'images'];
    await a.setViewport({ width, height: 900 });
    const url = `http://127.0.0.1:${server.address().port}/?locale=de&theme=light`;
    for (const page of [a, b]) { await page.goto(url); await page.waitForFunction(() => window.ready); }
    // Different kinds are alive at once: HTML canvas, image viewer and image cache.
    await a.evaluate(async () => { c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas(); c.shadowRoot.querySelector('.concept-preview').focus(); view.open('image'); });
    await a.waitForFunction(() => c.shadowRoot.querySelector('.canvas-html').state === 'ready' && c.shadowRoot.querySelector('.concept-image').hasAttribute('src'));
    const baseline = await a.evaluate(() => boxes());
    const layout = () => a.evaluate(() => Object.fromEntries(['.concept-access', '.concept-rail', '.concept-preview-slot', '.concept-preview', '.concept-preview-thumbs', '.concept-preview-glyph', '.concept-preview-text', '.concept-withdrawn'].map(s => { const n = c.shadowRoot.querySelector(s), b = n.getBoundingClientRect(), css = getComputedStyle(n); return [s, { width: b.width, columns: css.gridTemplateColumns, display: css.display, text: n.textContent, hidden: n.hidden }]; })));
    const baselineLayout = await layout();
    await a.evaluate(() => {
      window.watchFailClosed = true;
      window.expireConsent = () => clock.tick(2000);
    });
    a.refreshFailure = failure === 'http' ? 'http' : null;
    a.holdConsentRead = failure === 'document-stall'; a.heldConsentRead = null;
    await b.evaluate(() => view.consent(c.shadowRoot.querySelector('.concept-preview')));
    await b.waitForFunction(() => c.shadowRoot.querySelector('.consent-items input[value="drafts"]'));
    await b.evaluate(() => { c.shadowRoot.querySelector('.consent-items input[value="drafts"]').click(); c.shadowRoot.querySelector('.done').click(); });
    if (failure === 'document-stall') {
      await a.waitForFunction(() => window.expireConsent && !view.items.some(i => i.id === 'html'));
      assert.equal(await a.evaluate(() => view.dialog.open), true, 'covered image stays visible during the accepted refresh window');
      await a.evaluate(() => { window.deadlineAdvancedMs = 2000; expireConsent(); });
    }
    await a.waitForFunction(() => window.failClosedTick);
    const result = await a.evaluate(() => failClosedTick);
    assert.deepEqual(result.ids, []); assert.deepEqual(result.frames, []); assert.deepEqual(result.images, []);
    assert.equal(result.iframeCount, 0); assert.equal(result.open, false); assert.equal(result.focus, 'concept-preview');
    assert.equal(result.state, 'gone'); assert.equal(result.notice, 'Entwurf zurückgezogen'); assert.equal(result.live, 'polite');
    assert.ok(result.revoked.length > 0); assert.deepEqual(result.transcript, ['Keep this transcript.']);
    if (JSON.stringify(await a.evaluate(() => boxes())) !== JSON.stringify(baseline)) t.diagnostic(JSON.stringify({ baselineLayout, failedLayout: await layout() }));
    assert.deepEqual(await a.evaluate(() => boxes()), baseline, 'fail-closed removal shifts 0 px');
    await a.evaluate(async () => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
    await a.mouse.move(-10, -10);
    const file = `ait364-${width}-light-de-failclosed.png`;
    if (evidence) { await a.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file); }
    // Blurring is only for the shot. Restore keyboard focus before revalidation.
    await a.evaluate(() => c.shadowRoot.querySelector('.concept-preview').focus());
    a.refreshFailure = null; a.holdConsentRead = false;
    await a.evaluate(() => { window.watchFailClosed = false; });
    await a.evaluate(() => clock.tick(2000));
    await a.waitForFunction(() => view.items.length === 1 && view.items[0].id === 'image');
    const recovered = await a.evaluate(() => inspect());
    assert.equal(recovered.state, 'ready'); assert.equal(recovered.notice, ''); assert.equal(recovered.focus, 'concept-preview');
    if (JSON.stringify(await a.evaluate(() => boxes())) !== JSON.stringify(baseline)) t.diagnostic(JSON.stringify({ baselineLayout, recoveredLayout: await layout() }));
    assert.deepEqual(await a.evaluate(() => boxes()), baseline, 'successful revalidation shifts 0 px');
    if (width === 1440 && evidence) {
      await a.evaluate(async () => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
      await a.mouse.move(-10, -10);
      const recoveredFile = 'ait364-1440-light-de-recovered.png';
      await a.screenshot({ path: join(evidence, recoveredFile), fullPage: false, captureBeyondViewport: false }); shots.push(recoveredFile);
    }
    if (a.heldConsentRead) { await a.heldConsentRead.continue(); a.heldConsentRead = null; }
    await a.evaluate(() => view.open('image'));
    await a.waitForFunction(() => view.dialog.open && c.shadowRoot.querySelector('.concept-image').hasAttribute('src'));
    assert.deepEqual(await a.evaluate(() => view.items.map(i => i.id)), ['image'], 'covered images reopen without reload; withdrawn HTML stays gone');
    checks.push({ width, theme: 'light', locale: 'de', kind: 'both', failure, changed, edge: 'E2', ...result, deadlineAdvancedMs: failure === 'document-stall' ? 2000 : null, movementPx: 0, recoveryMovementPx: 0, synchronousRedaction: true, viewportOnly: true, noReload: true, automaticRecovery: true, recovered, retainedOpenable: true });
  });
  const scoped = await scopedConsentEdges({ t, a, isCI, session: () => session, setSession: value => { session = value; }, setSelected: value => { selected = value; }, features, url: `http://127.0.0.1:${server.address().port}/`, evidence });
  const allChecks = [...checks.filter(c => c.edge === 'E2'), ...scoped.checks].map(check => ({ ...check, edge: check.edge ?? check.state }));
  assert.deepEqual([...new Set(allChecks.map(check => check.edge))].sort(), ['E1', 'E2', 'E3', 'E4'], 'the evidence report carries every required edge');
  assert.equal(allChecks.filter(check => check.edge === 'E2').length, 4, 'absent and unknown scope HTTP/stall results are retained');
  assert.equal(allChecks.filter(check => check.edge === 'E1').length, 3, 'both widths and both artifact kinds are retained');
  assert.ok(allChecks.every(check => check.width && check.theme && check.locale), 'every evidence entry records its display context');
  if (evidence) {
    await writeFile(join(evidence, 'ait365-checks.json'), JSON.stringify({ spec: 'AIT-365 Tick v1', shots: scoped.shots, checks: allChecks, controlledClock: true, totalWallTimeMs: performance.now() - startedAt }, null, 2));
    const report = JSON.stringify({ spec: 'AIT-364 Tick v1.1', shots, checks, controlledClock: true, totalWallTimeMs: performance.now() - startedAt }, null, 2);
    await writeFile(join(evidence, 'ait364-checks.json'), report);
    await writeFile(join(evidence, 'checks.json'), report);
  }
}
