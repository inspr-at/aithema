import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';

export async function contactShortCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-contact-short-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, records = [];
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.evaluateOnNewDocument(() => {
    const OriginalDate = Date;
    window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } };
    const q = new URLSearchParams(location.search);
    const define = customElements.define.bind(customElements);
    customElements.define = (name, constructor, options) => {
      if (name === 'aithema-session') {
        const configure = constructor.prototype.configure;
        constructor.prototype.configure = function (options) {
          window.contactConfiguredOptions = { ...options, entrance: q.get('entrance') ?? 'choice' };
          return configure.call(this, window.contactConfiguredOptions);
        };
      }
      return define(name, constructor, options);
    };
    localStorage.setItem('aithema-demo-locale', q.get('locale') ?? 'en');
    localStorage.setItem('aithema-theme', q.get('theme') ?? 'light');
  });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => void (new URL(request.url()).origin === demo.url ? request.continue() : request.abort()));
  const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const sample = () => page.$eval('aithema-session', c => {
    const r = c.shadowRoot, box = n => n.getBoundingClientRect().toJSON();
    const launcher = r.querySelector('.contact-launcher'), contact = r.querySelector('.sidebar-contact'), button = c.querySelector('.demo-contact:not([slot="contact-launcher"]) button');
    const cb = box(contact), bb = box(button), lb = box(launcher);
    const rowVisible = contact.checkVisibility({ checkVisibilityCSS: true }) && cb.height > 0;
    const content = box(c.querySelector('.demo-contact:not([slot="contact-launcher"])'));
    let absentUnfocusable = false;
    if (!rowVisible) {
      const previous = document.activeElement;
      button.focus({ preventScroll: true });
      absentUnfocusable = document.activeElement !== button;
      previous?.focus({ preventScroll: true });
    }
    return { sidebar: box(r.querySelector('.understanding')), sidebarHeight: r.querySelector('.understanding').clientHeight, reading: box(r.querySelector('.analysis-content')), foot: box(r.querySelector('.understanding > .foot')), contact: cb, button: bb, launcher: lb,
      rowVisible, absentUnfocusable, content,
      complete: rowVisible && bb.height >= 44 && content.top >= cb.top - .5 && content.bottom <= cb.bottom + .5 && contact.scrollHeight <= contact.clientHeight + .5,
      pinned: button.checkVisibility({ checkVisibilityCSS: true }) && bb.height >= 44 && bb.top >= cb.top - .5 && bb.bottom <= cb.bottom + .5,
      launched: launcher.checkVisibility({ checkVisibilityCSS: true }) && !launcher.inert && lb.height >= 44,
      frames: ['.band', '.audio-rail', '.understanding', '.understanding > .foot', '.display-foot'].map(s => box(r.querySelector(s))) };
  });
  const positive = boxes => boxes.forEach(b => assert.ok(b.width > 0 && b.height > 0, `positive box: ${JSON.stringify(b)}`));
  const stable = (a, b) => {
    positive(a); positive(b);
    const shift = Math.max(...a.flatMap((r, i) => ['x', 'y', 'width', 'height'].map(k => Math.abs(r[k] - b[i][k]))));
    assert.ok(shift <= .5, `${shift}px frame movement`); return shift;
  };
  const shot = async name => { if (evidence) { await mkdir(join(evidence, 'shots'), { recursive: true }); await page.screenshot({ path: join(evidence, 'shots', `${name}.png`), captureBeyondViewport: false }); } };
  // Reuse one neutral host document per entrance/locale/theme. Every viewport
  // still gets a fresh component session and the complete behavior assertions.
  for (const entrance of ['choice','combined']) for (const locale of ['en','de']) for (const theme of ['light','dark']) {
    await page.goto(`${demo.url}?locale=${locale}&theme=${theme}&entrance=${entrance}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready'));
    await page.evaluate(locale => {
      const options = window.contactConfiguredOptions;
      window.contactInitialOptions = { ...options, copy: options.copyForLocale(locale) };
      window.contactInitialSession = structuredClone(document.querySelector('aithema-session').session);
      window.contactInitialSession.locale = locale;
    }, locale);
    for (const [width, height] of [[1280,600],[1024,600],[1280,544],[1024,568],[1024,768],[960,768],[390,844],[390,568],[1440,900]]) {
      const label = `${width}x${height}-${locale}-${theme}-${entrance}`;
      // Capture every requested R12 state in EN/DE and both themes, including a
      // combined short phone. Other matrix rows retain their full rect evidence.
      const captures = entrance === 'combined'
        ? (width === 390 && height === 568 ? ['contact','dialog','about'] : [])
        : (width === 390 && height === 844 ? ['contact','dialog','about']
          : width === 1440 ? ['dialog','about']
            : height === 600 ? ['contact'] : []);
      await t.test(label, async () => {
        await page.setViewport({ width, height });
        await page.$eval('aithema-session', c => {
          c.configure({ ...window.contactInitialOptions, session: structuredClone(window.contactInitialSession) });
          c.setAttribute('motion', 'off');
          c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'contact-short-u1', role: 'user', content: 'Requirements' } });
          c.shadowRoot.querySelector('.workspace').removeAttribute('data-reveal');
        });
        await settle();
        const language = await page.$eval('aithema-session', (c, locale) => ({
          session: c.session.locale,
          actual: c.shadowRoot.querySelector('.handover__label').textContent,
          expected: window.contactInitialOptions.copyForLocale(locale).hostSurface.handover.request,
        }), locale);
        assert.equal(language.session, locale, `${label}: fixture session keeps its requested locale`);
        assert.equal(language.actual, language.expected, `${label}: library copy follows the requested locale`);
        const before = await sample(); positive(before.frames); let phoneInset = null;
        if (width >= 960) {
          assert.ok(before.pinned || before.launched, `visible 44px contact control: ${JSON.stringify(before)}`);
          assert.ok(before.complete || (!before.rowVisible && before.absentUnfocusable), `pinned contact is complete or absent and unfocusable: ${JSON.stringify(before)}`);
          assert.equal(Number(before.rowVisible) + Number(before.launched), 1, `exactly one contact action: ${label}`);
          if (height >= 768) {
            assert.equal(before.complete, true, `pinned contact fits above the threshold: ${label}`);
            assert.equal(before.launched, false, `launcher hidden above the threshold: ${label}`);
          }
          positive([before.reading]);
          assert.ok(before.reading.height / before.sidebarHeight >= .4, `reading retains 40%: ${JSON.stringify(before)}`);
          assert.ok(before.foot.bottom <= before.sidebar.bottom + .5, `footer not clipped: ${JSON.stringify(before)}`);
        } else {
          await page.$eval('.demo-contact', n => n.scrollIntoView({ block: 'center' })); await settle();
          const inset = await page.$eval('aithema-session', c => {
            const fold = c.shadowRoot.querySelector('.fold').getBoundingClientRect(), link = c.querySelector('.demo-contact').getBoundingClientRect();
            return { fold: fold.toJSON(), link: link.toJSON(), handover: c.shadowRoot.querySelector('.handover__label').getBoundingClientRect().toJSON() };
          });
          phoneInset = inset;
          positive([inset.fold, inset.link]);
          assert.ok(inset.link.left >= inset.fold.right - .5, `contact clears fold chevron: ${JSON.stringify(inset)}`);
          positive([inset.handover]);
          assert.ok(inset.handover.left >= inset.fold.right - .5, `TICK L2: the personal-conversation link clears the fold chevron: ${JSON.stringify(inset)}`);
        }
        if (captures.includes('contact')) await shot(`${label}-contact`);
        await page.evaluate(() => scrollTo(0, 0)); await settle();
        // Open from whichever host control is available, with native focus return.
        await page.$eval('aithema-session', (c, pinned) => {
          const button = c.querySelector(pinned ? '.demo-contact button' : '[slot="contact-launcher"]');
          button.focus({ preventScroll: true }); button.click();
        }, before.pinned); await settle();
        const dialog = await page.$eval('#demo-contact-dialog', n => n.getBoundingClientRect().toJSON()); positive([dialog]);
        const settingsTop = await page.$eval('aithema-session', c => { c.openSettings(); return c.shadowRoot.querySelector('dialog.settings').getBoundingClientRect().top; });
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('dialog.settings').close());
        assert.ok(Math.abs(dialog.top - settingsTop) <= .5, `contact uses Settings top anchor: ${dialog.top} vs ${settingsTop}`);
        if (captures.includes('dialog')) await shot(`${label}-dialog`); await page.keyboard.press('Escape'); await settle();
        const after = await sample();
        const shiftPx = width >= 960 ? stable(before.frames, after.frames) : null;
        // At wide desktop fold first so About opens with a visible contact launcher.
        if (width >= 960 && height >= 768) await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.fold').click());
        await page.$eval('aithema-session', c => {
          const band = c.shadowRoot.querySelector('.band');
          band.querySelector('.band-orb .orb').focus();
          // Finish finite reduced-motion transitions for deterministic end-state
          // geometry and captures. The opacity/inert assertions below still run.
          for (const animation of band.getAnimations({ subtree: true })) {
            if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
          }
        });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.contact-launcher')).opacity === '0');
        await settle();
        const reveal = await page.$eval('aithema-session', c => {
          const r = c.shadowRoot, n = r.querySelector('.contact-launcher');
          return { phase: r.querySelector('.band').dataset.aithemaRevealState, inert: n.inert, opacity: getComputedStyle(n).opacity, box: n.getBoundingClientRect().toJSON() };
        });
        assert.equal(reveal.phase, 'open'); assert.equal(reveal.inert, true, 'contact is inert during About');
        positive([reveal.box]); assert.equal(Number(reveal.opacity), 0, 'contact fades during About');
        if (captures.includes('about')) await shot(`${label}-about`);
        records.push({ label, captures, language, before, after, shiftPx, phoneInset, dialog, settingsTop, reveal });
        if (evidence) await writeFile(join(evidence, 'contact-short-rects.json'), JSON.stringify(records, null, 2));
      });
    }
  }
}

export async function contactRailCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-contact-rail-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const browser = await browserForFile(), page = await browser.newPage(), results = [];
  await page.evaluateOnNewDocument(() => {
    const OriginalDate = Date;
    window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [100_000])); } static now() { return 100_000; } };
  });
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/demo/host.js' && !new URL(request.url()).search) {
      void request.respond({ status: 200, contentType: 'application/javascript', body: "window.releaseContactRail = () => import('/demo/host.js?contact-rail');" });
    } else void request.continue();
  });
  const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  for (const [width, actionsWidth] of [[1280,260],[1400,350]]) await t.test(`${width}/${actionsWidth}`, async () => {
    await page.setViewport({ width, height: 900 });
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    if (actionsWidth !== 260) await page.evaluate(async actionsWidth => {
      const { headerRailReservation } = await import('/packages/ui/src/first-paint.js');
      const style = document.createElement('style');
      style.textContent = `.aithema-shell > :is(aithema-session,.aithema-first-paint) { --aithema-header-actions-width:${actionsWidth}px; }` + headerRailReservation({ actionsWidth: `${actionsWidth}px` });
      document.head.append(style);
    }, actionsWidth);
    await settle();
    const sample = () => page.evaluate(() => {
      const c = document.querySelector('aithema-session'), mounted = c.shadowRoot?.querySelector('.band'), root = mounted ? c.shadowRoot : document;
      return (mounted ? ['.band','.audio-rail'] : ['.aithema-first-paint','.aithema-first-paint .audio-rail']).map(s => root.querySelector(s).getBoundingClientRect().toJSON());
    });
    const before = await sample();
    for (const b of before) assert.ok(b.width > 0 && b.height > 0, 'positive first-paint box');
    assert.equal(before[0].height, 150, 'contact and host action widths reserve two rail rows before upgrade');
    await page.evaluate(() => window.releaseContactRail());
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready')); await settle();
    const after = await sample();
    for (const b of after) assert.ok(b.width > 0 && b.height > 0, 'positive mounted box');
    const shift = Math.max(...before.flatMap((b,i) => ['x','y','width','height'].map(k => Math.abs(b[k]-after[i][k]))));
    assert.ok(shift <= .5, `${shift}px contact/host rail first-paint shift`);
    results.push({ width, actionsWidth, before, after, shift });
  });
  if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR,'contact-rail-rects.json'), JSON.stringify(results,null,2));
}
