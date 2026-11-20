import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

// AIT-589: the keyboard focus ring of the "Show N more notices" control stays
// clear of every neighbouring text box and action. Scenes reuse the AIT-563,
// AIT-566 and AIT-561 notice fixtures that put several notices in the slot.
const scenarios = {
  'ait563-refused': { held: 'scan.pdf', image: false, then: ['newer.exe'] },
  'ait566-mixed': { held: 'scan.pdf', image: true, then: ['newer.exe', 'oversized.png'] },
  'ait566-document-only': { held: 'scan.pdf', image: false, documentOnly: true },
  'ait561-refused': { held: 'photo.png', image: false, then: ['newer.exe'] },
};
// The TICK RC27 look cited these combinations; each must show the control.
const cited = new Set(['ait563-refused/390/en', 'ait566-mixed/390/de', 'ait566-document-only/1440/en', 'ait561-refused/1440/en']);
const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .01 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .01;

function measure(c) {
  const root = c.shadowRoot, more = root.querySelector('.composer-feedback .upload-notices-more');
  const reason = root.querySelector('.composer-feedback > .composer-reason');
  const box = r => ({ left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height });
  const m = more.getBoundingClientRect(), css = getComputedStyle(more), px = value => Number.parseFloat(value) || 0;
  const probe = document.createElement('span'); probe.style.color = 'var(--aithema-accent-bright)'; root.append(probe);
  const token = getComputedStyle(probe).color; probe.remove();
  const rings = [];
  if (css.outlineStyle !== 'none' && px(css.outlineWidth) > 0) {
    const e = px(css.outlineOffset) + px(css.outlineWidth);
    rings.push({ kind:'outline', width:px(css.outlineWidth), colour:css.outlineColor, box:{ left:m.left-e, top:m.top-e, right:m.right+e, bottom:m.bottom+e } });
  }
  for (const shadow of css.boxShadow === 'none' ? [] : css.boxShadow.split(/,(?![^(]*\))/u)) {
    if (/\binset\b/u.test(shadow)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.replace(/rgba?\([^)]*\)/u, '').match(/-?[\d.]+px/gu) ?? []).map(px);
    const e = Math.max(Math.abs(x), Math.abs(y)) + blur + spread;
    rings.push({ kind:'box-shadow', width:spread, colour:shadow.match(/rgba?\([^)]*\)/u)?.[0], box:{ left:m.left-e, top:m.top-e, right:m.right+e, bottom:m.bottom+e } });
  }
  for (const pseudo of ['::before', '::after']) {
    const p = getComputedStyle(more, pseudo);
    if (p.content === 'none' || p.display === 'none' || p.position !== 'absolute') continue;
    const width = Math.max(px(p.borderTopWidth), px(p.outlineWidth));
    if (!width) continue;
    const left = m.left + px(css.borderLeftWidth) + px(p.left), top = m.top + px(css.borderTopWidth) + px(p.top);
    const right = m.right - px(css.borderRightWidth) - px(p.right), bottom = m.bottom - px(css.borderBottomWidth) - px(p.bottom);
    rings.push({ kind:pseudo, width, colour:p.borderTopColor, box:{ left, top, right, bottom } });
  }
  const neighbours = [];
  const walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || more.contains(node) || node.parentElement.closest('[hidden]')) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const r of range.getClientRects()) neighbours.push({ text:node.textContent.trim(), box:box(r) });
  }
  for (const action of [root.querySelector('.attach'), root.querySelector('.send'), ...reason.querySelectorAll('button')])
    if (action && action !== more && !action.closest('[hidden]')) neighbours.push({ action:action.className, box:box(action.getBoundingClientRect()) });
  return { focused:root.activeElement === more, focusVisible:more.matches(':focus-visible'), token, control:box(m), text:more.textContent,
    inline:more.parentElement.hasAttribute('data-more-inline'), summary:more.hasAttribute('data-summary'), composer:box(root.querySelector('.composer').getBoundingClientRect()), rings, neighbours };
}

