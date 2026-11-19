import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function mixedUploadCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
    test(`AIT-559: ${width}/${locale}/${theme} mixed intake never loses documents or per-file refusals`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-mixed-upload-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await startTyping(page);
      await inShadow(page, c => { window.mixedInitial = structuredClone(c.session); });
      const evidence = process.env.AITHEMA_EVIDENCE_DIR;
      if (evidence) await mkdir(evidence, { recursive: true });
      for (const [host, reason] of [['document-only', 'image normalizer not configured'], ['text-binding', 'image input not supported'],
        ['consent', 'current processing consent required'], ['normalizer', 'image normalizer unavailable'], ['limit', 'limit']]) {
        await t.test(host, async () => {
          await inShadow(page, async (c, { host, reason }) => {
            window.mixedPosts = []; window.mixedAsks = []; window.mixedGranted = false;
            const session = structuredClone(window.mixedInitial); session.uploads = [];
            session.settings.voice = 'off'; session.settings.origin = 'chosen';
            session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'uploads'].map(key => [key, { available: true }]));
            session.featureMatrix.best.imageInput = { available: host === 'limit', reason: host === 'limit' ? null : reason };
            c.addEventListener('aithema-consent', event => { window.mixedAsks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true, once: true });
            window.fetch = async (url, options = {}) => {
              if (String(url).endsWith('/uploads')) {
                if (options.method !== 'POST') return Response.json({ uploads: c.session.uploads, limits: { maxFilesPerRequest: 2, maxImagesPerSession: host === 'limit' ? 1 : 8 } });
                const files = options.body.getAll('files'), events = [], refused = [];
                window.mixedPosts.push(files.map(file => file.name));
                for (const [index, file] of files.entries()) {
                  const image = !file.name.startsWith('eligible');
                  if (image && !window.mixedGranted) refused.push({ index, name: file.name, kind: 'image', reason });
                  else events.push({ sessionId: session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: {
                    id: `mixed-${file.name}`, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-pending' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
                }
                return Response.json({ events, refused }, { status: 202 });
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
            for (const [name, type] of [['clipboard', 'application/octet-stream'], ['eligible.pdf', 'application/pdf'], ['typed.pdf', 'image/png'], ['eligible-typed.pdf', 'application/pdf'], ['scan.pdf', 'application/pdf'], ['eligible-later.pdf', 'application/pdf']]) transfer.items.add(new File([name === 'scan.pdf' ? new Uint8Array([255, 216, 255, 224, 0, 0]) : name.startsWith('eligible') ? '%PDF-fixture' : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type }));
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
          assert.deepEqual(result.posts, [['clipboard', 'eligible.pdf'], ['typed.pdf', 'eligible-typed.pdf'], ['scan.pdf', 'eligible-later.pdf']], 'later batches sent');
          assert.deepEqual(result.documents, ['eligible.pdf', 'eligible-typed.pdf', 'eligible-later.pdf']);
          if (host === 'consent') { assert.deepEqual(result.asks, [['imageInput']]); assert.equal(result.consent, true); }
          else if (host === 'limit') assert.deepEqual(result.refusals, ['clipboard', 'typed.pdf', 'scan.pdf'].map(name => `${name}: ${copy.imageRefusals.limit}`));
          else assert.equal(result.notice, copy.uploads.refused.replace('{list}', ['clipboard', 'typed.pdf', 'scan.pdf'].map(name => copy.uploads.type.replace('{name}', name)).join(', ')));
          for (const selector of Object.keys(before)) {
            assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector} is visible`);
            assert.deepEqual(after[selector], before[selector], `${selector}: 0 px layout shift`);
          }
          if (host === 'consent') {
            await inShadow(page, c => { window.mixedGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); });
            await page.waitForFunction(() => window.mixedPosts.length === 5);
            assert.deepEqual(await page.evaluate(() => window.mixedPosts.slice(3)), [['clipboard', 'typed.pdf'], ['scan.pdf']]);
          }
        });
      }
    });
  }
}
