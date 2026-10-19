// AIT-369 offline cross-tab wire fixture. The actual Settings consent editor,
// session SSE consumer, preview route and rendering components run in Chrome.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, applyEvent, htmlPreviewHostPolicy } from '../../packages/core/src/index.js';
import { previewFixture } from './html-preview-route.js';
import { browserForFile } from '../browser/shared-browser.js';

export async function deliveredConsentFrames(t) {
  const root = new URL('../../', import.meta.url).pathname, streams = new Set(), preview = previewFixture();
  let session, selected, mints = 0, visualChoice, coverageList;
  const matrix = () => ({ best: Object.fromEntries(Object.entries(features).map(([kind, ids]) => [kind, ['html', 'images'].includes(kind) && (visualChoice === 'off' || visualChoice !== kind) ? { available: false, reason: visualChoice === 'off' ? 'visuals off' : 'visual kind not selected' } : ids.every(id => selected.includes(id)) ? { available: true } : { available: false, reason: 'current processing consent required' }])) });
  const features = { text: ['models'], analysis: ['models'], html: ['drafts'], images: ['images'] };
  const document = () => ({ contract: 'ait369', consentRevision: session.consentRevision, selected, features: Object.fromEntries(Object.entries(features).filter(([kind]) => !(coverageList === 'missing' && kind === 'images' && !selected.includes('images'))).map(([kind, ids]) => [kind, coverageList === 'empty' && kind === 'html' && !selected.includes('drafts') ? [] : ids])),
    items: ['models', 'drafts', 'images'].map(id => ({ id, version: 1, title: { models: 'Models', drafts: 'HTML drafts', images: 'Images' }[id], recipients: 'Offline fixture', text: 'For this conversation.' })) });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} aithema-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}</style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';
    import {ConceptView} from '/packages/ui/src/concept-view.js';
    const update=ConceptView.prototype.update;
    ConceptView.prototype.update=function(s){window.view=this;const result=update.apply(this,arguments);if(arguments[1]?.consentRevision===s.consentRevision)window.documentApplied=s.consentRevision;if(window.watching&&!this.items.some(i=>i.id==='removed')&&!window.sameTick)window.sameTick={...window.inspect(),eventToRemovalMs:performance.now()-window.eventAt,refreshRounds:window.refreshRounds};return result;};
    window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
    const params=new URLSearchParams(location.search),locale=params.get('locale')||'de';
    const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
    const c=document.createElement('aithema-session');window.c=c;
    const session=await (await fetch('/api/sessions/ait369')).json();
    c.configure({session,copy,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
    const receive=c.receive.bind(c);c.receive=event=>{if(event.type==='consent.revised'&&event.seq>c.session.seq){window.eventAt=performance.now();window.refreshRounds=0;}return receive(event);};
    const nativeFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(window.eventAt&&new URL(url,location.href).pathname==='/api/sessions/ait369')window.refreshRounds++;return nativeFetch(url,options);};
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
        const event = { seq: session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true } };
        session = applyEvent(session, event);
        session.featureMatrix = matrix();
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
      if (path.endsWith('/html')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('<!doctype html><html><body>Offline draft</body></html>'); }
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
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const configs = [
    { state: 'v1', width: 1440, kind: 'html', visuals: 'off' },
    { state: 'v1', width: 390, kind: 'html', visuals: 'off' },
    { state: 'v2', width: 1440, kind: 'html', visuals: 'images', mixed: true },
    { state: 'v3', width: 1440, kind: 'html', visuals: 'off', kept: true },
    { state: 'v4-withdrawn', width: 1440, kind: 'image', visuals: 'off' },
    { state: 'v4-html', width: 1440, kind: 'image', visuals: 'html' },
    { state: 'v4-kept', width: 1440, kind: 'image', visuals: 'off', kept: true },
    { state: 'v4-html-kept', width: 1440, kind: 'image', visuals: 'html', kept: true },
    { state: 'empty-list', width: 1440, kind: 'html', visuals: 'off', list: 'empty' },
    { state: 'missing-list', width: 1440, kind: 'image', visuals: 'html', list: 'missing' },
  ];
  for (const config of configs) await t.test(`${config.state}/${config.width}`, async () => {
    const { width, kind, visuals, mixed, kept } = config;
    visualChoice = visuals; coverageList = config.list;
    session = createSession({ demo: true }); session.id = 'ait369'; session.locale = 'de'; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.visuals = visuals; session.visualsBound = true;
    session.conceptVisualKind = visuals === 'images' ? 'image' : 'html'; session.conceptCost = { maxMicro: 0 };
    session.transcript = [{ id: 'source', role: 'user', content: 'Keep this transcript.' }]; session.inputRevision = 1;
    const artifact = (id, type) => ({ id, mediaType: type === 'html' ? 'text/html' : 'image/png', turnIds: ['source'], referenceIds: [], feedback: { vote: 'clear', chips: [] } });
    session.concepts = [...(mixed ? [artifact('retained', 'image')] : []), artifact('removed', kind)]; session.conceptStatus = { phase: 'ready' };
    selected = ['models', 'drafts', 'images']; session.featureMatrix = matrix(); mints = 0;
    const url = `http://127.0.0.1:${server.address().port}/?locale=de&theme=light`;
    await a.setViewport({ width, height: 900 });
    for (const page of [a, b]) { await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.goto(url); await page.waitForFunction(() => window.ready); }
    await a.evaluate(async () => { c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas(); view.open('removed'); });
    if (kind === 'html') await a.waitForFunction(() => [...c.shadowRoot.querySelectorAll('aithema-html-preview')].every(p => p.state === 'ready'));
    else await a.waitForFunction(() => c.shadowRoot.querySelector('.concept-image').hasAttribute('src') && c.shadowRoot.querySelector('.canvas-image').hasAttribute('src'));
    const baseline = await a.evaluate(() => boxes());
    await a.evaluate(() => {
      window.downloads = []; HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
      window.samples = []; window.sampling = true;
      const sample = () => { if (!sampling) return; samples.push(inspect()); requestAnimationFrame(sample); }; requestAnimationFrame(sample);
      window.watching = true;
    });
    await b.evaluate(() => view.consent(c.shadowRoot.querySelector('.concept-preview')));
    await b.waitForFunction(() => c.shadowRoot.querySelector('.consent-items input[value="drafts"]'));
    await b.evaluate(({ kind, kept }) => { if (!kept) c.shadowRoot.querySelector('.consent-items input[value="' + (kind === 'html' ? 'drafts' : 'images') + '"]').click(); c.shadowRoot.querySelector('.done').click(); }, { kind, kept });
    await a.waitForFunction(() => c.session.consentRevision === 2);
    // Consent document application may follow the snapshot on the next await.
    if (!kept) await a.waitForFunction(() => window.sameTick, { timeout: 2500 });
    else await a.waitForFunction(() => window.documentApplied === 2);
    await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await a.evaluate(() => { sampling = false; return { ...inspect(), samples, sameTick: window.sameTick, refreshRounds }; });
    assert.deepEqual(await a.evaluate(() => boxes()), baseline, '0 px for thread, composer, rail, header, access and canvas');
    if (kept) {
      assert.ok(result.samples.length > 0, 'sample every animation frame through refresh');
      for (const sample of result.samples) {
        assert.deepEqual(sample.ids, ['removed']); assert.equal(sample.open, true); assert.equal(sample.notice, '');
        if (kind === 'html') { assert.equal(sample.iframeCount, 2); assert.ok(sample.frames.includes('removed')); }
        else assert.ok(sample.images.includes('removed'));
      }
      assert.equal(result.notice, ''); assert.deepEqual(result.ids, ['removed']);
      await a.evaluate(() => view.download());
      assert.equal(await a.evaluate(() => downloads.length), 1, 'covered download remains usable');
    } else {
      assert.equal(result.open, false); assert.equal(result.iframeCount, 0);
      assert.equal(result.frames.includes('removed'), false); assert.equal(result.images.includes('removed'), false);
      assert.equal(result.focus, 'concept-preview');
      assert.equal(result.notice, width === 390 ? 'Entwurf entfernt' : kind === 'html' ? 'Entwurf entfernt. Die Einwilligung für Entwürfe wurde widerrufen.' : 'Bild entfernt. Die Einwilligung für Bilder wurde widerrufen.');
      assert.deepEqual(result.ids, mixed ? ['retained'] : []);
      assert.ok(result.sameTick.eventToRemovalMs < 2000, 'redacted within the successful refresh, under fail-closed deadline');
      assert.equal(await a.evaluate(() => view.load('removed')), null);
      await a.evaluate(() => view.download()); assert.equal(await a.evaluate(() => downloads.length), 0);
      await a.evaluate(() => view.open('removed')); assert.equal(await a.evaluate(() => view.dialog.open), false);
      if (mixed) {
        await a.evaluate(() => view.open('retained'));
        assert.equal(await a.evaluate(() => view.dialog.open), true);
        await a.evaluate(() => view.close());
      }
    }
    // Settled, pinned fonts, reduced motion, viewport capture, no focus-ring residue.
    await a.evaluate(async () => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
    await a.mouse.move(-10, -10);
    if (evidence) { const file = `ait369-${width}-light-de-${config.state}.png`; await a.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); shots.push(file); }
    checks.push({ ...config, ...result, movementPx: 0, keptSampledEveryFrame: Boolean(kept), downloadChecked: true, viewportOnly: true });
  });
  if (evidence) await writeFile(join(evidence, 'ait369-checks.json'), JSON.stringify({ shots, checks,
    unit: 'AIT-369: empty/missing coverage for both kinds across off/images/html/both; kept coverage across all choices',
    server: 'AIT-369 API: producing-option and legacy preset-kind scopes across off/images/html/both',
    regression: 'AIT-364 assertions unchanged; AIT-365 when merged', offline: true }, null, 2));
}
