import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

// Inspect all live text, including lines outside the slot's first viewport.
// Overflow is accepted only in a focusable scroll port that can reach each rect.
function feedbackVisibility(c) {
  const slot = c.shadowRoot.querySelector('.composer-feedback'), reason = slot.querySelector('.composer-reason'), bounds = slot.getBoundingClientRect();
  const box = r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height });
  const outside = (r, b) => r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1;
  const ports = [slot, reason, ...reason.querySelectorAll('*')].filter(e => /auto|scroll/u.test(getComputedStyle(e).overflowY) && e.tabIndex >= 0);
  const texts = [], imageBottoms = [], heldTops = [], walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) continue; // Responsive alternatives with display:none have no painted rect.
    if (node.parentElement.closest('.held-upload-images')) imageBottoms.push(...rects.map(r => r.bottom));
    if (node.parentElement.closest('.held-upload-consent')) heldTops.push(...rects.map(r => r.top));
    const port = ports.find(p => p.contains(node)), pr = port?.getBoundingClientRect();
    texts.push({ text: node.textContent, rects: rects.map(box), outside: rects.some(r => outside(r, bounds)),
      reachable: rects.every(r => !outside(r, bounds) || Boolean(port && pr.width > 0 && pr.height > 0 &&
        pr.top >= bounds.top - 1 && pr.bottom <= bounds.bottom + 1 &&
        r.left >= pr.left - 1 && r.right <= pr.right + 1 &&
        r.top >= pr.top - port.scrollTop - 1 && r.bottom <= pr.top - port.scrollTop + port.scrollHeight + 1)) });
  }
  const action = reason.querySelector('.held-upload-consent .consent-action') ?? reason.querySelector('.consent-action');
  let treatment = null;
  if (action) {
    const css = getComputedStyle(action), r = action.getBoundingClientRect();
    let parent = action.parentElement;
    while (parent !== slot && !/auto|scroll/u.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    const p = parent.getBoundingClientRect();
    treatment = { decoration: css.textDecorationLine, colour: css.color, parentColour: getComputedStyle(action.parentElement).color, offset: css.textUnderlineOffset,
      underlineClipped: r.bottom + 3 > p.bottom + 1 && parent.scrollHeight <= parent.clientHeight };
  }
  const heldGap = imageBottoms.length && heldTops.length ? Math.min(...heldTops) - Math.max(...imageBottoms) : 0;
  const slotOverflow = slot.scrollHeight > slot.clientHeight + 1;
  return { slot: box(bounds), scrollHeight: slot.scrollHeight, clientHeight: slot.clientHeight, slotOverflow, texts, action: treatment, heldGap,
    ports: ports.map(p => ({ className: p.className, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, tabIndex: p.tabIndex })),
    unreachable: texts.some(t => !t.reachable) || slotOverflow && !ports.some(p => p === slot) };
}

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
          : scenario === 'purpose' ? copy.purposePaused.split('. ')[0] + '.' : locale === 'en' ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
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
  for (const locale of ['en', 'de']) for (const scenario of ['recognised-document', 'detected-document', 'recognised-refused', 'detected-refused'])
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
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
        const context = canvas.getContext('2d'); context.fillStyle = '#0f766e'; context.fillRect(0, 0, 64, 32);
        window.heldPNG = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
        const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
        session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
        session.settings.voice = 'off'; session.settings.origin = 'chosen';
        session.featureMatrix = { best: Object.fromEntries(['text', 'uploads', 'imageInput'].map(key => [key, { available: key !== 'imageInput', reason: key === 'imageInput' ? 'current processing consent required' : null }])) };
        c.addEventListener('aithema-consent', event => { window.heldAsks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true });
        window.fetch = async (url, options = {}) => {
          if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
          if (/\/uploads\/[^/]+\/image$/u.test(String(url))) return new Response(window.heldPNG, { headers: { 'content-type': 'image/png' } });
          if (String(url).endsWith('/uploads')) {
            if (options.method !== 'POST') return Response.json({ limits: {} });
            const files = options.body.getAll('files'); window.heldPosts.push(files.map(f => f.name)); const events = [], refused = [];
            for (const [index, file] of files.entries()) {
              const image = file.name === 'photo.png' || file.name === 'scan.pdf';
              if (image && !window.heldGranted) refused.push({ index, kind: 'image', reason: 'current processing consent required' });
              else events.push({ sessionId: session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: {
                id: file.name, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-ready' : 'accepted', ...(image ? { mediaType: 'image/png', w: 64, h: 32, digest: 'fixture' } : {}), bytes: file.size, at: new Date(0).toISOString() } });
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
      await inShadow(page, async c => { await Promise.all([...c.shadowRoot.querySelectorAll('.image-thumbnail')].map(img => img.decode().catch(() => {}))); });
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

export function heldConsentFollowupCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) for (const entrance of ['choice', 'combined'])
    test(`AIT-563: ${width}/${locale}/${entrance} held consent and current feedback`, { timeout: 120000 }, async t => {
      const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
      const directory = await mkdtemp(join(tmpdir(), 'aithema-held-consent-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900, hasTouch: width === 390 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      for (const scenario of ['refused', 'count', 'bytes', 'repick', 'cleared-grant', 'cleared-expiry']) await t.test(scenario, async () => {
        await inShadow(page, async (c, { locale, entrance, scenario }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
          session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
          session.settings.voice = 'off'; session.settings.origin = 'chosen';
          session.featureMatrix = { best: Object.fromEntries(['text', 'uploads', 'imageInput'].map(key => [key, { available: key !== 'imageInput', reason: key === 'imageInput' ? 'current processing consent required' : null }])) };
          window.heldGranted = false; window.heldAsks = []; window.heldPosts = []; window.heldTimers = []; window.heldReceipt = 0;
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
          canvas.getContext('2d').fillRect(0, 0, 64, 32);
          window.heldPNG = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
          if (!window.heldSchedule) {
            window.heldSchedule = window.setTimeout;
            window.setTimeout = (callback, delay, ...args) => {
              if (delay === 180000) { window.heldTimers.push(callback); return window.heldSchedule(() => {}, delay); }
              return window.heldSchedule(callback, delay, ...args);
            };
            c.addEventListener('aithema-consent', event => { window.heldAsks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true });
          }
          window.fetch = async (url, options = {}) => {
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
            if (/\/uploads\/[^/]+\/image$/u.test(String(url))) return new Response(window.heldPNG, { headers: { 'content-type': 'image/png' } });
            if (String(url).endsWith('/uploads')) {
              if (options.method !== 'POST') return Response.json({ limits: scenario === 'bytes' ? { maxSessionBytes: 50 } : {} });
              const files = options.body.getAll('files'), events = [], refused = []; window.heldPosts.push(files.map(f => f.name));
              for (const [index, file] of files.entries()) {
                if (file.name === 'scan.pdf' && !window.heldGranted) refused.push({ index, kind: 'image', reason: 'current processing consent required' });
                else events.push({ sessionId: session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: {
                  id: `receipt-${++window.heldReceipt}`, filename: file.name, kind: file.name === 'scan.pdf' ? 'image' : 'document', state: file.name === 'scan.pdf' ? 'staged-ready' : 'accepted', ...(file.name === 'scan.pdf' ? { mediaType: 'image/png', w: 64, h: 32, digest: 'fixture' } : {}), bytes: file.size, at: new Date(0).toISOString() } });
              }
              return Response.json({ events, refused }, { status: 202 });
            }
            if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: window.heldGranted ? ['image-input'] : [], features: { imageInput: ['image-input'] } });
            const snapshot = c.session; snapshot.featureMatrix.best.imageInput = { available: window.heldGranted, reason: window.heldGranted ? null : 'current processing consent required' }; return Response.json(snapshot);
          };
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          c.configure({ session, copy, entrance, sessionToken: 'fixture', voiceClient: {} });
        }, { locale, entrance, scenario });
        await startTyping(page);
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.send', 'textarea', '.composer-feedback'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
        })));
        const pick = async names => {
          await inShadow(page, (c, names) => {
            const transfer = new DataTransfer();
            for (const name of names) transfer.items.add(new File([name === 'scan.pdf' ? new Uint8Array([255, 216, 255, 224]) : '%PDF-' + 'x'.repeat(25)], name, { lastModified: 1234 }));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          }, names);
          await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
          await settle();
        };
        await settle(); const before = await boxes();
        await pick(scenario.startsWith('cleared') ? ['scan.pdf', 'older.exe'] : ['scan.pdf']);
        await page.waitForFunction(() => window.heldAsks.length > 0);
        if (scenario === 'repick') await pick(['scan.pdf']);
        else if (scenario === 'count') await pick(Array.from({ length: 9 }, (_, i) => `document-${i}.pdf`));
        else if (scenario === 'bytes') await pick(['first.pdf', 'second.pdf']);
        else if (scenario.startsWith('cleared')) await pick(['report.pdf']);
        else await pick(['newer.exe']);
        if (scenario === 'cleared-expiry') await page.evaluate(() => window.heldTimers.at(-1)());
        if (scenario === 'repick' || scenario === 'cleared-grant') {
          await inShadow(page, c => {
            window.heldGranted = true;
            c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } });
          });
          await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.imageInput.available);
          await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
        }
        await settle(); const after = await boxes();
        await inShadow(page, async c => { await Promise.all([...c.shadowRoot.querySelectorAll('.image-thumbnail')].map(img => img.decode().catch(() => {}))); });
        const result = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-reason'), feedback = c.shadowRoot.querySelector('.composer-feedback').getBoundingClientRect();
          const texts = [...reason.querySelectorAll('.held-upload-notice, .consent-line-copy, .consent-action')];
          const visible = texts.map(element => {
            const r = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
            return { text: element.textContent, width: r.width, height: r.height,
              clipped: [...range.getClientRects()].some(b => b.width <= 0 || b.height <= 0 || b.top < feedback.top - 1 || b.bottom > feedback.bottom + 1 || b.left < feedback.left - 1 || b.right > feedback.right + 1) };
          });
          const action = reason.querySelector('.consent-action');
          const tapHeight = action ? Number.parseFloat(getComputedStyle(action, '::after').height) : 0;
          return { notice: reason.textContent, action: action?.textContent, tapHeight, attached: c.session.uploads.map(u => u.filename), posts: window.heldPosts, visible };
        });
        if (process.env.AITHEMA_EVIDENCE_DIR && entrance === 'choice' && (scenario === 'refused' || width === 390 && !['count', 'bytes'].includes(scenario))) {
          const prefix = join(process.env.AITHEMA_EVIDENCE_DIR, `ait563-${scenario}-${width}-${locale}-${theme}`);
          await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: `${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify({ before, after, result }, null, 2));
        }
        if (['refused', 'count', 'bytes'].includes(scenario)) {
          assert.equal(result.action, copy.featureConsent.action, 'held consent action stays visible with newer feedback');
          assert.ok(result.notice.includes('scan.pdf'), 'held filename stays visible');
          if (width === 390) assert.ok(result.tapHeight >= 44, 'held consent keeps the existing 44 px phone target');
          const current = scenario === 'refused' ? copy.uploads.type.replace('{name}', 'newer.exe') : scenario === 'count' ? copy.uploads.tooMany.replace('{files}', '8') : copy.uploads.sessionFull.replace('{size}', '50 B');
          assert.ok(result.notice.includes(current), 'the current reason and capacity figure stay visible');
          assert.ok(result.visible.length >= 3);
          for (const box of result.visible) {
            assert.ok(box.width > 0 && box.height > 0, `${box.text}: visible box`);
            assert.equal(box.clipped, false, `${box.text}: fully visible in the reserved slot`);
          }
          for (const selector of Object.keys(before)) {
            assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector}: visible box`);
            assert.deepEqual(after[selector], before[selector], `${selector}: 0 px layout shift`);
          }
        } else if (scenario === 'repick') assert.equal(result.attached.filter(name => name === 'scan.pdf').length, 1);
        else {
          assert.equal(result.notice.includes('older.exe'), false, 'cleared feedback never resurrects');
          assert.ok(result.attached.includes('report.pdf'));
          if (scenario === 'cleared-grant') assert.equal(result.attached.filter(name => name === 'scan.pdf').length, 1);
          else assert.ok(result.notice.includes(copy.uploadsReselect.one));
        }
      });
    });
}

