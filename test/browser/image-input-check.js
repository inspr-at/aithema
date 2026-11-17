import { mockConsent } from './consent-helpers.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserForFile } from './shared-browser.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { waitForShadow, startDemo, stopDemo, preparePage, inShadow, uploadChooser, startTyping } from './demo-helpers.js';

export function imageInputCheck(widths) {
  // AIT-510 image attachment lifecycle and refusal evidence.
  // The page uses only injected intake/model fixtures; no provider is contacted.
  for (const entrance of ['choice', 'combined']) for (const width of widths) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    test(`AIT-510: ${entrance} ${width} ${locale} ${theme} fixed image tiles, refusal reasons, consent and image-only send`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-image-input-'));
      const demo = await startDemo(directory), browser = await browserForFile();
      t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      const page = await browser.newPage(); await preparePage(page, [locale]);
      await page.setViewport({ width, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await mockConsent(page); await startTyping(page);
      await inShadow(page, async (c, entrance) => {
        window.imageEntrance = entrance;
        window.imageAsks = []; window.imagePosts = []; window.imageSeq = 0; window.imageGranted = true;
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); context.fillStyle = 'rgba(224,32,48,0.5)'; context.fillRect(0, 0, 1, 1);
        window.imageFixtureBase64 = canvas.toDataURL('image/png').split(',')[1];
        window.imageFixturePNG = Uint8Array.from(atob(window.imageFixtureBase64), c => c.charCodeAt(0));
        c.addEventListener('aithema-consent', e => { window.imageAsks.push(e.detail); if (window.imageFixtureConsent) e.stopImmediatePropagation(); }, { capture: true });
        const session = structuredClone(c.session);
        session.featureMatrix.best.imageInput = { available: true, reason: null };
        session.featureMatrix.best.images = { available: true, reason: null };
        session.featureMatrix.best.uploads = { available: true, reason: null };
        session.settings.voice = 'off'; session.settings.origin = 'chosen';
        session.featureMatrix.best.voice = { available: false, reason: 'voice off' };
        if (entrance === 'combined') session.emailOffer = { afterMessages: 1 };
        session.inputRevision = 1;
        session.transcript = [{ id: 'existing-input', role: 'user', content: 'A screenshot for the project', at: new Date(0).toISOString() },
          { id: 'existing-reply', role: 'assistant', content: 'Which part should be clarified?', at: new Date(1).toISOString() }];
        const { inputRevision } = await import('/packages/core/src/session.js');
        session.understanding = { ...session.understanding, summary: 'A project screenshot', inputRevision: inputRevision(session), readinessAssessed: true };
        const fetch = window.fetch.bind(window);
        window.fetch = async (url, options = {}) => {
          if (entrance === 'combined' && String(url).endsWith('/credits')) return Response.json({
            tiers: { current: 'anonymous', next: 'emailGiven', delta: 6_000_000, canConfirm: true },
            exhausted: false, balance: { owner: { limitMicro: 12_000_000, availableMicro: 12_000_000, committedMicro: 0, reservedMicro: 0 } },
            emailOffer: { offered: true, open: true, at: 'existing-reply', nextTier: 'emailGiven', deltaMicro: 6_000_000, revision: 1 } });
          if (entrance === 'combined' && String(url).endsWith('/identity')) return Response.json({ identity: c.session.identity,
            delivery: true, privacyDocumentConfigured: true, visitorEmail: { canSave: true, canDelete: true } });
          if (entrance === 'combined' && String(url).endsWith('/visitor/email')) return Response.json({ visitor: { address: null, tier: 'anonymous', limitMicro: 12_000_000 },
            notice: { version: 'fixture-notice', deliveryEnabled: true }, privacyDocumentConfigured: true });
          if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
          if (String(url).endsWith(`/api/sessions/${session.id}`)) {
            const snapshot = c.session; snapshot.featureMatrix.best.imageInput = { available: window.imageGranted && !window.imageUnavailableReason, reason: window.imageUnavailableReason ?? (window.imageGranted ? null : 'current processing consent required') };
            return Response.json(snapshot);
          }
          if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: window.imageGranted ? ['images', 'image-input'] : ['images'], features: { images: ['images'], imageInput: ['image-input'] } });
          if (/\/uploads\/[^/]+\/withdraw$/u.test(String(url))) {
            const id = String(url).split('/').at(-2), image = c.session.uploads.find(u => u.id === id);
            return Response.json({ event: { sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-discarded', erased: true } } });
          }
          if (/\/uploads$/u.test(String(url))) {
            if (options.method !== 'POST') return Response.json({ uploads: c.session.uploads });
            const files = options.body.getAll('files');
            (window.imageUploadPicks ??= []).push(files.map(file => file.name));
            return Response.json({ events: files.map((file, index) => ({ sessionId: c.session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
              id: `fixture-${++window.imageSeq}`, filename: file.name, kind: file.name.endsWith('.pdf') ? 'document' : 'image', state: file.name.endsWith('.pdf') ? 'accepted' : 'staged-pending', bytes: file.size, mediaType: 'image/png', at: new Date(0).toISOString() } })) }, { status: 202 });
          }
          if (/\/uploads\/[^/]+\/image$/u.test(String(url))) {
            (window.imageOwnerHeaders ??= []).push(new Headers(options.headers).get('x-aithema-session-token'));
            if (window.imageDelay) await window.imageDelay;
            return new Response(window.imageFixturePNG, { headers: { 'content-type': 'image/png' } }); }
          if (/\/turns$/u.test(String(url)) && options.method === 'POST') {
            const body = JSON.parse(options.body); window.imagePosts.push(body);
            if (window.imageSendDelay) await window.imageSendDelay;
            return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments, at: new Date(0).toISOString() } });
          }
          return fetch(url, options);
        };
        const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
          ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
      }, entrance);
      await startTyping(page);
      if (entrance === 'combined') assert.equal(await inShadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.attach')).display), 'none');
      const choose = async () => {
        if (width === 390 && entrance === 'choice') {
          const path = join(directory, 'fixture.png');
          await writeFile(path, Buffer.from(await page.evaluate(() => window.imageFixtureBase64), 'base64'));
          const chooser = await uploadChooser(page); await chooser.accept([path]); return;
        }
        await inShadow(page, (c, width) => {
        const transfer = new DataTransfer(); transfer.items.add(new File([window.imageFixturePNG], 'fixture.png', { type: 'image/png' }));
        if (width === 1024) c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
        else c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
        }, width);
      };
      const boxes = () => inShadow(page, c => Object.fromEntries(['.band', '.audio-rail', ...(window.imageEntrance === 'combined' ? ['.composer-mic'] : ['.attach']), '.send', '.composer', ...(window.innerWidth >= 1024 ? ['.understanding', '.understanding .foot'] : [])].map(selector => {
        const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }];
      })));
      // Compare decode events only after the requested viewport's layout is active.
      const resize = async height => {
        await page.setViewport({ width, height });
        await page.waitForFunction(height => {
          const workspace = document.querySelector('aithema-session').shadowRoot.querySelector('.workspace');
          return workspace.hasAttribute('data-phone-short') === (window.innerWidth <= 600 && height <= 620)
            // Both 620 and 568 are short. Wait for the viewport owner's height,
            // not just the unchanged boolean, before measuring its reading pane.
            && (window.innerWidth > 600 || parseFloat(workspace.style.getPropertyValue('--phone-height')) === height);
        }, {}, height);
      };
      const evidence = process.env.AITHEMA_EVIDENCE_DIR;
      const prefix = `${entrance === 'combined' ? 'combined-' : ''}${width}-${locale}-${theme}`;
      if (evidence) await mkdir(evidence, { recursive: true });
      const shot = async state => { if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) }); };
      const clearances = async state => {
        if (entrance !== 'combined') return;
        const layout = await inShadow(page, c => {
          const selectors = ['textarea', '.composer-mic', '.send', '.composer-feedback', '.composer-notice', '.display-foot',
            ...(c.shadowRoot.querySelector('.staged-image') ? ['.staged-images'] : []),
            ...(c.shadowRoot.querySelector('.email-offer') ? ['.email-offer'] : [])];
          return Object.fromEntries(selectors.map(selector => {
            const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
            // An inline offer can scroll partially out of its reading pane. Keep
            // the full positive box and separately record its actual paint clip.
            const clip = selector === '.email-offer' ? c.shadowRoot.querySelector('.conversation-scroll').getBoundingClientRect() : null;
            return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
              ...(clip ? { clip: { x: clip.x, y: clip.y, right: clip.right, bottom: clip.bottom } } : {}) }];
          }));
        });
        if (evidence) await writeFile(join(evidence, `${prefix}-${state}-clearance.json`), JSON.stringify(layout, null, 2));
        for (const [selector, r] of Object.entries(layout)) assert.ok(r.w > 0 && r.h > 0, `${state} ${selector} positive`);
        const entries = Object.entries(layout);
        for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
          const [a, ar] = entries[i], [b, br] = entries[j];
          const visible = r => r.clip ? { x: Math.max(r.x, r.clip.x), y: Math.max(r.y, r.clip.y),
            right: Math.min(r.right, r.clip.right), bottom: Math.min(r.bottom, r.clip.bottom) } : r;
          const av = visible(ar), bv = visible(br);
          assert.ok(Math.min(av.right, bv.right) - Math.max(av.x, bv.x) <= .5 || Math.min(av.bottom, bv.bottom) - Math.max(av.y, bv.y) <= .5,
            `${state}: ${a} and ${b} do not overlap`);
        }
      };
      const reading = async state => {
        if (entrance !== 'combined') return;
        const scene = await inShadow(page, c => {
          const root = c.shadowRoot, box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; };
          const shell = box(root.querySelector('.transcript-shell')), scroll = box(root.querySelector('.conversation-scroll'));
          const band = box(root.querySelector('.band')), composer = box(root.querySelector('.composer'));
          const pane = { top: Math.max(shell.y, scroll.y, band.bottom), bottom: Math.min(shell.bottom, scroll.bottom, composer.y) };
          const rows = [...root.querySelectorAll('.transcript-shell > ol > li')].map(node => ({ kind: node.className, box: box(node),
            entry: node.matches('.email-offer') ? box(node.querySelector('.email-offer__row')) : null }));
          return { shell, scroll, band, composer, pane, last: rows.at(-1), first: rows.find(row => row.box.bottom > pane.top && row.box.y < pane.bottom) };
        });
        if (evidence) await writeFile(join(evidence, `${prefix}-${state}-reading.json`), JSON.stringify(scene, null, 2));
        for (const r of [scene.shell, scene.scroll, scene.band, scene.composer, scene.last.box]) assert.ok(r.w > 0 && r.h > 0, `${state}: positive reading box`);
        assert.ok(scene.pane.bottom > scene.pane.top, `${state}: positive visible conversation height`);
        const room = scene.pane.bottom - scene.pane.top;
        if (scene.last.box.h <= room) assert.ok(scene.last.box.y >= scene.pane.top - .5 && scene.last.box.bottom <= scene.pane.bottom + .5, `${state}: last conversation item is fully visible above the composer`);
        else if (scene.last.entry) {
          assert.ok(scene.last.entry.w > 0 && scene.last.entry.h > 0);
          assert.ok(scene.last.entry.y >= scene.pane.top - .5 && scene.last.entry.bottom <= scene.pane.bottom + .5, `${state}: a tall offer retains its complete entry row`);
        }
        if (scene.first) assert.ok(scene.first.box.w > 0 && scene.first.box.h > 0, `${state}: positive first visible item`);
        if (scene.first?.kind.includes('email-offer') && scene.first.box.h <= room)
          assert.ok(scene.first.box.y >= scene.pane.top - .5, `${state}: the email offer starts below the header band`);
      };
      if (entrance === 'combined') await waitForShadow(page, '.email-offer');
      await clearances('idle'); await shot('idle');
      const unstaged = await boxes();
      for (const r of Object.values(unstaged)) assert.ok(r.w > 0 && r.h > 0, 'positive frame before staging');
      await choose(); await waitForShadow(page, '.staged-image');
      const before = await boxes(), changes = [];
      if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR,
        `${entrance}-${width}-${locale}-${theme}-staging-probe.json`), JSON.stringify({ unstaged, before }, null, 2));
      for (const [selector, r] of Object.entries(before)) for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h'])
        assert.ok(Math.abs(r[edge] - unstaged[selector][edge]) <= .5, `${selector}.${edge} fixed while staging`);
      for (const [selector, r] of Object.entries(before)) assert.ok(r.w > 0 && r.h > 0, `${selector} positive before`);
      await clearances('pending'); await shot('pending');
      if (entrance === 'combined' && width === 390) for (const height of [620, 568]) {
        await resize(height);
        await clearances(`short-${height}-pending`); await shot(`short-${height}-pending`);
        const shortBefore = await boxes();
        for (const r of Object.values(shortBefore)) assert.ok(r.w > 0 && r.h > 0, 'positive short-phone baseline');
        await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
          c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason: 'malformed' } });
        });
        const shortAfter = await boxes();
        if (evidence) await writeFile(join(evidence, `${prefix}-short-${height}-probe.json`), JSON.stringify({ before: shortBefore, after: shortAfter }, null, 2));
        for (const [selector, r] of Object.entries(shortAfter)) {
          assert.ok(r.w > 0 && r.h > 0, `${selector} positive at ${height}`);
          for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - shortBefore[selector][edge]) <= .5, `${height} ${selector}.${edge}`);
        }
        const controls = await inShadow(page, c => Object.fromEntries(['textarea', '.composer-mic', '.send', '.image-refusals'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }];
        })));
        for (const [selector, r] of Object.entries(controls)) assert.ok(r.w > 0 && r.h > 0 && r.x >= 0 && r.right <= width && r.y >= 0 && r.bottom <= height, `${selector} visible at ${height}`);
        const list = Object.entries(controls);
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const [a, ar] = list[i], [b, br] = list[j];
          assert.ok(Math.min(ar.right, br.right) - Math.max(ar.x, br.x) <= .5 || Math.min(ar.bottom, br.bottom) - Math.max(ar.y, br.y) <= .5, `${a} and ${b} do not overlap at ${height}`);
        }
        changes.push({ reason: `short-${height}`, before: shortBefore, rects: shortAfter, controls }); await clearances(`short-${height}`); await shot(`short-${height}`);
        await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
          c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-pending', reason: undefined } });
          c.shadowRoot.querySelector('.image-refusals button').click();
        });
      }
      if (entrance === 'combined' && width === 390) await resize(900);
      for (const reason of ['unsupported', 'size', 'limit', 'empty', 'malformed', 'dimensions', 'deadline', 'cancelled', 'unavailable', 'session', 'model', 'live-call', 'batch', 'paused']) {
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
        const refusalPaint = await inShadow(page, c => {
          const region = c.shadowRoot.querySelector('.image-refusals'), list = region.querySelector('.image-refusals__list');
          const box = node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom }; };
          return { region: box(region), list: box(list), scrollHeight: region.scrollHeight, clientHeight: region.clientHeight,
            duplicates: [...c.shadowRoot.querySelectorAll('.staged-image__status')].some(status => status.textContent === list.querySelector('.image-refusal').textContent.split(': ').slice(1).join(': ')) };
        });
        assert.ok(refusalPaint.region.width > 0 && refusalPaint.region.height > 0 && refusalPaint.list.width > 0 && refusalPaint.list.height > 0);
        assert.ok(refusalPaint.list.bottom <= refusalPaint.region.bottom + .5, `${reason}: the entire refusal is readable without scrolling`);
        assert.equal(refusalPaint.duplicates, false, `${reason}: refusal is shown once`);
        await shot(reason);
        await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals button').click());
      }
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } });
        c.shadowRoot.querySelector('.image-refusals button')?.click();
      });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-image .image-thumbnail')?.naturalWidth === 1);
      const thumbnailControls = await inShadow(page, c => {
        const row = c.shadowRoot.querySelector('.staged-image'), box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { preview: box(row.querySelector('.staged-image__preview')), remove: box(row.querySelector('button')), name: row.querySelector('button').getAttribute('aria-label') };
      });
      for (const r of [thumbnailControls.preview, thumbnailControls.remove]) assert.ok(r.width > 0 && r.height > 0);
      assert.ok(thumbnailControls.remove.width >= 44 && thumbnailControls.remove.height >= 44);
      assert.ok(thumbnailControls.remove.x >= thumbnailControls.preview.right || thumbnailControls.remove.y >= thumbnailControls.preview.bottom, 'remove target stays outside the preview');
      assert.ok(thumbnailControls.name.includes('fixture.png'));
      await reading('ready'); await clearances('ready'); await shot('ready');
      const shortState = async state => {
        if (entrance !== 'combined' || width !== 390) return;
        await resize(568); await reading(`short-568-${state}`); await clearances(`short-568-${state}`); await shot(`short-568-${state}`); await resize(900);
      };
      await shortState('ready');
      if (width === 390) {
        await resize(530);
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
        changes.push({ reason: 'keyboard-malformed', before: compact, rects: after }); await shot('keyboard');
        await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image'); c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined } }); c.shadowRoot.querySelector('.image-refusals button').click(); });
        await resize(900);
      }
      assert.deepEqual(await page.evaluate(() => window.imageAsks), [], 'both image purposes granted at start: no ask');
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason .consent-action') === null), true, 'no consent line');
      // A real document-type refusal must survive image send (AIT-280 / AIT-510).
      const beforeDocumentNotice = await boxes();
      await inShadow(page, c => {
        const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.unknown', { type: 'application/octet-stream' }));
        c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent.includes('fixture.unknown'));
      const documentNotice = await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent);
      assert.match(documentNotice, /PNG, JPEG, WebP/u, 'unknown file type names the accepted image formats');
      const documentNoticePaint = await inShadow(page, c => {
        const reason = c.shadowRoot.querySelector('.composer-reason'), r = reason.getBoundingClientRect();
        return { width: r.width, height: r.height, scrollHeight: reason.scrollHeight, clientHeight: reason.clientHeight };
      });
      assert.ok(documentNoticePaint.width > 0 && documentNoticePaint.height > 0, 'document notice has a positive box');
      assert.ok(documentNoticePaint.scrollHeight <= documentNoticePaint.clientHeight, `the entire document notice fits: ${JSON.stringify(documentNoticePaint)}`);
      const afterDocumentNotice = await boxes();
      for (const [selector, r] of Object.entries(afterDocumentNotice)) {
        const previous = beforeDocumentNotice[selector];
        assert.ok(previous.w > 0 && previous.h > 0 && r.w > 0 && r.h > 0, `${selector}: positive before/after document notice`);
        for (const edge of selector === '.composer' ? ['y', 'h', 'bottom'] : ['x', 'y', 'w', 'h'])
          assert.ok(Math.abs(r[edge] - previous[edge]) <= .5, `${selector}.${edge}: document notice cannot move the frame`);
      }
      changes.push({ reason: 'document-notice', before: beforeDocumentNotice, rects: afterDocumentNotice, paint: documentNoticePaint });
      assert.equal(documentNotice.includes('·'), false, 'the refused item ends with its sentence, without a dangling separator');
      await inShadow(page, c => {
        window.imageSendDelay = new Promise(resolve => { window.releaseImageSend = resolve; });
        c.shadowRoot.querySelector('.send').click();
      });
      await page.waitForFunction(() => window.imagePosts.length === 1);
      await clearances('sending'); await shot('sending'); await shortState('sending');
      await page.evaluate(() => { window.releaseImageSend(); window.imageSendDelay = null; });
      const post = await page.evaluate(() => window.imagePosts[0]); assert.equal(post.content, ''); assert.equal(post.attachments.length, 1);
      await inShadow(page, async c => {
        const { inputRevision } = await import('/packages/core/src/session.js');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'understanding.updated', data: {
          ...c.session.understanding, summary: 'A project screenshot', inputRevision: inputRevision(c.session), readinessAssessed: true } });
      });
      await waitForShadow(page, '.turn .image-thumbnail');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.turn .image-thumbnail')?.naturalWidth === 1);
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), documentNotice, 'document notice survives image send');
      await reading('sent-document-notice'); await clearances('sent-document-notice'); await shot('sent-document-notice'); await shortState('sent-document-notice');
      await shot('sent');
      const tileBefore = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(tileBefore.w > 0 && tileBefore.h > 0);
      await inShadow(page, async c => {
        window.imageDelay = new Promise(resolve => { window.releaseImageDelay = resolve; });
        window.imageRevocations = 0; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.imageRevocations++; revoke(url); };
        const session = c.session, { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
          ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
      });
      const tileReload = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(tileReload.w > 0 && tileReload.h > 0); assert.deepEqual(tileReload, tileBefore, 'reload reserves the image box before authenticated pixels arrive');
      assert.ok(await page.evaluate(() => window.imageRevocations > 0), 'the old object URL was revoked');
      await page.evaluate(() => { window.releaseImageDelay(); window.imageDelay = null; });
      await waitForShadow(page, '.turn .image-thumbnail');
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.turn .image-thumbnail')?.naturalWidth === 1);
      await shot('reload');
      assert.ok(await page.evaluate(() => window.imageOwnerHeaders.every(header => header === 'fixture')), 'all thumbnail requests use owner authentication');
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'withheld', withdrawn: true } });
      });
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.turn .image-thumbnail')), null, 'withheld pixels are removed');
      const withheldLabel = await inShadow(page, c => c.shadowRoot.querySelector('.turn-image').textContent);
      assert.equal(withheldLabel, locale === 'de' ? 'Bild nicht gesendet' : 'Image not sent');
      await shot('withheld');
      const withheld = await boxes();
      for (const [selector, r] of Object.entries(withheld)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive while withheld`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - before[selector][edge]) <= .5, `${selector}.${edge} fixed while withheld`);
      }
      changes.push({ reason: 'withheld', rects: withheld });
      await inShadow(page, c => {
        const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.heic', { type: 'image/heic' }));
        c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      });
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.image-refusals')?.textContent.includes('fixture.heic'));
      assert.equal(await page.evaluate(() => window.imageSeq), 1, 'HEIC is refused before upload');
      await clearances('heic'); await shot('heic');
      await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals button').click());

      await inShadow(page, async c => {
        window.imageGranted = false; window.imageFixtureConsent = true; window.imageAsks = [];
        const session = c.session; session.featureMatrix.best.imageInput = { available: false, reason: 'current processing consent required' };
        const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
          ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
      });
      await startTyping(page);
      const consentBefore = await boxes(), attachedBefore = await page.evaluate(() => window.imageSeq);
      for (const r of Object.values(consentBefore)) assert.ok(r.w > 0 && r.h > 0, 'positive frame before consent selection');
      const consentFrame = async state => {
        const current = await boxes();
        for (const [selector, r] of Object.entries(current)) {
          assert.ok(r.w > 0 && r.h > 0, `${selector} positive in ${state}`);
          for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - consentBefore[selector][edge]) <= .5, `${selector}.${edge} fixed in ${state}`);
        }
        changes.push({ reason: state, before: consentBefore, rects: current }); await shot(state);
      };
      await choose(); await page.waitForFunction(() => window.imageAsks.length === 1);
      assert.equal(await page.evaluate(() => window.imageSeq), attachedBefore, 'no image POST before consent');
      assert.deepEqual(await page.evaluate(() => window.imageAsks[0].features), ['imageInput']);
      await consentFrame('consent');
      await inShadow(page, c => { window.imageGranted = true;
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } });
      });
      await waitForShadow(page, '.staged-image[data-state="staged-pending"]');
      assert.equal(await page.evaluate(() => window.imageSeq), attachedBefore + 1, 'consent resumes exactly one attach');
      assert.equal(await page.evaluate(() => window.imageAsks.length), 1, 'no repeated consent ask');
      await consentFrame('consent-resumed');
      await inShadow(page, c => c.shadowRoot.querySelector('.staged-image__remove').click());
      await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.staged-image'));
      await shot('discarded');
      const discarded = await boxes();
      for (const [selector, r] of Object.entries(discarded)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive after discard`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - consentBefore[selector][edge]) <= .5, `${selector}.${edge} fixed after discard`);
      }
      changes.push({ reason: 'discarded', before: consentBefore, rects: discarded });
      if (evidence) await writeFile(join(evidence, `${prefix}-rects.json`), JSON.stringify({ unstaged, before, changes, tileBefore, tileReload, after: await boxes() }, null, 2));
      await inShadow(page, async c => {
        window.imageUnavailableReason = 'image normalizer not configured';
        const session = c.session; session.featureMatrix.best.imageInput = { available: false, reason: window.imageUnavailableReason };
        const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
          ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
        const transfer = new DataTransfer();
        transfer.items.add(new File([window.imageFixturePNG], 'photo.png', { type: 'image/png' }));
        transfer.items.add(new File(['fixture'], 'notes.pdf', { type: 'application/pdf' }));
        c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      });
      await page.waitForFunction(() => [...document.querySelector('aithema-session').shadowRoot.querySelectorAll('.upload__name')].some(name => name.textContent === 'notes.pdf'));
      assert.deepEqual(await page.evaluate(() => window.imageUploadPicks.at(-1)), ['notes.pdf'], 'mixed pick uploads the document without sending the refused image');
      const mixedReason = await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals').textContent);
      assert.ok(mixedReason.includes('photo.png'));
      assert.ok(mixedReason.includes((locale === 'de' ? de : en).imageRefusals.unavailable));
      await clearances('mixed-pick'); await shot('mixed-pick');

    });
  }
}
