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

export async function partialConsentFrames(t) {
  const root = new URL('../../', import.meta.url).pathname, streams = new Set(), preview = previewFixture();
  let session, selected, mints = 0;
  const features = { text: ['models'], analysis: ['models'], html: ['drafts'], images: ['images'] };
  const document = () => ({ contract: 'ait364', consentRevision: session.consentRevision, selected, features,
    items: ['models', 'drafts', 'images'].map(id => ({ id, version: 1, title: { models: 'Models', drafts: 'HTML drafts', images: 'Images' }[id], recipients: 'Offline fixture', text: 'For this conversation.' })) });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} aithema-session{--aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif}</style></head><body><script type="module">
    import '/packages/ui/src/session-element.js';
    import {ConceptView} from '/packages/ui/src/concept-view.js';
    const update=ConceptView.prototype.update;
    ConceptView.prototype.update=function(s){window.view=this;const result=update.call(this,s);if(window.watching&&s.featureMatrix.best[window.removedFeature]?.reason==='current processing consent required')window.sameTick=window.inspect();return result;};
    window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
    const params=new URLSearchParams(location.search),locale=params.get('locale')||'de';
    const {[locale]:copy}=await import('/packages/ui/src/i18n/'+locale+'.js');
    const c=document.createElement('aithema-session');window.c=c;
    const session=await (await fetch('/api/sessions/ait364')).json();
    c.configure({session,copy,sessionToken:'fixture-owner',concepts:{previewURL:location.origin+'/_aithema/html-preview'}});
    c.setAttribute('theme',params.get('theme')||'light');c.setAttribute('motion','off');document.documentElement.lang=locale;document.body.append(c);
    window.boxes=()=>Object.fromEntries(['.transcript-shell','.composer','.concept-rail','.band','.concept-access','.drafts-canvas'].map(s=>{const b=c.shadowRoot.querySelector(s).getBoundingClientRect();return[s,[b.x,b.y,b.width,b.height]];}));
    window.inspect=()=>{const r=c.shadowRoot;return {open:window.view.dialog.open,ids:window.view.items.map(i=>i.id),frames:[...r.querySelectorAll('aithema-html-preview')].filter(n=>n.artifact).map(n=>n.dataset.id),images:[...r.querySelectorAll('img[src]')].map(n=>n.dataset.id),focus:r.activeElement?.className,notice:r.querySelector('.concept-withdrawn').textContent,live:r.querySelector('.concept-withdrawn').getAttribute('aria-live'),state:r.querySelector('.concept-access').dataset.state,tooltip:r.querySelector('.concept-backdrop-hint').hasAttribute('data-show'),revoked:window.revoked,transcript:c.session.transcript.map(t=>t.content)};};
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
    await a.evaluate(async () => { c.shadowRoot.querySelector('.fold').click(); await view.paintCanvas(); c.shadowRoot.querySelector('.concept-preview').focus(); view.open('removed'); });
    if (kind === 'html') await a.waitForFunction(() => [...c.shadowRoot.querySelectorAll('aithema-html-preview')].every(p => p.state === 'ready'));
    else await a.waitForFunction(() => c.shadowRoot.querySelector('.concept-image').hasAttribute('src'));
    const baseline = await a.evaluate(() => boxes());
    const beforeMints = mints;
    await a.evaluate(feature => { window.removedFeature = feature; window.watching = true; window.noticeChanges = []; new MutationObserver(() => noticeChanges.push(c.shadowRoot.querySelector('.concept-withdrawn').textContent)).observe(c.shadowRoot.querySelector('.concept-withdrawn'), { childList: true, subtree: true, characterData: true }); }, feature);
    // B uses the real Settings dialog and save action. A receives SSE, never reloads.
    await b.evaluate(() => { c.shadowRoot.querySelector('.settings-open').click(); c.shadowRoot.querySelector('[data-tab="general"]').click(); c.shadowRoot.querySelector('.general-consent-manage').click(); });
    await b.waitForFunction(() => c.shadowRoot.querySelector('.consent-items input[value="drafts"]'));
    await b.evaluate(kind => { c.shadowRoot.querySelector('.consent-items input[value="' + (kind === 'html' ? 'drafts' : 'images') + '"]').click(); c.shadowRoot.querySelector('.done').click(); }, kind);
    await a.waitForFunction(() => window.sameTick, { timeout: 5000 });
    const result = await a.evaluate(() => sameTick);
    assert.equal(result.open, false, 'W1 viewer closes in the update tick');
    assert.equal(result.frames.includes('removed'), false, 'W2 no revoked frame artifact');
    assert.equal(result.images.includes('removed'), false, 'no revoked thumbnail/backdrop/viewer/canvas bytes');
    assert.equal(result.tooltip, false);
    assert.equal(result.focus, 'concept-preview', 'focus returns to concept access control');
    assert.deepEqual(result.ids, mixed ? ['retained'] : []);
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
    await capture(kind === 'html' ? 'w1-w2-w3' : 'images-w1-w3');
    if (!mixed) {
      assert.equal(await a.evaluate(() => c.shadowRoot.querySelector('.canvas-empty').hidden), false);
      if (width === 1440 && theme === 'light' && locale === 'de') {
        await a.waitForFunction(() => !c.shadowRoot.querySelector('.concept-withdrawn').textContent, { timeout: 5500 });
        const after = await a.evaluate(() => ({ state: inspect().state, text: c.shadowRoot.querySelector('.concept-activity-text').textContent, announcements: noticeChanges.filter(Boolean) }));
        assert.equal(after.state, 'consent'); assert.match(after.text, new RegExp(kind === 'html' ? 'Entwürfe brauchen Ihre Einwilligung' : 'Bilder brauchen Ihre Einwilligung'));
        assert.deepEqual(after.announcements, [copy], 'notice announced once');
        assert.deepEqual(await a.evaluate(() => boxes()), baseline); await capture(kind + '-w4');
      }
    } else {
      await a.evaluate(() => view.open('retained'));
      assert.equal(await a.evaluate(() => view.dialog.open), true);
      assert.equal(await a.evaluate(() => c.shadowRoot.querySelector('.concept-count').textContent), locale === 'en' ? '1 of 1' : '1 von 1');
    }
    if (kind === 'html') assert.equal(mints, beforeMints, 'no preview mint retries after the removed scope');
    checks.push({ ...config, ...result, movementPx: 0, synchronousRedaction: true, viewportOnly: true, noReload: true });
  });
  if (evidence) await writeFile(join(evidence, 'ait364-checks.json'), JSON.stringify({ shots, checks }, null, 2));
}