// Regression scenes keep evidence before assertions, including on the red head.
export function heldRegressionCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de'])
    test(`AIT-566: ${width}/${locale} held feedback regressions`, { timeout: 120000 }, async t => {
      const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
      const directory = await mkdtemp(join(tmpdir(), 'aithema-held-regression-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900, hasTouch: width === 390 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      for (const scenario of ['idle-image', 'idle-document', 'rehold-decline', 'rehold-expiry', 'rehold-grant', 'mixed-refusals', 'document-only', 'text-block']) await t.test(scenario, async () => {
        await inShadow(page, async (c, { locale, scenario }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
          session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
          session.settings.voice = 'off'; session.settings.origin = 'chosen';
          const documentOnly = scenario === 'document-only' || scenario === 'idle-document';
          session.featureMatrix = { best: { text: { available: true }, uploads: { available: !documentOnly, reason: documentOnly ? 'current processing consent required' : null },
            imageInput: { available: scenario === 'mixed-refusals', reason: documentOnly ? 'image normalizer not configured' : 'current processing consent required' } } };
          window.regression = { scenario, granted: false, textBlocked: false, asks: [], timers: [], posts: [], firstText: null };
          if (!window.regressionSchedule) {
            window.regressionSchedule = window.setTimeout;
            window.setTimeout = (callback, delay, ...args) => {
              if (delay === 180000) { window.regression.timers.push(callback); return window.regressionSchedule(() => {}, delay); }
              return window.regressionSchedule(callback, delay, ...args);
            };
            c.addEventListener('aithema-consent', event => { window.regression.asks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true });
          }
          window.fetch = async (url, options = {}) => {
            const state = window.regression;
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
            if (String(url).endsWith('/uploads')) {
              if (options.method !== 'POST') { state.limitsRead = true; return Response.json({ limits: scenario === 'document-only' ? { maxRequestBytes: 1 } : {} }); }
              const files = options.body.getAll('files'); state.posts.push(files.map(f => f.name));
              if (scenario === 'mixed-refusals' && files.some(f => f.name === 'scan.pdf')) return Response.json({ refused: [{ index: 0, kind: 'image', reason: 'current processing consent required' }] }, { status: 202 });
              return Response.json({ events: files.map((file, index) => ({ sessionId: c.session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
                id: `receipt-${index}`, filename: file.name, kind: 'image', state: 'staged-ready', bytes: file.size, at: new Date(0).toISOString() } })) }, { status: 202 });
            }
            if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: [], features: { imageInput: ['image-input'] } });
            const snapshot = c.session;
            if (state.granted) snapshot.featureMatrix.best.imageInput = { available: true };
            if (state.textBlocked) snapshot.featureMatrix.best.text = { available: false, reason: 'current processing consent required' };
            return Response.json(snapshot);
          };
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
        }, { locale, scenario });
        await startTyping(page);
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.attach', '.send', 'textarea', '.composer-feedback'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
        })));
        const pick = async names => {
          await inShadow(page, (c, names) => {
            const transfer = new DataTransfer();
            for (const name of names) transfer.items.add(new File([name === 'oversized.png' ? new Uint8Array(21 * 1024 * 1024) : '%PDF-fixture'], name, { lastModified: 1234 }));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          }, names);
          await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy')); await settle();
        };
        await settle(); const before = await boxes();
        if (scenario.startsWith('idle-')) {
          const evidence = process.env.AITHEMA_EVIDENCE_DIR, prefix = `ait566-r2-${scenario}-${width}-${locale}-${theme}`;
          if (evidence) {
            await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${prefix}.png`) });
            await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ before }, null, 2));
          }
          for (const [selector, box] of Object.entries(before)) assert.ok(box.width > 0 && box.height > 0, `${selector}: positive idle box`);
          // Main has a measured image slot and the ordinary document-only row.
          const expected = scenario === 'idle-image' ? width === 390 ? 168.03125 : 150.90625 : width === 390 ? 164.078125 : 150;
          assert.ok(Math.abs(before['.composer'].height - expected) <= .5, `idle composer matches main within 0.5 px: ${before['.composer'].height} vs ${expected}`);
          if (width === 390 && scenario === 'idle-document')
            assert.ok(Math.abs(before['.send'].y - 716.40625) <= .5, 'document-only idle Send matches main within 0.5 px');
          return;
        }
        const heldName = scenario === 'document-only' || scenario === 'mixed-refusals' ? 'scan.pdf' : 'photo.png';
        await pick([heldName]);
        await page.waitForFunction(() => window.regression.asks.length > 0);
        if (scenario.startsWith('rehold')) {
          await page.evaluate(() => window.regression.asks.at(-1).cancel()); await pick([heldName]);
        } else if (scenario === 'mixed-refusals') await pick(['newer.exe', 'oversized.png']);
        else if (scenario === 'document-only') {
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click());
          await page.waitForFunction(() => window.regression.limitsRead); await settle();
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click());
        } else {
          await inShadow(page, c => {
            const reason = c.shadowRoot.querySelector('.composer-reason'), toggle = reason.toggleAttribute.bind(reason);
            reason.toggleAttribute = (name, force) => {
              if (name === 'data-held-consent' && !c.session.featureMatrix.best.text.available && !window.regression.firstText)
                window.regression.firstText = { action: Boolean(reason.querySelector('.consent-action')), feature: reason.dataset.consentFeature, html: reason.innerHTML };
              return toggle(name, force);
            };
            window.regression.textBlocked = true;
            c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...c.session.settings, revision: 2 } } });
          });
          await page.waitForFunction(() => window.regression.firstText);
        }
        await settle(); const after = await boxes();
        const inspect = () => inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-reason'), feedback = c.shadowRoot.querySelector('.composer-feedback').getBoundingClientRect();
          const visible = [...reason.querySelectorAll('.held-upload-notice, .held-upload-images .image-refusal__name, .held-upload-images .image-refusal__reason, .held-upload-consent .consent-line-copy, .held-upload-consent .consent-action')].filter(e => e.textContent).map(element => {
            const r = element.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(element);
            const rects = [...range.getClientRects()].filter(b => b.width > 0 && b.height > 0);
            return { text: element.textContent, width: r.width, height: r.height, rects: rects.length,
              clipped: rects.some(b => b.top < feedback.top - 1 || b.bottom > feedback.bottom + 1 || b.left < feedback.left - 1 || b.right > feedback.right + 1) };
          });
          return { notice: reason.textContent, visible, heldOnly: reason.hasAttribute('data-held-only'), imageLayout: c.shadowRoot.querySelector('.composer').hasAttribute('data-image-input'), firstText: window.regression.firstText };
        });
        const result = await inspect(), visibility = await inShadow(page, feedbackVisibility), evidence = process.env.AITHEMA_EVIDENCE_DIR;
        // A compact review packet: two re-hold states, four mixed scenes, two document-only scenes and first text renders.
        const selected = scenario === 'mixed-refusals' || scenario === 'text-block' || (scenario === 'rehold-decline' || scenario === 'document-only') && (width === 390 && locale === 'de' || width === 1440 && locale === 'en');
        const save = async (suffix, data) => {
          if (!evidence || !selected) return;
          await mkdir(evidence, { recursive: true }); const prefix = join(evidence, `ait566-${scenario}-${width}-${locale}-${theme}${suffix}`);
          await page.screenshot({ path: `${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify(data, null, 2));
        };
        await save('', { before, after, result, visibility });
        await t.test(`${scenario}: slot and every text node`, () => assert.equal(visibility.unreachable, false, JSON.stringify(visibility)));
        if (scenario === 'mixed-refusals' || scenario === 'document-only') {
          await t.test(`${scenario}: consent link treatment`, () => {
            assert.ok(visibility.action.decoration.includes('underline'), 'consent is underlined');
            assert.equal(visibility.action.colour, visibility.action.parentColour, 'consent inherits the sentence ink like the shared link');
            assert.equal(visibility.action.offset, '3px');
            assert.equal(visibility.action.underlineClipped, false, 'the underline has paint room inside its scroll port');
          });
          if (scenario === 'mixed-refusals' && width === 1440) await t.test('mixed: no blank line before held filename', () => {
            assert.ok(visibility.heldGap <= 2, `held line follows current facts without an empty line: ${visibility.heldGap}px`);
          });
        }
        if (scenario.startsWith('rehold')) {
          if (scenario === 'rehold-grant') {
            await inShadow(page, c => { window.regression.granted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); });
            await page.waitForFunction(() => document.querySelector('aithema-session').session.uploads.length === 1);
          } else if (scenario === 'rehold-decline') await page.evaluate(() => window.regression.asks.at(-1).cancel());
          else await page.evaluate(() => window.regression.timers.at(-1)());
          await settle(); const ended = await inspect(); await save('-ended', { result: ended });
          assert.equal(ended.notice.split(copy.uploadsReselect.one).length - 1, scenario === 'rehold-grant' ? 0 : 1, 'no duplicate or stale choose-again sentence');
          assert.equal(result.notice.includes(copy.uploadsReselect.one), false, 're-hold supersedes the stale sentence');
        } else if (scenario === 'text-block') {
          assert.equal(result.firstText.action, true, 'text consent action exists on the first blocked render');
          assert.equal(result.firstText.feature, 'text');
        } else {
          if (scenario === 'mixed-refusals') {
            assert.ok(result.notice.includes(copy.uploads.type.replace('{name}', 'newer.exe')));
            assert.ok(result.notice.includes('oversized.png') && result.notice.includes(copy.imageRefusals.size), 'image refusal remains visible beside held consent');
          } else { assert.equal(result.imageLayout, false); assert.equal(result.heldOnly, false); }
          assert.ok(result.visible.length >= 2);
          for (const box of result.visible) { assert.ok(box.width > 0 && box.height > 0 && box.rects > 0, `${box.text}: non-zero visible box`); assert.equal(box.clipped, false, `${box.text}: unclipped`); }
          for (const selector of Object.keys(before)) {
            assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector}: non-zero boxes`);
            assert.deepEqual(after[selector], before[selector], `${selector}: 0 px shift`);
          }
          if (scenario === 'mixed-refusals' && width === 390) {
            await page.setViewport({ width, height: 568, hasTouch: true }); await settle();
            const short = await inspect();
            for (const box of short.visible) {
              assert.ok(box.width > 0 && box.height > 0 && box.rects > 0, `${box.text}: short-phone visible box`);
              assert.equal(box.clipped, false, `${box.text}: short-phone refusal and consent stay visible`);
            }
            if (evidence) await writeFile(join(evidence, `ait566-short-mixed-${locale}.json`), JSON.stringify({ boxes: await boxes(), result: short }, null, 2));
            await page.setViewport({ width, height: 844, hasTouch: true }); await settle();
          }
        }
      });
    });
}
