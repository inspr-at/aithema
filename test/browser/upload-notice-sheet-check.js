import assert from 'node:assert/strict';
import { reasonSeparator } from '../../packages/ui/src/reason-separator.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import mainGeometry from '../fixtures/held-idle-geometry.json' with { type:'json' };
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function uploadNoticeSheetCheck() {
  for (const [width, locale] of [[390, 'de'], [390, 'en'], [1440, 'en'], [1440, 'de']])
    test(`AIT-566 r3: ${width}/${locale} option A and ordinary feedback scope`, { timeout: 120000 }, async t => {
      const theme = locale === 'de' ? 'dark' : 'light', copy = { en, de }[locale];
      const directory = await mkdtemp(join(tmpdir(), 'aithema-notice-sheet-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900, hasTouch: width === 390 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.attach', '.send', 'textarea'].map(selector => {
        const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x:r.x, y:r.y, width:r.width, height:r.height }];
      })));
      const unchanged = (before, after) => {
        for (const [selector, box] of Object.entries(before)) {
          assert.ok(box.width > 0 && box.height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector}: positive boxes`);
          for (const axis of Object.keys(box)) assert.ok(Math.abs(box[axis] - after[selector][axis]) <= .5, `${selector}.${axis}: unchanged within 0.5px`);
        }
      };
      const save = async (state, data) => {
        const evidence = process.env.AITHEMA_EVIDENCE_DIR; if (!evidence) return;
        await mkdir(evidence, { recursive:true }); const prefix = join(evidence, `ait566-r4-${state}-${width}-${locale}-${theme}`);
        await page.screenshot({ path:`${prefix}.png` }); await writeFile(`${prefix}.json`, JSON.stringify(data, null, 2));
      };
      const configure = async scenario => {
        await inShadow(page, async (c, { locale, scenario }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale; session.uploads = [];
          session.transcript = [{ id:'established', role:'user', content:'Project documents', at:new Date(0).toISOString() }];
          session.paused = scenario === 'image-refusal'; session.settings.voice = 'off'; session.settings.origin = 'chosen';
          const held = scenario === 'summary' || scenario === 'mixed' || scenario === 'rehold';
          session.featureMatrix = { best: { text:{ available:scenario !== 'text', reason:scenario === 'text' ? 'current processing consent required' : null },
            uploads:{ available:!held || scenario !== 'summary', reason:scenario === 'summary' ? 'current processing consent required' : null },
            imageInput:{ available:scenario === 'mixed' || scenario === 'image-refusal', reason:scenario === 'summary' || !held ? 'image normalizer not configured' : 'current processing consent required' } } };
          window.sheetFixture = { scenario, asks:[], posts:[], limitsRead:false };
          if (!window.sheetSchedule) {
            window.sheetSchedule = window.setTimeout;
            window.setTimeout = (callback, delay, ...args) => window.sheetSchedule(callback, new Error().stack.includes('#waitForUploadRetry') ? 0 : delay, ...args);
          }
          if (!window.sheetListener) {
            window.sheetListener = true;
            c.addEventListener('aithema-consent', event => { window.sheetFixture.asks.push(event.detail); event.stopImmediatePropagation(); }, { capture:true });
          }
          window.fetch = async (url, options = {}) => {
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once:true }); } }));
            if (String(url).endsWith('/uploads')) {
              if (options.method !== 'POST') { window.sheetFixture.limitsRead = true; return Response.json({ limits:scenario === 'summary' ? { maxRequestBytes:1 } : {} }); }
              window.sheetFixture.posts.push(options.body.getAll('files').map(f => f.name));
              if (scenario === 'failure') return Response.json({ error:'upload-rate-limit' }, { status:429 });
              return Response.json({ refused:[{ index:0, kind:'image', reason:'current processing consent required' }] }, { status:202 });
            }
            if (String(url).endsWith('/turns')) throw new TypeError('fixture send failure');
            const snapshot = c.session;
            if (window.sheetFixture.textGranted) snapshot.featureMatrix.best.text = { available:true, reason:null };
            if (window.sheetFixture.textBlocked) snapshot.featureMatrix.best.text = { available:false, reason:'current processing consent required' };
            return Response.json(snapshot);
          };
          const { [locale]:copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const supplied = scenario === 'single-line-refusal' ? { ...copy, uploads:{ ...copy.uploads, type:locale === 'de' ? '{name} (abgelehnt)' : '{name} (not allowed)' } } : copy;
          c.configure({ session, copy:supplied, entrance:'choice', sessionToken:'fixture', voiceClient:{} });
        }, { locale, scenario });
        await startTyping(page); await settle();
      };
      const pick = async names => {
        await inShadow(page, (c, names) => {
          const transfer = new DataTransfer();
          for (const name of names) transfer.items.add(new File([name === 'oversized.png' ? new Uint8Array(21 * 1024 * 1024) : '%PDF-fixture'], name, { lastModified:1234 }));
          const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        }, names);
        await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false'); await settle();
      };
      for (const scenario of ['refusal', 'single-line-refusal', 'text', 'failure']) await t.test(scenario, async scene => {
        await configure(scenario); const before = await boxes();
        if (scenario.endsWith('refusal')) await pick(['x.heic']);
        if (scenario === 'failure') {
          await pick(['report.pdf']);
          await inShadow(page, c => { c.shadowRoot.querySelector('textarea').value = 'Send fixture'; c.shadowRoot.querySelector('form.composer').dispatchEvent(new Event('submit', { cancelable:true, bubbles:true })); });
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('[data-send-failed]')); await settle();
        }
        const result = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), send = c.shadowRoot.querySelector('.send').getBoundingClientRect();
          const css = getComputedStyle(reason), range = document.createRange(); range.selectNodeContents(reason); const r = range.getBoundingClientRect();
          return { text:reason.textContent, ink:{ width:r.width, height:r.height, lines:range.getClientRects().length }, center:r.y+r.height/2, referenceCenter:send.y+send.height/2, tabIndex:reason.getAttribute('tabindex'), overflow:css.overflowY, padding:css.paddingBottom,
            target:reason.querySelector('.consent-action') ? getComputedStyle(reason.querySelector('.consent-action'), '::after').height : null };
        });
        const after = await boxes(); await save(scenario, { before, after, result });
        unchanged(before, after);
        await scene.test('no feedback Tab stop', () => assert.equal(result.tabIndex, null, 'plain feedback never receives a tabindex'));
        if (scenario.endsWith('refusal')) await scene.test('main centred alignment', () => {
          const offset = process.platform === mainGeometry.ordinaryRefusal.platform ? mainGeometry.ordinaryRefusal.inkCenterOffset : 0;
          assert.ok(result.ink.width > 0 && result.ink.height > 0, 'refusal ink has a positive box');
          assert.ok(Math.abs(result.center-result.referenceCenter-offset) <= .5, `ordinary refusal matches main ink centre: ${JSON.stringify(result)}`);
          if (scenario === 'single-line-refusal') assert.equal(result.ink.lines, 1, 'short host copy provides a true single-line refusal at both widths');
        });
        if (scenario === 'text') {
          assert.equal(result.overflow, 'visible', 'text consent target is not clipped'); assert.ok(Number.parseFloat(result.target) >= 44);
          await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason > .consent-action').click());
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
          await inShadow(page, c => {
            window.sheetFixture.textGranted = true;
            c.receive({ sessionId:c.session.id, seq:c.session.seq+1, type:'settings.changed', data:{ processingPreset:'best', settings:{ ...c.session.settings, revision:2 } } });
          });
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-shortcut]'));
          await page.keyboard.press('Escape'); await settle();
          assert.equal(await inShadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true,
            'consent grant returns to the textarea when feedback becomes the shortcut');
          unchanged(before, await boxes());
        }
        if (scenario === 'failure') assert.equal(result.padding, '8px', 'send failure retains 8px paint room');
      });
      await t.test('combined measuring lines retain intrinsic sizing', async () => {
        await configure('refusal');
        await inShadow(page, async c => { const session = c.session, { [session.locale]:copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`); c.configure({ session, copy, entrance:'combined', sessionToken:'fixture', voiceClient:{} }); });
        await startTyping(page); await settle();
        const measured = await inShadow(page, c => { const reserve = c.shadowRoot.querySelector('.composer-feedback-reserve'), r = reserve.getBoundingClientRect(); return { width:r.width, height:r.height, lines:[...reserve.children].map(line => ({ position:getComputedStyle(line).position, fitted:line.hasAttribute('data-notice-layout'), tabIndex:line.getAttribute('tabindex') })) }; });
        assert.ok(measured.width > 0 && measured.height > 0, 'intrinsic combined reserve has a positive box');
        assert.ok(measured.lines.every(line => line.position !== 'absolute' && !line.fitted && line.tabIndex === null), 'measuring lines never match live fitting rules');
      });
      await t.test('r4 short document status remains accessible and clipped', async scene => {
        scene.after(() => page.setViewport({ width, height:width === 390 ? 844 : 900, hasTouch:width === 390 }));
        await page.setViewport({ width:390, height:568, hasTouch:width === 390 });
        await configure('text'); const before = await boxes();
        const status = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), r = reason.getBoundingClientRect();
          return { inert:reason.inert, role:reason.getAttribute('role'), text:reason.textContent, width:r.width, height:r.height, clip:getComputedStyle(reason).clipPath };
        });
        const client = await page.createCDPSession();
        const { root } = await client.send('DOM.getDocument', { depth:-1, pierce:true });
        const find = node => node.attributes?.some((value, index, values) => index % 2 === 0 && value === 'id' && values[index+1] === 'composer-reason') ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(find).find(Boolean);
        const { nodes } = await client.send('Accessibility.getPartialAXTree', { backendNodeId:find(root).backendNodeId });
        await client.detach();
        await save('short-document-status', { before, status, accessibility:nodes });
        assert.equal(status.inert, false, 'short document status is never inert');
        assert.equal(status.role, 'status');
        assert.ok(nodes.some(node => !node.ignored && node.role?.value === 'status'), 'polite status remains in the accessibility tree');
        assert.equal(status.width, 1); assert.equal(status.height, 1); assert.equal(status.clip, 'inset(50%)');
        await configure('refusal'); const idle = await boxes(); await pick(['x.heic']);
        const refused = await inShadow(page, c => { const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), r = reason.getBoundingClientRect(); return { width:r.width, height:r.height, inert:reason.inert, text:reason.textContent }; });
        await save('short-document-refusal', { idle, after:await boxes(), refused });
        assert.equal(refused.inert, false); assert.equal(refused.width, 1); assert.equal(refused.height, 1);
        unchanged(idle, await boxes());
        await page.setViewport({ width, height:width === 390 ? 844 : 900, hasTouch:width === 390 });
      });
      await t.test('r4 lone image refusal stays inline on desktop', async () => {
        await configure('image-refusal'); const idle = await boxes();
        await inShadow(page, c => {
          const data = new DataTransfer(); data.items.add(new File(['fixture'], 'photo.png', { type:'image/png', lastModified:1234 }));
          c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData:data, bubbles:true, cancelable:true }));
          c.receive({ sessionId:c.session.id, seq:c.session.seq+1, type:'session.paused', data:{ paused:false } });
        }); await settle();
        const result = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), action = reason.querySelector('.image-refusals__dismiss');
          const name = reason.querySelector('.image-refusal');
          const range = document.createRange(); if (name) range.selectNodeContents(name); const ink = name ? range.getBoundingClientRect() : null;
          const r = action?.getBoundingClientRect();
          return { text:reason.innerText, summary:Boolean(reason.querySelector('[data-summary]')), ink:ink && { y:ink.y, height:ink.height }, action:r && { x:r.x,y:r.y,width:r.width,height:r.height } };
        });
        await save('lone-refusal', { idle, after:await boxes(), result }); unchanged(idle, await boxes());
        if (width === 1440) { assert.equal(result.summary, false, 'a fitting lone image refusal never becomes a summary'); assert.ok(result.action?.height >= 44); assert.ok(result.ink.y >= result.action.y && result.ink.y + result.ink.height <= result.action.y + result.action.height, 'refusal and action share a line'); }
      });
      for (const scenario of ['summary', 'mixed', 'rehold']) await t.test(scenario, async scene => {
        await configure(scenario); const idle = await boxes(); await save(`${scenario}-idle`, { boxes:idle });
        await pick([scenario === 'rehold' ? 'photo.png' : 'scan.pdf']);
        await page.waitForFunction(() => window.sheetFixture.asks.length > 0);
        if (scenario === 'mixed') await pick(['newer.exe', 'oversized.png']);
        if (scenario === 'summary') {
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click());
          await page.waitForFunction(() => window.sheetFixture.limitsRead); await settle();
          await inShadow(page, c => c.shadowRoot.querySelector('.attach').click()); await settle();
        }
        if (scenario === 'rehold') { await page.evaluate(() => window.sheetFixture.asks.at(-1).cancel()); await pick(['photo.png']); }
        const before = await boxes();
        const result = await inShadow(page, c => {
          const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), control = reason.querySelector('.upload-notices-more');
          const r = control?.getBoundingClientRect();
          return { text:reason.innerText, scrollHeight:reason.scrollHeight, clientHeight:reason.clientHeight, tabIndex:reason.getAttribute('tabindex'), control:control ? { text:control.textContent, width:r.width, height:r.height } : null,
            rows:[...reason.querySelectorAll('.upload-notice-row')].filter(row => !row.hidden).map(row => { const r = row.getBoundingClientRect(); return { text:row.innerText, width:r.width, height:r.height, clientHeight:row.clientHeight, scrollHeight:row.scrollHeight }; }) };
        });
        await save(scenario, { idle, before, result }); unchanged(idle, before);
        if (scenario === 'mixed' && width === 1440) await scene.test('r4 more control shares the last fitting notice line', async () => {
          assert.ok(result.rows.length > 0, 'desktop shows a complete notice before disclosure');
          const joined = await inShadow(page, c => {
            const more = c.shadowRoot.querySelector('.upload-notices-more'), row = more?.closest('.upload-notice-row');
            if (!row) return null;
            const r = row.getBoundingClientRect(), m = more.getBoundingClientRect();
            return { row:{ x:r.x,y:r.y,width:r.width,height:r.height }, control:{ x:m.x,y:m.y,width:m.width,height:m.height } };
          });
          assert.ok(joined && joined.row.width > 0 && joined.row.height > 0 && joined.control.width >= 44 && joined.control.height >= 44);
          assert.ok(joined.control.y >= joined.row.y && joined.control.y + joined.control.height <= joined.row.y + joined.row.height + .5);
          assert.ok(joined.row.height <= 44.5, 'notice and disclosure occupy one 44px line');
        });
        if (scenario === 'rehold') {
          await scene.test('r4 fitting consent and action share their row', async () => {
            const line = await inShadow(page, c => {
              const reason = c.shadowRoot.querySelector('.composer-feedback > .composer-reason'), source = reason.querySelector('.held-upload-consent');
              const label = source.querySelector('.consent-line-copy'), action = source.querySelector('.consent-action');
              const range = document.createRange(); range.selectNodeContents(label); const ink = range.getBoundingClientRect(), a = action.getBoundingClientRect();
              return { summary:Boolean(reason.querySelector('[data-summary]')), label:label.innerText, ink:{ x:ink.x,y:ink.y,width:ink.width,height:ink.height }, action:{ x:a.x,y:a.y,width:a.width,height:a.height } };
            });
            if (width === 1440) { assert.equal(line.summary, false, 'fitting held consent is shown in full'); assert.ok(line.action.height >= 44); assert.ok(line.ink.y >= line.action.y && line.ink.y + line.ink.height <= line.action.y + line.action.height, 'consent and action share a line'); }
            else if (line.action.y >= line.ink.y + line.ink.height) { assert.equal(line.label.trim().endsWith('·'), false, 'a wrapped action has no dangling separator'); assert.ok(Math.abs(line.action.x-line.ink.x) <= .5, 'wrapped action aligns with its sentence'); }
          });
          await scene.test('r4 consent-only summary is honest', async () => {
            await inShadow(page, c => { c.shadowRoot.querySelector('.composer-feedback').style.maxWidth = '100px'; }); await settle();
            const summary = await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more[data-summary]')?.innerText);
            await save('consent-summary', { summary, boxes:await boxes() });
            await inShadow(page, c => { c.shadowRoot.querySelector('.composer-feedback').style.maxWidth = ''; }); await settle();
            assert.equal(summary, `${locale === 'de' ? 'Einwilligung nötig' : 'Consent needed'}${reasonSeparator}Details`);
          });
          await inShadow(page, c => { const r = c.shadowRoot; (r.querySelector('.upload-notices-more') ?? r.querySelector('.held-upload-consent .consent-action')).focus({ preventScroll:true }); });
          assert.equal(result.text.includes(copy.uploadsReselect.one), false);
          if (result.control) await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
          await page.evaluate(() => window.sheetFixture.asks.at(-1).cancel()); await settle();
          if (result.control) {
            const ended = await inShadow(page, c => ({ open:c.shadowRoot.querySelector('.upload-notices-sheet').open,
              rows:[...c.shadowRoot.querySelectorAll('.upload-notices-sheet .upload-notice-row')].map(row => row.innerText) }));
            assert.equal(ended.open, true, 'ending a hold preserves the open review sheet');
            assert.equal(ended.rows.length, 1, 'the ended notice replaces held consent inside the open sheet');
            assert.ok(ended.rows[0].includes(copy.uploadsReselect.one), 'the current choose-again notice is fully shown');
            await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-close').click());
          }
          await save('rehold-ended', { boxes:await boxes() }); unchanged(idle, await boxes());
          await inShadow(page, c => { const input = c.shadowRoot.querySelector('textarea'); input.value = 'Clear ended notice'; input.dispatchEvent(new Event('input')); });
          assert.equal(await inShadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('textarea')), true, 'ending feedback and returning to the touch shortcut retains meaningful focus');
          assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').hasAttribute('tabindex')), false);
          return;
        }
        await scene.test('overflow is disclosed without a scroll region', () => {
          assert.ok(result.control, 'overflow offers a labelled sheet control');
          assert.ok(result.control.height >= 44 && result.control.width >= 44, 'control has a 44px target');
          assert.equal(result.tabIndex, null); assert.ok(result.scrollHeight <= result.clientHeight, 'slot never clips or scrolls a partial notice');
          for (const row of result.rows) assert.ok(row.width > 0 && row.height > 0 && row.scrollHeight <= row.clientHeight, 'every visible notice fits completely');
          if (result.rows.length === 0) assert.equal(result.text.trim(), `${locale === 'de' ? 'Hochladen nicht möglich' : "Can't upload"}${reasonSeparator}Details`);
          else assert.match(result.control.text, locale === 'de' ? /\d+ weitere Meldung/u : /Show \d+ more notice/u);
        });
        if (!result.control) return;
        await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click()); await settle();
        const opened = await inShadow(page, c => {
          const dialog = c.shadowRoot.querySelector('.upload-notices-sheet'), r = dialog.getBoundingClientRect();
          return { open:dialog.open, modal:dialog.matches(':modal'), title:dialog.getAttribute('aria-labelledby'), text:dialog.innerText, top:r.top, height:r.height,
            rows:[...dialog.querySelectorAll('.upload-notice-row')].map(row => { const r = row.getBoundingClientRect(); return { text:row.innerText, width:r.width, height:r.height, clientHeight:row.clientHeight, scrollHeight:row.scrollHeight }; }),
            actions:[...dialog.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return { text:b.textContent, width:r.width, height:r.height }; }) };
        });
        await save(`${scenario}-sheet`, { before, after:await boxes(), opened }); unchanged(idle, await boxes());
        assert.equal(opened.open, true); assert.equal(opened.modal, true); assert.ok(opened.title); assert.ok(opened.top <= 24);
        assert.ok(opened.rows.length >= 2); for (const row of opened.rows) assert.ok(row.width > 0 && row.height > 0 && row.scrollHeight <= row.clientHeight);
        for (const action of opened.actions) assert.ok(action.width >= 44 && action.height >= 44, `${action.text}: 44px target`);
        if (width === 390) assert.ok(opened.height >= 840, 'phone sheet occupies the full viewport');
        await scene.test('r4 sheet action joins never leave a dangling separator', async () => {
          const joins = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.upload-notices-sheet [data-consent-feature]')].map(source => {
            const label = source.querySelector('.consent-line-copy'), action = source.querySelector('.consent-action');
            if (!label || !action) return null;
            const range = document.createRange(); range.selectNodeContents(label); const l = range.getBoundingClientRect(), a = action.getBoundingClientRect();
            return { text:label.innerText, label:{ x:l.x,y:l.y,width:l.width,height:l.height }, action:{ x:a.x,y:a.y,width:a.width,height:a.height } };
          }).filter(Boolean));
          for (const join of joins) if (join.action.y >= join.label.y + join.label.height) {
            assert.equal(join.text.trim().endsWith('·'), false); assert.ok(Math.abs(join.action.x-join.label.x) <= .5);
          }
        });
        await scene.test('r4 an open sheet survives a collapsed slot update', async () => {
          await inShadow(page, c => {
            const slot = c.shadowRoot.querySelector('.composer-feedback'); slot.style.cssText = 'width:1px!important;height:1px!important;flex:0 0 1px!important;max-width:1px!important';
            c.receive({ sessionId:c.session.id, seq:c.session.seq+1, type:'settings.changed', data:{ processingPreset:'best', settings:{ ...c.session.settings, revision:2 } } });
          }); await settle();
          const rows = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.upload-notices-sheet .upload-notice-row')].map(row => row.innerText));
          await inShadow(page, c => { c.shadowRoot.querySelector('.composer-feedback').style.cssText = ''; }); await settle();
          assert.ok(rows.length >= 2 && rows.every(text => text.trim()), 'collapsing the slot never empties the open sheet');
        });
        await page.keyboard.press('Tab'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
        assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-sheet').contains(c.shadowRoot.activeElement)), true, 'focus stays in sheet');
        await page.keyboard.press('Escape'); await settle();
        assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.classList.contains('upload-notices-more')), true, 'Escape restores opener focus'); unchanged(idle, await boxes());
        await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
        await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-close').click()); await settle();
        assert.equal(await inShadow(page, c => c.shadowRoot.activeElement?.classList.contains('upload-notices-more')), true, 'Close restores opener focus'); unchanged(idle, await boxes());
        if (scenario === 'mixed') {
          await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
          await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-sheet .image-refusals__dismiss').click()); await settle();
          const discarded = await inShadow(page, c => ({ text:c.shadowRoot.querySelector('.upload-notices-sheet').innerText,
            focused:c.shadowRoot.querySelector('.upload-notices-sheet').contains(c.shadowRoot.activeElement) }));
          assert.equal(discarded.text.includes('oversized.png'), false, 'sheet Discard consumes the same refusal record');
          assert.ok(discarded.text.includes('newer.exe') && discarded.text.includes('scan.pdf'), 'other notices survive Discard');
          assert.equal(discarded.focused, true, 'discarding a focused sheet action keeps focus in the dialog');
          await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-sheet .held-upload-consent .consent-action').click());
          assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('dialog.settings').open), true, 'sheet consent opens the existing consent editor');
          await page.keyboard.press('Escape'); await settle();
          assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-sheet').contains(c.shadowRoot.activeElement)), true, 'consent editor returns focus to the sheet action');
          await page.keyboard.press('Escape'); await settle(); unchanged(idle, await boxes());
          await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
          await inShadow(page, c => {
            window.sheetFixture.textBlocked = true;
            c.receive({ sessionId:c.session.id, seq:c.session.seq+1, type:'settings.changed', data:{ processingPreset:'best', settings:{ ...c.session.settings, revision:2 } } });
          });
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"] .consent-action'));
          await settle();
          const blocked = await inShadow(page, c => ({ sheet:c.shadowRoot.querySelector('.upload-notices-sheet').open,
            disabled:c.shadowRoot.querySelector('textarea').disabled, active:c.shadowRoot.activeElement?.className ?? null }));
          assert.equal(blocked.sheet, false, 'text consent supersedes the upload sheet');
          assert.equal(blocked.disabled, true);
          assert.equal(blocked.active, 'attach', 'sheet availability changes return focus to a usable control');
          unchanged(idle, await boxes());
        }
      });
    });
}
