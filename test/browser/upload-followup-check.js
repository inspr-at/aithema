import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import idleGeometry from '../fixtures/held-idle-geometry.json' with { type: 'json' };
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

// Slot text must be fully visible. A disclosed sheet may scroll as a whole,
// but each notice keeps its complete, positive box without internal clipping.
export function feedbackVisibility(c) {
  const sheet = c.shadowRoot.querySelector('.upload-notices-sheet[open]');
  const slot = sheet?.querySelector('.upload-notices-body') ?? c.shadowRoot.querySelector('.composer-feedback');
  const reason = sheet ? slot : slot.querySelector(':scope > .composer-reason'), bounds = slot.getBoundingClientRect();
  const box = r => ({ top:r.top, bottom:r.bottom, left:r.left, right:r.right, width:r.width, height:r.height });
  const outside = (r, b) => r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1;
  const texts = [], walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode, parent = text.parentElement;
    if (!text.textContent.trim() || parent.closest('[hidden]') || reason.hasAttribute('data-shortcut') && getComputedStyle(reason).visibility === 'hidden') continue;
    const range = document.createRange(); range.selectNodeContents(text);
    const rects = [...range.getClientRects()];
    if (!rects.length) {
      const alternative = parent.closest('.held-consent-wide, .held-consent-narrow, .consent-wide, .consent-narrow');
      if (alternative && getComputedStyle(alternative).display === 'none' || reason.hasAttribute('data-shortcut')) continue;
    }
    const row = parent.closest('.upload-notice-row'), visibleBounds = sheet && row ? row.getBoundingClientRect() : bounds;
    const clippers = [];
    for (let element = parent; element && element !== slot; element = element.parentElement)
      if (/auto|scroll|hidden|clip/u.test(getComputedStyle(element).overflowY)) clippers.push(element);
    const clipped = !rects.length || rects.some(r => r.width <= 0 || r.height <= 0 || outside(r, visibleBounds)
      || clippers.some(element => outside(r, element.getBoundingClientRect())));
    texts.push({ text:text.textContent, rects:rects.map(box), outside:clipped, reachable:!clipped });
  }
  const action = reason.querySelector('.held-upload-consent .consent-action') ?? reason.querySelector('.consent-action');
  let treatment = null;
  if (action) {
    const css = getComputedStyle(action), r = action.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(action);
    const ink = range.getBoundingClientRect(), parent = action.closest('.upload-notice-row') ?? slot, p = parent.getBoundingClientRect();
    treatment = { width:r.width, height:r.height, fontSize:css.fontSize, lineHeight:css.lineHeight, referenceLeading:1.3,
      decoration:css.textDecorationLine, colour:css.color, parentColour:getComputedStyle(action.parentElement).color, offset:css.textUnderlineOffset,
      paintPort:{ height:p.height, scrollHeight:parent.scrollHeight, clientHeight:parent.clientHeight, tabIndex:parent.tabIndex },
      underlineClipped:ink.bottom + 3 > p.bottom + 1 };
  }
  const rows = [...reason.querySelectorAll('.upload-notice-row')].filter(row => !row.hidden);
  const heldRow = reason.querySelector('.held-upload-consent')?.closest('.upload-notice-row');
  const imageRows = rows.filter(row => row.querySelector('.image-refusal-item'));
  const heldGap = heldRow && imageRows.length ? heldRow.getBoundingClientRect().top - imageRows.at(-1).getBoundingClientRect().bottom : 0;
  const slotOverflow = slot.scrollHeight > slot.clientHeight + 1;
  return { slot:box(bounds), sheet:Boolean(sheet), scrollHeight:slot.scrollHeight, clientHeight:slot.clientHeight, slotOverflow, texts, action:treatment,
    heldGap, ports:[],
    unreachable:bounds.width <= 0 || bounds.height <= 0 || texts.some(text => !text.reachable)
      || !sheet && slotOverflow || rows.some(row => row.clientHeight <= 0 || row.scrollHeight > row.clientHeight) };
}

