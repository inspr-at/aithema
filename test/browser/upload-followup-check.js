import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function uploadFollowupCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
    test(`AIT-561: ${width}/${locale}/${theme} specific capacity and final failures`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-upload-followup-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      for (const scenario of ['count', 'bytes', 'purpose', 'ownership']) await t.test(scenario, async () => {
        await inShadow(page, async (c, { scenario, locale }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale;
          session.uploads = []; session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date().toISOString() }];
          session.settings.voice = 'off'; session.settings.origin = 'chosen';
          session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput'].map(key => [key, { available: true }])) };
          window.followupPosts = []; window.followupScenario = scenario;
          window.fetch = async (url, options = {}) => {
            if (String(url).endsWith('/uploads')) {
              const limits = { maxFilesPerRequest: 2, ...(scenario === 'bytes' ? { maxSessionBytes: 50 } : {}) };
              if (options.method !== 'POST') return Response.json({ limits });
              const files = options.body.getAll('files'); window.followupPosts.push(files.map(file => file.name));
              if (scenario === 'purpose' || scenario === 'ownership') return Response.json(scenario === 'purpose'
                ? { error: 'conversation-paused', reason: 'purpose' } : { error: 'not-owner' }, { status: scenario === 'purpose' ? 409 : 403 });
              // Match the pre-fix server capacity boundary after the first batches.
              return Response.json({ error: 'size-limit' }, { status: 413 });
            }
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
            return Response.json(session);
          };
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
        }, { scenario, locale });
        await startTyping(page);
        const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.send', 'textarea'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
        })));
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await settle(); const before = await boxes();
        await inShadow(page, c => {
          const transfer = new DataTransfer(), count = window.followupScenario === 'count' ? 9 : window.followupScenario === 'bytes' ? 2 : 4;
          for (let i = 0; i < count; i++) transfer.items.add(new File(['%PDF-' + 'x'.repeat(25)], `document-${i}.pdf`, { type: 'application/pdf' }));
          const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        });
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
        await settle(); const after = await boxes();
        const result = await inShadow(page, c => ({ posts: window.followupPosts, notice: c.shadowRoot.querySelector('.composer-reason').textContent }));
        const important = scenario === 'count' || scenario === 'bytes' ? result.notice
          : scenario === 'purpose' ? copy.purposePaused : locale === 'en' ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
        const visible = await inShadow(page, (c, important) => {
          const reason = c.shadowRoot.querySelector('.upload-notice-facts') ?? c.shadowRoot.querySelector('.composer-reason');
          const walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT), node = walker.nextNode();
          if (!node || !node.textContent.startsWith(important)) return { startsWith: false };
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, important.length);
          const r = reason.getBoundingClientRect(), rects = [...range.getClientRects()];
          return { startsWith: true, width: r.width, height: r.height, lines: rects.length,
            clipped: rects.some(b => b.width <= 0 || b.height <= 0 || b.top < r.top - 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1 || b.right > r.right + 1) };
        }, important);
        const evidence = process.env.AITHEMA_EVIDENCE_DIR, prefix = `ait561-${scenario}-${width}-${locale}-${theme}`;
        if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${prefix}.png`) }); await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ before, after, result, visible }, null, 2)); }
        if (scenario === 'count' || scenario === 'bytes') {
          assert.deepEqual(result.posts, []);
          assert.equal(result.notice, scenario === 'count' ? copy.uploads.tooMany.replace('{files}', '8') : copy.uploads.sessionFull.replace('{size}', '50 B'));
        } else {
          assert.equal(result.posts.length, 1);
          const failure = scenario === 'purpose' ? copy.purposePaused : locale === 'en' ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
          assert.equal(result.notice.split(failure).length - 1, 1);
          for (let i = 0; i < 4; i++) assert.equal(result.notice.split(`document-${i}.pdf`).length - 1, 1);
        }
        assert.equal(visible.startsWith, true, 'the reason precedes filenames');
        assert.ok(visible.width > 0 && visible.height > 0, 'notice has a visible box');
        assert.equal(visible.clipped, false, 'the complete reason and capacity figure fit without scrolling');
        for (const selector of Object.keys(before)) {
          assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector} visible`);
          assert.deepEqual(after[selector], before[selector], `${selector}: 0 px layout shift`);
        }
      });
    });
  }
}

