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
        constructor.prototype.configure = function (options) { return configure.call(this, { ...options, entrance: q.get('entrance') ?? 'choice' }); };
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
    return { sidebar: box(r.querySelector('.understanding')), sidebarHeight: r.querySelector('.understanding').clientHeight, reading: box(r.querySelector('.analysis-content')), foot: box(r.querySelector('.understanding > .foot')), contact: cb, button: bb, launcher: lb,
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
  for (const entrance of ['choice','combined']) for (const [width, height] of [[1280,600],[1024,600],[1280,544],[1024,568],[390,844],[390,568],[1440,900]]) for (const locale of ['en','de']) for (const theme of ['light','dark']) {
    const label = `${width}x${height}-${locale}-${theme}-${entrance}`;
    await t.test(label, async () => {
      await page.setViewport({ width, height });
      await page.goto(`${demo.url}?locale=${locale}&theme=${theme}&entrance=${entrance}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-host-ready'));
      await page.$eval('aithema-session', c => {
        c.setAttribute('motion', 'off');
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'contact-short-u1', role: 'user', content: 'Requirements' } });
        c.shadowRoot.querySelector('.workspace').removeAttribute('data-reveal');
      });
      await settle();
      const before = await sample(); positive(before.frames);
      if (width >= 960) {
        assert.ok(before.pinned || before.launched, `visible 44px contact control: ${JSON.stringify(before)}`);
        positive([before.reading]);
        assert.ok(before.reading.height / before.sidebarHeight >= .4, `reading retains 40%: ${JSON.stringify(before)}`);
        assert.ok(before.foot.bottom <= before.sidebar.bottom + .5, `footer not clipped: ${JSON.stringify(before)}`);
      } else {
        await page.$eval('.demo-contact', n => n.scrollIntoView({ block: 'center' })); await settle();
        const inset = await page.$eval('aithema-session', c => {
          const fold = c.shadowRoot.querySelector('.fold').getBoundingClientRect(), link = c.querySelector('.demo-contact').getBoundingClientRect();
          return { fold: fold.toJSON(), link: link.toJSON() };
        });
        positive([inset.fold, inset.link]);
        assert.ok(inset.link.left >= inset.fold.right - .5, `contact clears fold chevron: ${JSON.stringify(inset)}`);
      }
      await shot(`${label}-contact`);
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
      await shot(`${label}-dialog`); await page.keyboard.press('Escape'); await settle();
      if (width >= 960) stable(before.frames, (await sample()).frames);
      // At wide desktop fold first so About opens with a visible contact launcher.
      if (width >= 960 && height >= 768) await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.fold').click());
      await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.band-orb .orb').focus());
      await page.waitForFunction(() => getComputedStyle(document.querySelector('aithema-session').shadowRoot.querySelector('.contact-launcher')).opacity === '0');
      await settle();
      const reveal = await page.$eval('aithema-session', c => {
        const r = c.shadowRoot, n = r.querySelector('.contact-launcher');
        return { phase: r.querySelector('.band').dataset.aithemaRevealState, inert: n.inert, opacity: getComputedStyle(n).opacity, box: n.getBoundingClientRect().toJSON() };
      });
      assert.equal(reveal.phase, 'open'); assert.equal(reveal.inert, true, 'contact is inert during About');
      positive([reveal.box]); assert.equal(Number(reveal.opacity), 0, 'contact fades during About');
      await shot(`${label}-about`);
      records.push({ label, before, dialog, settingsTop, reveal });
      if (evidence) await writeFile(join(evidence, 'contact-short-rects.json'), JSON.stringify(records, null, 2));
    });
  }
}