export function feedbackText(c) {
  const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason').cloneNode(true);
  reason.querySelector('.upload-notices-more')?.remove();
  return reason.textContent;
}

export async function openFeedback(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return inShadow(page, c => {
    const root = c.shadowRoot, more = root.querySelector('.upload-notices-more');
    if (more && !root.querySelector('.upload-notices-sheet').open) { more.click(); return true; }
    return false;
  });
}
export async function closeFeedback(page) {
  await inShadow(page, c => { const sheet = c.shadowRoot.querySelector('.upload-notices-sheet'); if (sheet?.open) sheet.close(); });
}

export async function visibleFeedback(page) {
  const more = await inShadow(page, c => Boolean(c.shadowRoot.querySelector('.upload-notices-more')));
  if (more) await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
  const visibility = await inShadow(page, feedbackVisibility);
  if (more) await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-close').click());
  return visibility;
}

const unavailableProbe = {
  en: "Images can't be prepared right now. Attach the image again.",
  de: 'Bilder lassen sich gerade nicht vorbereiten. Hängen Sie das Bild erneut an.',
};

async function configureRefusalFixture(page, entrance, locale, copy) {
  await inShadow(page, (c, { entrance, locale, copy }) => {
    const session = structuredClone(c.session);
    session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale;
    session.settings.voice = 'off'; session.settings.origin = 'chosen';
    session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
    session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput'].map(key => [key, { available: true }])) };
    session.uploads = [{ id: 'staged', filename: 'photo.png', kind: 'image', state: 'staged-ready',
      bytes: 68, mediaType: 'image/png', digest: 'fixture', w: 1, h: 1, at: new Date(0).toISOString() }];
    window.fetch = async (url, options = {}) => {
      if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({
        start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); },
      }));
      if (String(url).endsWith('/uploads')) return Response.json({ limits: {} });
      if (String(url).endsWith('/image')) {
        const png = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=');
        return new Response(Uint8Array.from(png, char => char.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      }
      return Response.json(c.session);
    };
    c.configure({ session, copy, entrance, sessionToken: 'fixture', voiceClient: {} });
  }, { entrance, locale, copy });
  await startTyping(page);
  await waitForShadow(page, '.staged-image[data-state="staged-ready"]');
}

function refusalGeometry(c, { entrance, text }) {
  const root = c.shadowRoot;
  const box = element => element?.getBoundingClientRect().toJSON() ?? null;
  const control = entrance === 'choice' ? ['attach', '.attach'] : ['mic', '.composer-mic'];
  const boxes = { attach: null, mic: null, ...Object.fromEntries([
    ['field', '.composer textarea'], control, ['send', '.composer .send'],
    ['feedback', '.composer-feedback'], ['composer', '.composer'],
  ].map(([name, selector]) => [name, box(root.querySelector(selector))])) };
  const reason = root.querySelector('.composer-reason');
  const shown = [...reason.querySelectorAll('.image-refusal__reason')].find(node => node.textContent === text && !node.closest('[hidden]'));
  const reserved = [...root.querySelectorAll('.image-feedback-reserve .image-refusal__reason')].find(node => node.textContent === text);
  const textRects = element => {
    if (!element) return [];
    const range = document.createRange(); range.selectNodeContents(element);
    return [...range.getClientRects()].map(rect => rect.toJSON());
  };
  return { boxes, more: Boolean(reason.querySelector('.upload-notices-more')), reserve: box(root.querySelector('.image-feedback-reserve')),
    shown: box(shown?.parentElement), shownRects: textRects(shown), reserved: box(reserved?.parentElement), reservedRects: textRects(reserved) };
}

function assertRefusalBoxes(before, after) {
  for (const [name, box] of Object.entries(after.boxes)) {
    if (!box && !before.boxes[name]) continue;
    assert.ok(box?.width > 0 && box.height > 0, `${name}: positive box`);
    for (const axis of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(box[axis] - before.boxes[name][axis]) <= .5,
        `${name}.${axis} moves by ${box[axis] - before.boxes[name][axis]} px`);
    }
  }
}

