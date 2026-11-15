import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow, uploadChooser } from './demo-helpers.js';
import { mockConsent } from './consent-helpers.js';

// The page uses only injected intake/model fixtures; no provider is contacted.
for (const width of [390, 1024, 1440]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
  test(`AIT-510: ${width} ${locale} ${theme} fixed image tiles, refusal reasons, consent and image-only send`, { timeout: 120000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-image-input-'));
    const demo = await startDemo(directory), browser = await browserForFile();
    t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
    const page = await browser.newPage(); await preparePage(page, [locale]);
    await page.setViewport({ width, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await startTyping(page);
    await inShadow(page, async c => {
      window.imageAsks = []; window.imagePosts = []; window.imageSeq = 0;
      c.addEventListener('aithema-consent', e => window.imageAsks.push(e.detail));
      const session = structuredClone(c.session);
      session.featureMatrix.best.imageInput = { available: true, reason: null };
      session.featureMatrix.best.images = { available: true, reason: null };
      session.featureMatrix.best.uploads = { available: true, reason: null };
      session.settings.voice = 'off'; session.settings.origin = 'chosen';
      session.featureMatrix.best.voice = { available: false, reason: 'voice off' };
      session.inputRevision = 1;
      session.transcript = [{ id: 'existing-input', role: 'user', content: 'A screenshot for the project', at: new Date(0).toISOString() },
        { id: 'existing-reply', role: 'assistant', content: 'Which part should be clarified?', at: new Date(1).toISOString() }];
      const { inputRevision } = await import('/packages/core/src/session.js');
      session.understanding = { ...session.understanding, summary: 'A project screenshot', inputRevision: inputRevision(session), readinessAssessed: true };
      const fetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
        if (String(url).endsWith(`/api/sessions/${session.id}`)) return Response.json(c.session);
        if (/\/uploads$/u.test(String(url))) {
          if (options.method !== 'POST') return Response.json({ uploads: c.session.uploads });
          const files = options.body.getAll('files');
          return Response.json({ events: files.map(file => ({ sessionId: c.session.id, seq: c.session.seq + ++window.imageSeq, type: 'upload.state', data: {
            id: `fixture-${window.imageSeq}`, filename: file.name, kind: 'image', state: 'staged-pending', bytes: file.size, mediaType: 'image/png', at: new Date(0).toISOString() } })) }, { status: 202 });
        }
        if (/\/uploads\/[^/]+\/image$/u.test(String(url))) {
          (window.imageOwnerHeaders ??= []).push(new Headers(options.headers).get('x-aithema-session-token'));
          if (window.imageDelay) await window.imageDelay;
          return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } }); }
        if (/\/turns$/u.test(String(url)) && options.method === 'POST') {
          const body = JSON.parse(options.body); window.imagePosts.push(body);
          return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments, at: new Date(0).toISOString() } });
        }
        return fetch(url, options);
      };
      const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ session, copy, sessionToken: 'fixture', voiceClient: {} });
    });
    await startTyping(page);
    const choose = async () => {
      if (width === 390) {
        const path = join(directory, 'fixture.png');
        await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=', 'base64'));
        const chooser = await uploadChooser(page); await chooser.accept([path]); return;
      }
      await inShadow(page, (c, width) => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.png', { type: 'image/png' }));
      if (width === 1024) c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      else c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      }, width);
    };
    const boxes = () => inShadow(page, c => Object.fromEntries(['.band', '.audio-rail', '.attach', '.send', '.composer', ...(window.innerWidth >= 1024 ? ['.understanding', '.understanding .foot'] : [])].map(selector => {
      const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }];
    })));
    const unstaged = await boxes();
    for (const r of Object.values(unstaged)) assert.ok(r.w > 0 && r.h > 0, 'positive frame before staging');
    await choose(); await waitForShadow(page, '.staged-image');
    const before = await boxes(), changes = [];
    for (const [selector, r] of Object.entries(before)) for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h'])
      assert.ok(Math.abs(r[edge] - unstaged[selector][edge]) <= .5, `${selector}.${edge} fixed while staging`);
    for (const [selector, r] of Object.entries(before)) assert.ok(r.w > 0 && r.h > 0, `${selector} positive before`);
    const evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const prefix = `${width}-${locale}-${theme}`;
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async state => { if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) }); };
    await shot('pending');
    for (const reason of ['unsupported', 'size', 'limit', 'empty', 'malformed', 'dimensions', 'deadline', 'cancelled', 'unavailable', 'session', 'model', 'live-call', 'batch']) {
      await inShadow(page, (c, reason) => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason } });
      }, reason);
      await waitForShadow(page, '.image-refusals');
      const after = await boxes();
      for (const [selector, r] of Object.entries(after)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive after ${reason}`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - before[selector][edge]) <= .5, `${selector}.${edge} fixed after ${reason}`);
      }
      changes.push({ reason, rects: after });
      await shot(reason);
      await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals button').click());
    }
    await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } });
      c.shadowRoot.querySelector('.image-refusals button')?.click();
    });
    await shot('ready');
    if (width === 390) {
      await page.setViewport({ width, height: 530 });
      await inShadow(page, c => c.shadowRoot.querySelector('textarea').focus());
      const compact = await boxes(); for (const r of Object.values(compact)) assert.ok(r.w > 0 && r.h > 0);
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason: 'malformed' } });
      });
      const after = await boxes();
      for (const [selector, r] of Object.entries(after)) {
        assert.ok(r.w > 0 && r.h > 0);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - compact[selector][edge]) <= .5, `keyboard ${selector}.${edge}`);
      }
      const visible = await inShadow(page, c => { const el = c.shadowRoot.querySelector('.image-refusals'), r = el.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, clip: getComputedStyle(el.parentElement).clipPath }; });
      assert.ok(visible.w > 0 && visible.h > 0 && visible.top >= 0 && visible.bottom <= 530); assert.equal(visible.clip, 'none');
      changes.push({ reason: 'keyboard-malformed', rects: after }); await shot('keyboard');
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image'); c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined } }); c.shadowRoot.querySelector('.image-refusals button').click(); });
      await page.setViewport({ width, height: 900 });
    }
    assert.deepEqual(await page.evaluate(() => window.imageAsks), [], 'both image purposes granted at start: no ask');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason .consent-action') === null), true, 'no consent line');
    await inShadow(page, c => c.shadowRoot.querySelector('.send').click());
    await page.waitForFunction(() => window.imagePosts.length === 1);
    const post = await page.evaluate(() => window.imagePosts[0]); assert.equal(post.content, ''); assert.equal(post.attachments.length, 1);
    await waitForShadow(page, '.turn .image-thumbnail'); await shot('sent');
    const tileBefore = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(tileBefore.w > 0 && tileBefore.h > 0);
    await inShadow(page, async c => {
      window.imageDelay = new Promise(resolve => { window.releaseImageDelay = resolve; });
      window.imageRevocations = 0; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.imageRevocations++; revoke(url); };
      const session = c.session, { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ session, copy, sessionToken: 'fixture', voiceClient: {} });
    });
    const tileReload = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(tileReload.w > 0 && tileReload.h > 0); assert.deepEqual(tileReload, tileBefore, 'reload reserves the image box before authenticated pixels arrive');
    assert.ok(await page.evaluate(() => window.imageRevocations > 0), 'the old object URL was revoked');
    await page.evaluate(() => { window.releaseImageDelay(); window.imageDelay = null; });
    await waitForShadow(page, '.turn .image-thumbnail'); await shot('reload');
    assert.ok(await page.evaluate(() => window.imageOwnerHeaders.every(header => header === 'fixture')), 'all thumbnail requests use owner authentication');
    if (evidence) await writeFile(join(evidence, `${prefix}-rects.json`), JSON.stringify({ unstaged, before, changes, tileBefore, tileReload, after: await boxes() }, null, 2));

  });
}
