import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';
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
        if (/\/uploads\/[^/]+\/image$/u.test(String(url))) return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
        if (/\/turns$/u.test(String(url)) && options.method === 'POST') {
          const body = JSON.parse(options.body); window.imagePosts.push(body);
          return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments, at: new Date(0).toISOString() } });
        }
        return fetch(url, options);
      };
      const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ session, copy, sessionToken: 'fixture' });
    });
    await startTyping(page);
    const choose = () => inShadow(page, c => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.png', { type: 'image/png' }));
      const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    });
    await choose(); await waitForShadow(page, '.staged-image');
    const boxes = () => inShadow(page, c => Object.fromEntries(['.band', '.attach', '.send', '.composer'].map(selector => {
      const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }];
    })));
    const before = await boxes();
    for (const [selector, r] of Object.entries(before)) assert.ok(r.w > 0 && r.h > 0, `${selector} positive before`);
    const evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const prefix = `${width}-${locale}-${theme}`;
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async state => { if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) }); };
    await shot('pending');
    for (const reason of ['unsupported', 'size', 'limit', 'empty', 'malformed', 'dimensions', 'deadline', 'cancelled', 'unavailable']) {
      await inShadow(page, (c, reason) => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason } });
      }, reason);
      await waitForShadow(page, '.image-refusals');
      const after = await boxes();
      for (const [selector, r] of Object.entries(after)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive after ${reason}`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - before[selector][edge]) <= .5, `${selector}.${edge} fixed after ${reason}`);
      }
      await shot(reason);
    }
    await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } });
      c.shadowRoot.querySelector('.image-refusals button')?.click();
    });
    await shot('ready');
    assert.deepEqual(await page.evaluate(() => window.imageAsks), [], 'both image purposes granted at start: no ask');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason .consent-action') === null), true, 'no consent line');
    await inShadow(page, c => c.shadowRoot.querySelector('.send').click());
    await page.waitForFunction(() => window.imagePosts.length === 1);
    const post = await page.evaluate(() => window.imagePosts[0]); assert.equal(post.content, ''); assert.equal(post.attachments.length, 1);
    await waitForShadow(page, '.turn .image-thumbnail'); await shot('sent');
    if (evidence) await writeFile(join(evidence, `${prefix}-rects.json`), JSON.stringify({ before, after: await boxes() }, null, 2));
    if (width === 390) {
      await page.setViewport({ width, height: 530 });
      await inShadow(page, c => c.shadowRoot.querySelector('textarea').focus());
      const short = await boxes(); for (const r of Object.values(short)) assert.ok(r.w > 0 && r.h > 0);
      await shot('keyboard');
    }
  });
}
