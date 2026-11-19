import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { SQLiteStorage, createUploadHandlers, readBody } from '../../packages/server/src/index.js';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function mixedUploadCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
    test(`AIT-559: ${width}/${locale}/${theme} mixed intake never loses documents or per-file refusals`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-mixed-upload-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      let intake;
      const closeIntake = async () => { if (intake) { await intake.handlers.close(); intake.storage.close(); intake = null; } };
      t.after(async () => { await closeIntake(); await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      // The browser submits real multipart files through the production handler
      // and storage. Only availability and extraction are fixture ports.
      await page.exposeFunction('mixedConfigure', async (host, reason) => {
        await closeIntake();
        const storage = new SQLiteStorage(':memory:'), session = storage.create({ ownerToken: 'fixture', demo: true, locale });
        const state = { storage, session, host, reason, granted: false };
        state.handlers = createUploadHandlers({ storage,
          runtime: {
            uploadAvailability: async () => ({}),
            imageInputAvailability: async () => ({ reason: state.granted || host.endsWith('limit') ? null : reason }),
            extractUpload: async () => ({ status: 'accepted', text: 'Document fixture', truncated: false }),
            normalizeImageUpload: async () => ({ status: 'staged-ready', bytes: Buffer.from('normalized fixture'), mediaType: 'image/png', w: 1, h: 1 }),
          }, ownership: { token: () => 'fixture' }, readBody, publish() {}, onInput() {}, onWithdraw() {}, signal: new AbortController().signal,
          limits: { maxFilesPerRequest: host === 'default-batches' ? 8 : 2, maxImagesPerSession: host.endsWith('limit') ? 1 : 8 } });
        if (host.endsWith('limit')) storage.postUploads(session.id, 'already-sent', 'already-sent', [{ kind: 'image', filename: 'earlier.png', mediaType: 'image/png', bytes: Buffer.from('fixture'), deadlineAt: Date.now() + 25000 }], { maxImagesPerSession: 1 });
        intake = state;
        return storage.get(session.id);
      });
      await page.exposeFunction('mixedUpload', async ({ files, clientEventId }) => {
        const form = new FormData(), before = intake.storage.get(intake.session.id).seq;
        form.append('clientEventId', clientEventId);
        for (const file of files) form.append('files', new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
        let response;
        try { response = await intake.handlers.handle(new Request(`http://localhost/api/sessions/${intake.session.id}/uploads`, { method: 'POST', body: form })); }
        catch (error) {
          // Match createHandlers' existing storage-capacity HTTP boundary.
          if (!(error instanceof RangeError)) throw error;
          response = Response.json({ error: 'size-limit' }, { status: 413 });
        }
        const body = await response.json();
        await intake.handlers.idle();
        if (response.ok) body.events = intake.storage.read(intake.session.id, before);
        return { status: response.status, body };
      });
      await page.exposeFunction('mixedGrant', () => {
        intake.granted = true;
        return intake.storage.reviseConsent(intake.session.id, true, {}, { conversationUnchanged: true, changed: ['imageInput'] });
      });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await startTyping(page);
      const evidence = process.env.AITHEMA_EVIDENCE_DIR;
      if (evidence) await mkdir(evidence, { recursive: true });
      for (const [host, reason] of [['document-only', 'image normalizer not configured'], ['default-batches', 'image normalizer not configured'], ['text-binding', 'image input not supported'],
        ['consent', 'current processing consent required'], ['normalizer', 'image normalizer unavailable'], ['limit', 'limit'], ['recognised-limit', 'limit']]) {
        await t.test(host, async () => {
          await inShadow(page, async (c, { host, reason }) => {
            window.mixedPosts = []; window.mixedAsks = []; window.mixedGranted = false; window.mixedHost = host;
            const session = await window.mixedConfigure(host, reason);
            session.settings.voice = 'off'; session.settings.origin = 'chosen';
            if (host.endsWith('limit')) session.uploads[0].state = 'sent';
            session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'uploads'].map(key => [key, { available: true }]));
            session.featureMatrix.best.imageInput = { available: host.endsWith('limit'), reason: host.endsWith('limit') ? null : reason };
            c.addEventListener('aithema-consent', event => { window.mixedAsks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true, once: true });
            window.fetch = async (url, options = {}) => {
              if (String(url).endsWith('/uploads')) {
                if (options.method !== 'POST') return Response.json({ uploads: c.session.uploads, limits: { maxFilesPerRequest: host === 'default-batches' ? 8 : 2, maxImagesPerSession: host.endsWith('limit') ? 1 : 8 } });
                const files = options.body.getAll('files');
                window.mixedPosts.push(files.map(file => file.name));
                const result = await window.mixedUpload({ clientEventId: options.body.get('clientEventId'),
                  files: await Promise.all(files.map(async file => ({ name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] }))) });
                return Response.json(result.body, { status: result.status });
              }
              if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
              if (String(url).endsWith('/consent')) return Response.json({ selected: window.mixedGranted ? ['image-input'] : [], features: { imageInput: ['image-input'] } });
              const snapshot = c.session;
              if (window.mixedGranted) snapshot.featureMatrix.best.imageInput = { available: true, reason: null };
              return Response.json(snapshot);
            };
            const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
            c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
          }, { host, reason });
          await startTyping(page);
          const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.send', 'textarea'].map(selector => {
            const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
            return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
          })));
          await settle(); const before = await boxes();
          const prefix = `ait559-${host}-${width}-${locale}-${theme}`;
          if (evidence) await page.screenshot({ path: join(evidence, `${prefix}-before.png`) });
          await inShadow(page, c => {
            const transfer = new DataTransfer();
            const picks = window.mixedHost === 'default-batches' ? [['scan.pdf', 'application/pdf'], ...Array.from({ length: 8 }, (_, index) => [`eligible-${index}.pdf`, 'application/pdf'])] : window.mixedHost === 'recognised-limit' ? [['first.png', 'image/png'], ['excess.png', 'image/png'], ['eligible.pdf', 'application/pdf'], ['eligible-later.pdf', 'application/pdf'], ['eligible-final.pdf', 'application/pdf']] : [['clipboard', 'application/octet-stream'], ['eligible.pdf', 'application/pdf'], ['typed.pdf', 'image/png'], ['eligible-typed.pdf', 'application/pdf'], ['scan.pdf', 'application/pdf'], ['eligible-later.pdf', 'application/pdf']];
            for (const [name, type] of picks) transfer.items.add(new File([name === 'scan.pdf' ? new Uint8Array([255, 216, 255, 224, 0, 0]) : name.startsWith('eligible') ? '%PDF-fixture' : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type }));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          });
          await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
          await settle(); const after = await boxes();
          const result = await inShadow(page, c => ({ posts: window.mixedPosts, asks: window.mixedAsks.map(ask => ask.features),
            documents: c.session.uploads.filter(upload => upload.kind !== 'image').map(upload => upload.filename),
            notice: c.shadowRoot.querySelector('.composer-reason').textContent,
            refusals: [...c.shadowRoot.querySelectorAll('.image-refusal')].map(row => row.textContent), consent: Boolean(c.shadowRoot.querySelector('.consent-action')) }));
          if (evidence) {
            await page.screenshot({ path: join(evidence, `${prefix}-after.png`) });
            await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ before, after, result }, null, 2));
          }
          assert.deepEqual(result.posts, host === 'default-batches' ? [['scan.pdf', ...Array.from({ length: 7 }, (_, index) => `eligible-${index}.pdf`)], ['eligible-7.pdf']] : host === 'recognised-limit' ? [['eligible.pdf', 'eligible-later.pdf'], ['eligible-final.pdf']] : [['clipboard', 'eligible.pdf'], ['typed.pdf', 'eligible-typed.pdf'], ['scan.pdf', 'eligible-later.pdf']], 'later batches sent');
          assert.deepEqual(result.documents, host === 'default-batches' ? Array.from({ length: 8 }, (_, index) => `eligible-${index}.pdf`) : host === 'recognised-limit' ? ['eligible.pdf', 'eligible-later.pdf', 'eligible-final.pdf'] : ['eligible.pdf', 'eligible-typed.pdf', 'eligible-later.pdf']);
          if (host === 'consent') { assert.deepEqual(result.asks, [['imageInput']]); assert.equal(result.consent, true); }
          else if (host.endsWith('limit')) assert.deepEqual(result.refusals, (host === 'recognised-limit' ? ['first.png', 'excess.png'] : ['clipboard', 'typed.pdf', 'scan.pdf']).map(name => `${name}: ${copy.imageRefusals.limit}`));
          else assert.equal(result.notice, copy.uploads.refused.replace('{list}', (host === 'default-batches' ? ['scan.pdf'] : ['clipboard', 'typed.pdf', 'scan.pdf']).map(name => copy.uploads.type.replace('{name}', name)).join(', ')));
          for (const selector of Object.keys(before)) {
            assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector} is visible`);
            assert.deepEqual(after[selector], before[selector], `${selector}: 0 px layout shift`);
          }
          if (host === 'consent') {
            await inShadow(page, async c => { window.mixedGranted = true; c.receive(await window.mixedGrant()); });
            await page.waitForFunction(() => window.mixedPosts.length === 5);
            assert.deepEqual(await page.evaluate(() => window.mixedPosts.slice(3)), [['clipboard', 'typed.pdf'], ['scan.pdf']]);
          }
        });
      }
    });
  }
}