function geometry(c) {
  const root = c.shadowRoot, box = r => ({ x:r.x, y:r.y, width:r.width, height:r.height });
  const boxes = Object.fromEntries(['.composer', '.attach', '.send', 'textarea', '.composer-feedback', '.composer-feedback .upload-notices-more']
    .map(selector => [selector, box(root.querySelector(selector).getBoundingClientRect())]));
  [...root.querySelectorAll('.composer-feedback .upload-notice-row')].filter(row => !row.hidden).forEach((row, index) => { boxes[`row${index}`] = box(row.getBoundingClientRect()); });
  return boxes;
}

export function noticeFocusRingCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark'])
    test(`AIT-589: ${width}/${locale}/${theme} keyboard focus ring on more notices clears neighbouring text`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-notice-focus-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900, hasTouch: width === 390 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const [scenario, spec] of Object.entries(scenarios)) await t.test(scenario, async scene => {
        await inShadow(page, async (c, { locale, scenario, spec }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
          session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date(0).toISOString() }];
          session.settings.voice = 'off'; session.settings.origin = 'chosen';
          session.featureMatrix = { best: { text: { available: true, reason: null },
            uploads: { available: !spec.documentOnly, reason: spec.documentOnly ? 'current processing consent required' : null },
            imageInput: { available: spec.image, reason: spec.image ? null : spec.documentOnly ? 'image normalizer not configured' : 'current processing consent required' } } };
          window.focusRing = { scenario, asks: [], limitsRead: false };
          if (!window.focusRingListener) {
            window.focusRingListener = true;
            c.addEventListener('aithema-consent', event => { window.focusRing.asks.push(event.detail); event.stopImmediatePropagation(); }, { capture: true });
          }
          window.fetch = async (url, options = {}) => {
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
            if (String(url).endsWith('/uploads')) {
              if (options.method !== 'POST') { window.focusRing.limitsRead = true; return Response.json({ limits: spec.documentOnly ? { maxRequestBytes: 1 } : {} }); }
              const files = options.body.getAll('files'), events = [], refused = [];
              for (const [index, file] of files.entries()) {
                if (file.name === spec.held) refused.push({ index, kind: 'image', reason: 'current processing consent required' });
                else events.push({ sessionId: c.session.id, seq: c.session.seq + events.length + 1, type: 'upload.state', data: {
                  id: `receipt-${index}`, filename: file.name, kind: 'document', state: 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
              }
              return Response.json({ events, refused }, { status: 202 });
            }
            if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: [], features: { imageInput: ['image-input'] } });
            return Response.json(c.session);
          };
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
        }, { locale, scenario, spec });
        await startTyping(page); await settle();
        const pick = async names => {
          await inShadow(page, (c, names) => {
            const transfer = new DataTransfer();
            for (const name of names) transfer.items.add(new File([name === 'oversized.png' ? new Uint8Array(21 * 1024 * 1024) : name === 'photo.png' ? new Uint8Array([255, 216, 255, 224]) : '%PDF-fixture'], name, { lastModified: 1234 }));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          }, names);
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false'); await settle();
        };
        await pick([spec.held]);
        await page.waitForFunction(() => window.focusRing.asks.length > 0);
        if (spec.documentOnly) {
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click());
          await page.waitForFunction(() => window.focusRing.limitsRead); await settle();
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click()); await settle();
        } else await pick(spec.then);
        const present = await inShadow(page, c => Boolean(c.shadowRoot.querySelector('.composer-feedback .upload-notices-more')));
        if (cited.has(`${scenario}/${width}/${locale}`)) assert.ok(present, `${scenario}: the cited state offers the more-notices control`);
        if (!present) { scene.skip(`${scenario} fits without a more-notices control at ${width}/${locale}`); return; }
        // Idle notice geometry, then keyboard focus: Tab from the textarea.
        await inShadow(page, c => c.shadowRoot.querySelector('textarea').focus()); await settle();
        const idle = await inShadow(page, geometry);
        for (let step = 0; step < 20; step++) {
          if (await inShadow(page, c => c.shadowRoot.activeElement?.classList.contains('upload-notices-more'))) break;
          await page.keyboard.press('Tab');
        }
        await settle();
        const focused = await inShadow(page, geometry), result = await inShadow(page, measure);
        const evidence = process.env.AITHEMA_EVIDENCE_DIR;
        if (evidence && (locale === 'en') === (theme === 'light')) {
          await mkdir(evidence, { recursive: true });
          const prefix = join(evidence, `ait589-${scenario}-${width}-${locale}-${theme}`), pad = 24, r = result.composer;
          const clip = { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: Math.min(width, r.right + pad) - Math.max(0, r.left - pad), height: r.height + 2 * pad };
          await page.screenshot({ path: `${prefix}.png`, clip });
          await writeFile(`${prefix}.json`, JSON.stringify({ idle, focused, result }, null, 2));
        }
        assert.equal(result.focused, true, 'Tab reaches the more-notices control');
        assert.equal(result.focusVisible, true, 'keyboard focus matches :focus-visible');
        assert.ok(result.control.width >= 44 && result.control.height >= 44, 'control keeps its 44px target');
        assert.ok(result.rings.length > 0, 'keyboard focus paints a ring');
        for (const ring of result.rings) {
          assert.ok(ring.box.right - ring.box.left > 0 && ring.box.bottom - ring.box.top > 0, `${ring.kind}: positive ring box`);
          assert.ok(ring.width >= 2, `${ring.kind}: ring is at least 2px wide`);
          assert.equal(ring.colour, result.token, `${ring.kind}: ring uses the existing 3:1 focus token`);
          assert.ok(ring.box.left >= result.composer.left - .5 && ring.box.right <= result.composer.right + .5 && ring.box.top >= result.composer.top - .5 && ring.box.bottom <= result.composer.bottom + .5,
            `${ring.kind}: ring stays fully inside the composer`);
        }
        // A summary control ("Can't upload · Details") replaces every row; otherwise a notice line shares the slot.
        if (!result.summary) assert.ok(result.neighbours.some(n => n.text), 'a neighbouring notice text is measured');
        assert.ok(result.neighbours.some(n => n.action), 'the neighbouring actions are measured');
        for (const neighbour of result.neighbours) {
          assert.ok(neighbour.box.width > 0 && neighbour.box.height > 0, `${neighbour.text ?? neighbour.action}: positive neighbour box`);
          for (const ring of result.rings)
            assert.equal(overlap(ring.box, neighbour.box), false, `${ring.kind} ring ${JSON.stringify(ring.box)} overlaps ${neighbour.text ?? neighbour.action} ${JSON.stringify(neighbour.box)}`);
        }
        // Focus never moves the composer, notice rows or the control.
        for (const [selector, box] of Object.entries(idle)) {
          assert.ok(box.width > 0 && box.height > 0 && focused[selector]?.width > 0 && focused[selector]?.height > 0, `${selector}: positive boxes`);
          for (const axis of Object.keys(box)) assert.ok(Math.abs(box[axis] - focused[selector][axis]) <= .5, `${selector}.${axis}: unchanged by focus within 0.5px`);
        }
        await page.keyboard.press('Enter'); await settle();
        const sheet = await inShadow(page, c => {
          const dialog = c.shadowRoot.querySelector('.upload-notices-sheet'), r = dialog.getBoundingClientRect();
          return { open: dialog.open, box: { x: r.x, y: r.y, width: r.width, height: r.height },
            rows: [...dialog.querySelectorAll('.upload-notice-row')].map(row => { const b = row.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }) };
        });
        await page.keyboard.press('Escape'); await settle();
        const returned = await inShadow(page, geometry);
        if (evidence && (locale === 'en') === (theme === 'light'))
          await writeFile(join(evidence, `ait589-${scenario}-${width}-${locale}-${theme}-sheet.json`), JSON.stringify({ sheet, returned }, null, 2));
        assert.equal(sheet.open, true, 'Enter opens the notice sheet');
        assert.ok(sheet.box.width > 0 && sheet.box.height > 0 && sheet.rows.every(row => row.width > 0 && row.height > 0), 'sheet and rows have positive boxes');
        for (const [selector, box] of Object.entries(idle)) for (const axis of Object.keys(box))
          assert.ok(Math.abs(box[axis] - returned[selector][axis]) <= .5, `${selector}.${axis}: unchanged after the sheet round trip within 0.5px`);
      });
    });
}