export function refusalReserveCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    test(`AIT-638: ${width}/${locale}/light refusal reserve`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-refusal-reserve-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900, hasTouch: width === 390 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      const copy = { en, de }[locale], reasons = Object.entries(copy.imageRefusals);
      const longest = reasons.reduce((a, b) => a[1].length >= b[1].length ? a : b);
      const documentName = 'filename.unknown';
      const documentFacts = copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', documentName));
      const evidence = process.env.AITHEMA_EVIDENCE_DIR;
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = async (entrance, text) => {
        await settle();
        return inShadow(page, refusalGeometry, { entrance, text });
      };
      const capture = async (mode, state, result, screenshot) => {
        if (!evidence) return;
        await mkdir(evidence, { recursive: true });
        const prefix = join(evidence, `ait638-${width}-${locale}-${mode}-${state}`);
        if (screenshot) await page.screenshot({ path: `${prefix}.png` });
        await writeFile(`${prefix}.json`, JSON.stringify({ platform: process.platform, ...result }, null, 2));
      };
      const refuseImage = async reason => {
        await inShadow(page, (c, reason) => c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state',
          data: { ...c.session.uploads[0], id: 'refused', filename: reason === 'unsupported' ? 'photo.heic' : 'photo.png',
            state: 'staged-refused', reason } }), reason);
      };
      const clearImage = () => inShadow(page, c => {
        const root = c.shadowRoot;
        const more = root.querySelector('.upload-notices-more'); more?.click();
        root.querySelector('.image-refusals__dismiss:not([hidden])')?.click();
        root.querySelector('.upload-notices-sheet[open]')?.close();
      });
      const checkImage = async ({ entrance, mode, reason, sentence, idle, screenshot, probe }) => {
        await refuseImage(reason);
        const shown = await geometry(entrance, sentence), visibility = await inShadow(page, feedbackVisibility);
        await capture(mode, `${reason}-shown`, { ...shown, visibility }, screenshot);
        await clearImage();
        const cleared = await geometry(entrance, sentence);
        await capture(mode, `${reason}-cleared`, cleared, screenshot && !probe);
        assertRefusalBoxes(idle, shown);
        assertRefusalBoxes(idle, cleared);
        assert.equal(cleared.shown, null, 'dismiss clears the refusal');
        assert.equal(shown.more, false, 'a single refusal is visible without opening a sheet');
        assert.equal(visibility.unreachable, false, 'all visible notice text fits without clipping or scrolling');
        assert.ok(visibility.texts.some(line => line.text === sentence && line.reachable), `complete reason: ${sentence}`);
        if (probe) {
          assert.ok(shown.reserved?.width > 0 && shown.reserved.height > 0, 'positive reserve reason box');
          assert.ok(shown.reservedRects.length <= 4, `probe reserve wraps to ${shown.reservedRects.length} lines (height ${idle.boxes.composer.height} px)`);
          assert.ok(shown.reserved.width >= shown.shown.width - .5,
            `probe reserve width ${shown.reserved.width} px fits the rendered column ${shown.shown.width} px`);
          assert.ok(shown.shownRects.at(-1)?.width > 0 && shown.shownRects.at(-1).height > 0, 'visible end of the full probe sentence');
        }
      };
      for (const entrance of ['choice', 'combined']) await t.test(entrance, async mode => {
        await configureRefusalFixture(page, entrance, locale, copy);
        const idle = await geometry(entrance, longest[1]);
        assertRefusalBoxes(idle, idle);
        await capture(entrance, 'idle', idle, true);
        for (const [reason, sentence] of entrance === 'choice' ? reasons : [longest]) {
          await mode.test(reason, () => checkImage({ entrance, mode: entrance, reason, sentence, idle, screenshot: reason === longest[0] }));
        }
        await mode.test('document reserve', async () => {
          await inShadow(page, (c, name) => {
            const transfer = new DataTransfer(); transfer.items.add(new File(['unknown'], name));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          }, documentName);
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot
            .querySelector('.composer-reason').hasAttribute('data-upload-feedback'));
          const shown = await geometry(entrance), visibility = await inShadow(page, feedbackVisibility);
          await capture(entrance, 'document-shown', { ...shown, visibility });
          await inShadow(page, c => c.shadowRoot.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true })));
          const cleared = await geometry(entrance);
          await capture(entrance, 'document-cleared', cleared);
          assertRefusalBoxes(idle, shown);
          assertRefusalBoxes(idle, cleared);
          assert.equal(shown.more, false, 'a single document refusal is visible without opening a sheet');
          assert.equal(visibility.unreachable, false, 'document text fits without clipping or scrolling');
          for (const text of [documentFacts, copy.uploadsSupported]) {
            assert.ok(visibility.texts.some(line => line.text.trim() === text && line.reachable), `complete document reserve: ${text}`);
          }
          assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').hasAttribute('data-upload-feedback')), false);
        });
      });
      if (width === 390) await t.test('AIT-610 copy probe', async probe => {
        const sentence = unavailableProbe[locale], entrance = 'choice';
        await configureRefusalFixture(page, entrance, locale, { ...copy, imageRefusals: { ...copy.imageRefusals, unavailable: sentence } });
        const idle = await geometry(entrance, sentence), expected = idleGeometry.boxes[`image-${width}-${locale}`]['.composer'].height;
        probe.diagnostic(`${process.platform} ${width}/${locale}: idle ${idle.boxes.composer.height} px (main ${expected}), reserve: ${idle.reservedRects.length} lines`);
        await capture('probe', 'idle', idle, locale === 'de');
        await probe.test('idle height', () => assert.ok(Math.abs(idle.boxes.composer.height - expected) <= .5,
          `probe idle composer height ${idle.boxes.composer.height} px vs main ${expected} px`));
        await probe.test('show and clear', () => checkImage({ entrance, mode: 'probe', reason: 'unavailable', sentence, idle,
          screenshot: locale === 'de', probe: true }));
      });
    });
  }
}