// Held-image evidence uses only local protocol fixtures and synthetic consent.
export function heldUploadCheck() {
  for (const locale of ['en', 'de']) for (const scenario of ['recognised-document', 'detected-document', 'detected-refused'])
    test(`AIT-561 r2 Medium 1: 390/${locale}/${scenario} held image survives a later selection and grant`, { timeout: 90000 }, async t => {
      const theme = locale === 'en' ? 'light' : 'dark';
      const directory = await mkdtemp(join(tmpdir(), 'aithema-held-followup-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width: 390, height: 844 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await inShadow(page, async (c, { locale, scenario }) => {
        window.heldScenario = scenario; window.heldAsks = []; window.heldPosts = []; window.heldGranted = false;
        const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
        session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
        session.settings.voice = 'off'; session.settings.origin = 'chosen';
        session.featureMatrix = { best: Object.fromEntries(['text', 'uploads', 'imageInput'].map(key => [key, { available: key !== 'imageInput', reason: key === 'imageInput' ? 'current processing consent required' : null }])) };
        c.addEventListener('aithema-consent', event => { window.heldAsks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true });
        window.fetch = async (url, options = {}) => {
          if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
          if (String(url).endsWith('/uploads')) {
            if (options.method !== 'POST') return Response.json({ limits: {} });
            const files = options.body.getAll('files'); window.heldPosts.push(files.map(f => f.name)); const events = [], refused = [];
            for (const [index, file] of files.entries()) {
              const image = file.name === 'photo.png' || file.name === 'scan.pdf';
              if (image && !window.heldGranted) refused.push({ index, kind: 'image', reason: 'current processing consent required' });
              else events.push({ sessionId: session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: {
                id: file.name, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-pending' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
            }
            return Response.json({ events, refused }, { status: 202 });
          }
          if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: window.heldGranted ? ['image-input'] : [], features: { imageInput: ['image-input'] } });
          const snapshot = c.session; snapshot.featureMatrix.best.imageInput = { available: window.heldGranted, reason: window.heldGranted ? null : 'current processing consent required' }; return Response.json(snapshot);
        };
        const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
        c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
      }, { locale, scenario });
      await startTyping(page);
      const pick = files => inShadow(page, (c, files) => {
        const transfer = new DataTransfer(); for (const [name, image] of files) transfer.items.add(new File([image ? new Uint8Array([255, 216, 255, 224]) : '%PDF-fixture'], name));
        const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
      }, files);
      const heldName = scenario.startsWith('recognised') ? 'photo.png' : 'scan.pdf';
      await pick([[heldName, true]]);
      await page.waitForFunction(() => window.heldAsks.length === 1);
      const laterName = scenario.endsWith('refused') ? 'newer.exe' : 'report.pdf';
      await pick([[laterName, false]]);
      await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
      const beforeGrant = await inShadow(page, c => ({ notice: c.shadowRoot.querySelector('.composer-reason').textContent, attached: c.session.uploads.map(u => u.filename) }));
      await inShadow(page, c => {
        window.heldGranted = true;
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } });
      });
      // Bounded settling records the broken before state too, without a timeout hiding evidence.
      await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.imageInput.available);
      await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await inShadow(page, c => ({ notice: c.shadowRoot.querySelector('.composer-reason').textContent, attached: c.session.uploads.map(u => u.filename), posts: window.heldPosts }));
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        const prefix = join(process.env.AITHEMA_EVIDENCE_DIR, `ait561-held-${scenario}-390-${locale}-${theme}`);
        await page.screenshot({ path: `${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify({ beforeGrant, result }, null, 2));
      }
      assert.equal(result.attached.filter(name => name === heldName).length, 1, 'grant attaches the earlier held image exactly once');
      if (laterName === 'report.pdf') assert.ok(result.attached.includes(laterName));
      else assert.ok(result.notice.includes(laterName), 'the later refusal remains visible');
    });
}