function feedbackBoxes(visibility) {
  return visibility.texts.map(text => ({ text: text.text,
    width: text.rects.length ? Math.max(...text.rects.map(r => r.right)) - Math.min(...text.rects.map(r => r.left)) : 0,
    height: text.rects.length ? Math.max(...text.rects.map(r => r.bottom)) - Math.min(...text.rects.map(r => r.top)) : 0,
    rects: text.rects.length, outside: text.outside, clipped: !text.reachable }));
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
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
        await settle(); const after = await boxes();
        const result = await inShadow(page, c => ({ posts: window.followupPosts, notice: c.shadowRoot.querySelector('.composer-reason').textContent }));
        result.notice = await inShadow(page, feedbackText);
        const important = scenario === 'count' || scenario === 'bytes' ? result.notice
          : scenario === 'purpose' ? copy.purposePaused.split('. ')[0] + '.' : locale === 'en' ? 'The files could not be added.' : 'Die Dateien konnten nicht übernommen werden.';
        await openFeedback(page);
        const visible = await inShadow(page, (c, important) => {
          const reason = c.shadowRoot.querySelector('.upload-notices-sheet[open] .upload-notice-facts')
            ?? c.shadowRoot.querySelector('.composer-reason .upload-notice-facts') ?? c.shadowRoot.querySelector('.composer-reason');
          const walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT), node = walker.nextNode();
          if (!node || !node.textContent.startsWith(important)) return { startsWith: false };
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, important.length);
          const r = reason.getBoundingClientRect(), rects = [...range.getClientRects()];
          return { startsWith: true, width: r.width, height: r.height, lines: rects.length,
            clipped: rects.some(b => b.width <= 0 || b.height <= 0 || b.top < r.top - 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1 || b.right > r.right + 1) };
        }, important);
        const visibility = await visibleFeedback(page);
        assert.equal(visibility.unreachable, false, JSON.stringify(visibility));
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
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
      const beforeVisibility = await visibleFeedback(page);
      assert.equal(beforeVisibility.unreachable, false, JSON.stringify(beforeVisibility));
      const beforeGrant = await inShadow(page, c => ({ notice: c.shadowRoot.querySelector('.composer-reason').textContent, attached: c.session.uploads.map(u => u.filename) }));
      await inShadow(page, c => {
        window.heldGranted = true;
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } });
      });
      // Bounded settling records the broken before state too, without a timeout hiding evidence.
      await page.waitForFunction(() => document.querySelector('aithema-session').session.featureMatrix.best.imageInput.available);
      await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await inShadow(page, async c => { await Promise.all([...c.shadowRoot.querySelectorAll('.image-thumbnail')].map(img => img.decode().catch(() => {}))); });
      const result = await inShadow(page, c => ({ notice: c.shadowRoot.querySelector('.composer-reason').textContent, attached: c.session.uploads.map(u => u.filename), posts: window.heldPosts }));
      const finalVisibility = await visibleFeedback(page);
      assert.equal(finalVisibility.unreachable, false, JSON.stringify(finalVisibility));
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
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
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
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
        }
        await settle(); const after = await boxes();
        await inShadow(page, async c => { await Promise.all([...c.shadowRoot.querySelectorAll('.image-thumbnail')].map(img => img.decode().catch(() => {}))); });
        const result = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-reason');
          const action = reason.querySelector('.consent-action');
          const tapHeight = action ? Number.parseFloat(getComputedStyle(action, '::after').height) : 0;
          return { notice: reason.textContent, action: action?.textContent, tapHeight, attached: c.session.uploads.map(u => u.filename), posts: window.heldPosts };
        });
        result.notice = await inShadow(page, feedbackText);
        const visibility = await visibleFeedback(page);
        result.visible = feedbackBoxes(visibility);
        assert.equal(visibility.unreachable, false, JSON.stringify(visibility));
        if (process.env.AITHEMA_EVIDENCE_DIR && entrance === 'choice' && (scenario === 'refused' || width === 390 && !['count', 'bytes'].includes(scenario))) {
          const prefix = join(process.env.AITHEMA_EVIDENCE_DIR, `ait563-${scenario}-${width}-${locale}-${theme}`);
          await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: `${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify({ before, after, result, visibility }, null, 2));
        }
        if (['refused', 'count', 'bytes'].includes(scenario)) {
          assert.equal(result.action, copy.featureConsent.action, 'held consent action remains in the notice tree with newer feedback');
          assert.ok(result.notice.includes('scan.pdf'), 'held filename remains in the notice tree');
          if (width === 390) assert.ok(Math.max(result.tapHeight, visibility.action?.height ?? 0) >= 44, 'held consent keeps the existing 44 px phone target');
          const current = scenario === 'refused' ? copy.uploads.type.replace('{name}', 'newer.exe') : scenario === 'count' ? copy.uploads.tooMany.replace('{files}', '8') : copy.uploads.sessionFull.replace('{size}', '50 B');
          assert.ok(result.notice.includes(current), 'the current reason and capacity figure stay visible');
          assert.ok(result.visible.length >= 3);
          for (const box of result.visible) {
            assert.ok(box.width > 0 && box.height > 0, `${box.text}: visible box`);
            assert.equal(box.clipped, false, `${box.text}: fully visible in the reserved slot or disclosed notice sheet`);
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
      for (const scenario of ['idle-image', 'idle-document', 'rehold-decline', 'rehold-expiry', 'rehold-grant', 'mixed-refusals', 'document-only', 'text-block']) await t.test(scenario, async scene => {
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
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false'); await settle();
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
          // Native font widths differ by platform; these complete rects come
          // from the macOS lane's c6153be8 capture. Height checks above are portable.
          if (process.platform === idleGeometry.platform) {
            const reference = idleGeometry.boxes[`${scenario.slice(5)}-${width}-${locale}`];
            for (const [selector, expectedBox] of Object.entries(reference)) {
              assert.ok(expectedBox.width > 0 && expectedBox.height > 0, `${selector}: positive main reference`);
              for (const [axis, expectedValue] of Object.entries(expectedBox))
                assert.ok(Math.abs(before[selector][axis] - expectedValue) <= .5, `${selector}.${axis}: idle matches main within 0.5 px (${before[selector][axis]} vs ${expectedValue})`);
            }
          }
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
        const inspect = async () => {
          const state = await inShadow(page, c => {
            const reason = c.shadowRoot.querySelector('.composer-reason');
            return { notice: reason.textContent, heldOnly: reason.hasAttribute('data-held-only'), imageLayout: c.shadowRoot.querySelector('.composer').hasAttribute('data-image-input'), firstText: window.regression.firstText };
          });
          state.notice = await inShadow(page, feedbackText);
          const visibility = await visibleFeedback(page);
          return { ...state, visibility, visible: feedbackBoxes(visibility) };
        };
        const result = await inspect(), visibility = result.visibility, evidence = process.env.AITHEMA_EVIDENCE_DIR;
        // A compact review packet: two re-hold states, four mixed scenes, two document-only scenes and first text renders.
        const selected = scenario === 'mixed-refusals' || scenario === 'text-block' || (scenario === 'rehold-decline' || scenario === 'document-only') && (width === 390 && locale === 'de' || width === 1440 && locale === 'en');
        const save = async (suffix, data) => {
          if (!evidence || !selected) return;
          await mkdir(evidence, { recursive: true }); const prefix = join(evidence, `ait566-${scenario}-${width}-${locale}-${theme}${suffix}`);
          await page.screenshot({ path: `${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify(data, null, 2));
        };
        await save('', { before, after, result, visibility });
        await scene.test(`${scenario}: slot and every text node`, () => assert.equal(visibility.unreachable, false, JSON.stringify(visibility)));
        if (scenario === 'mixed-refusals' || scenario === 'document-only') {
          await scene.test(`${scenario}: consent link treatment`, () => {
            assert.ok(visibility.action.width > 0 && visibility.action.height > 0, 'consent has a positive visible box');
            assert.ok(visibility.action.decoration.includes('underline'), 'consent is underlined');
            assert.equal(visibility.action.colour, visibility.action.parentColour, 'consent inherits the sentence ink like the shared link');
            assert.equal(visibility.action.offset, '3px');
            assert.ok(Math.abs(Number.parseFloat(visibility.action.lineHeight) / Number.parseFloat(visibility.action.fontSize) - visibility.action.referenceLeading) < .01, 'consent keeps the shared Discard/L-a line box for its underline');
            assert.equal(visibility.action.underlineClipped, false, 'the underline has paint room in its complete notice row');
          });
          if (scenario === 'mixed-refusals' && width === 1440) await scene.test('mixed: no blank line before held filename', () => {
            assert.ok(visibility.heldGap <= 2, `held line follows current facts without an empty line: ${visibility.heldGap}px`);
          });
          await scene.test('each notice owns a nonempty row', () => {
            assert.ok(visibility.texts.every(text => text.rects.length > 0), 'each visible notice has painted text');
          });
        }
        if (scenario.startsWith('rehold')) {
          if (scenario === 'rehold-grant') {
            await inShadow(page, c => { window.regression.granted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); });
            await page.waitForFunction(() => document.querySelector('aithema-session').session.uploads.length === 1);
          } else if (scenario === 'rehold-decline') await page.evaluate(() => window.regression.asks.at(-1).cancel());
          else await page.evaluate(() => window.regression.timers.at(-1)());
          await settle(); const ended = await inspect(); await save('-ended', { result: ended });
          assert.equal(ended.visibility.unreachable, false, 'every ended-hold word remains fully visible');
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
            if (scenario === 'document-only' && selector === '.composer-feedback') {
              // Main keeps idle confirmation compact, then gives new feedback
              // the existing row space. Its origin/height and controls stay fixed.
              const expected = { ...before[selector], width: before['.send'].x - before[selector].x - 8 };
              assert.deepEqual(after[selector], expected, 'document feedback fills the existing row without moving its origin or height');
            } else assert.deepEqual(after[selector], before[selector], `${selector}: 0 px shift`);
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
