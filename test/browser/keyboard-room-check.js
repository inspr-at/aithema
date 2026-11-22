// AIT-618 (LEAD's binding decision after AIT-603 PR-A): at compact keyboard-up
// phone sizes the controls never move, and the transcript gets its room back
// from OTHER chrome:
// - the keyboard-shortcut hint ("⌘ + Enter to send") is not painted on a touch
//   phone without a hardware keyboard ((hover:none) and (pointer:coarse), a
//   static media query, so it never appears or disappears while typing); its
//   box is kept, so nothing moves; desktop and hardware keyboards keep it;
// - while the phone keyboard is up the "Microphone blocked" status row
//   collapses (0 px, no row gap; its text stays in the accessibility tree) and
//   returns when the keyboard closes; the AI notice stays.
// Acceptance (TICK): at 320x568 with the keyboard up (visual viewport 308 and
// 340) at least one whole transcript line stays visible in the pending and the
// cleared consent states (image and document docks, EN/DE), and Send and Mic
// stay identical through pending -> cleared -> + 2 s (PR-A r10's floor rule).
// Every measured box must be positive, so a hidden (0x0) box cannot pass.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const keys = ['x', 'y', 'width', 'height'];
const stock = { en: en.featureConsent, de: de.featureConsent };
const none = (failures, label) => { if (failures.length) throw new Error(`${failures.join(' | ')} [${label}]`.slice(0, 1800)); };
const settleLong = page => page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve)); });
const wait = (page, ms) => page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), ms);
// The keyboard as in AIT-511/513 and PR-A (a shorter visual viewport, focus in the field).
const keyboardUp = (page, height) => page.evaluate(height => {
  globalThis.k1Viewport ??= visualViewport;
  const viewport = new EventTarget(); Object.assign(viewport, { height, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').focus({ preventScroll: true });
  window.dispatchEvent(new Event('resize'));
}, height);
const keyboardDown = page => page.evaluate(() => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.k1Viewport });
  document.querySelector('aithema-session').shadowRoot.querySelector('textarea').blur();
  window.dispatchEvent(new Event('resize'));
});

// AIT-618 r4 (TICK Q1 (a), code-health rule 6): the keyboard-up state's settle (focus outside the
// composer, the viewport not grown back) runs on an injected clock, never a sleep. The element's
// own layout.js module exports the timer it uses; the test replaces it with a queue it fires itself.
const installSettleClock = page => page.evaluate(async () => {
  const { keyboardSettle } = await import('/packages/ui/src/layout.js');
  globalThis.settleQueue = [];
  if (!keyboardSettle) return false;
  keyboardSettle.set = (fn, ms) => { const entry = { fn, ms }; globalThis.settleQueue.push(entry); return entry; };
  keyboardSettle.clear = entry => { const i = globalThis.settleQueue.indexOf(entry); if (i >= 0) globalThis.settleQueue.splice(i, 1); };
  return true;
});
const pendingSettles = page => page.evaluate(() => (globalThis.settleQueue ?? []).map(entry => entry.ms));
const fireSettle = page => page.evaluate(() => { const queue = (globalThis.settleQueue ?? []).splice(0); for (const entry of queue) entry.fn(); return queue.length; });

// The dock controls, the status row, the hint and the transcript lines a visitor can read.
const roomState = c => {
  const root = c.shadowRoot, box = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const painted = n => Boolean(n) && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().height > .5
    && n.getBoundingClientRect().width > .5 && [...(function* up(e) { for (; e && e !== root; e = e.parentElement ?? e.parentNode?.host) yield e; })(n)].every(e => getComputedStyle(e).clipPath === 'none');
  const scroll = root.querySelector('.conversation-scroll'), dock = root.querySelector('.composer-dock');
  const s = scroll.getBoundingClientRect(), d = dock.getBoundingClientRect();
  const scrollCSS = getComputedStyle(scroll), fade = scrollCSS.maskImage && scrollCSS.maskImage !== 'none' ? (parseFloat(scrollCSS.getPropertyValue('--opener-fade')) || 24) : 0;
  const viewportBottom = visualViewport.height + (visualViewport.offsetTop || 0);
  const top = Math.max(s.top, 0), bottom = Math.min(s.bottom - fade, d.top, viewportBottom);
  // Whole painted text lines of the transcript inside every clipping ancestor and above the dock.
  const lines = [], shell = scroll.querySelector('.transcript-shell');
  if (shell) {
    const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (!n.textContent.trim() || !n.parentElement.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let clipTop = top, clipBottom = bottom;
      for (let e = n.parentElement; e && e !== scroll; e = e.parentElement) {
        const css = getComputedStyle(e); if (css.overflowY === 'visible' && css.overflowX === 'visible') continue;
        const r = e.getBoundingClientRect(); clipTop = Math.max(clipTop, r.top); clipBottom = Math.min(clipBottom, r.bottom);
      }
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > .5 && r.height > .5 && r.top >= clipTop - .5 && r.bottom <= clipBottom + .5) lines.push({ y: r.y, height: r.height, text: n.textContent.trim().slice(0, 24) });
    }
  }
  const status = root.querySelector('.composer-status'), slot = root.querySelector('.composer-status-slot');
  const hint = root.querySelector('.composer-feedback > .composer-reason[data-shortcut]');
  const workspace = root.querySelector('.workspace');
  return {
    keyboard: workspace.hasAttribute('data-phone-keyboard'), short: workspace.hasAttribute('data-phone-short'),
    coarse: matchMedia('(pointer:coarse)').matches, hoverNone: matchMedia('(hover:none)').matches,
    dock: box(dock), composer: box(root.querySelector('.composer')), field: box(root.querySelector('textarea')),
    mic: box(root.querySelector('.composer-mic')), send: box(root.querySelector('.send')), feedback: box(root.querySelector('.composer-feedback')),
    notice: box(root.querySelector('.composer-notice')), noticePainted: painted(root.querySelector('.composer-notice')),
    band: box(root.querySelector('.band')), scroll: box(scroll), room: Math.max(0, bottom - top), fade,
    footer: box(root.querySelector('.display-foot')), footerShown: getComputedStyle(root.querySelector('.display-foot')).display !== 'none',
    overlay: workspace.hasAttribute('data-phone-overlay'),
    lines: lines.length, firstLine: lines[0] ?? null,
    status: { text: status?.textContent.trim() ?? '', painted: painted(status), slot: box(slot) },
    hint: hint ? { text: hint.textContent.trim(), painted: painted(hint), box: box(hint) } : null,
    consent: Boolean(root.querySelector('.composer-reason[data-consent-feature="text"]')),
  };
};
const stableBoxes = (name, before, after, parts) => {
  const failures = [];
  for (const part of parts) {
    const a = before[part], b = after[part];
    if (!(a?.width > 0 && a?.height > 0 && b?.width > 0 && b?.height > 0)) { failures.push(`${name}: ${part} positive boxes: ${JSON.stringify([a, b])}`); continue; }
    for (const key of keys) if (Math.abs(a[key] - b[key]) > .5) failures.push(`${name}: ${part} keeps its ${key}: ${a[key]} -> ${b[key]}`);
  }
  return failures;
};
const brief = s => ({ keyboard: s.keyboard, room: +s.room.toFixed(1), lines: s.lines, scroll: s.scroll, dock: s.dock, band: s.band, notice: s.notice, status: s.status, hint: s.hint });

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-keyboard-room-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.kill(); } });
  browser = await browserForFile();
  const evidence = process.env.AITHEMA_EVIDENCE_DIR ? join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-618', 'tick') : null;
  if (evidence) await mkdir(evidence, { recursive: true });
  const index = [];
  // `touch`: a touch phone without a hardware keyboard (pointer:coarse, hover:none).
  // r3: `consent` overrides the host's consent copy (a long host action); `host` mounts the host
  // surface (its header controls) through configure, as a host does.
  // r4: `heldImage` keeps image input behind its own consent (a picked image is held until consent or expiry).
  const open = async ({ width, height, locale, touch = true, intake = null, granted = false, consent = null, host = null, contact = false, heldImage = false }, problems) => {
    const page = await browser.newPage();
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (/ResizeObserver/.test(message.text())) problems.push(message.text()); });
    await page.evaluateOnNewDocument(() => window.addEventListener('error', event => {
      if (/ResizeObserver/.test(String(event.message))) console.error(`ResizeObserver loop: ${event.message}`);
    }));
    await page.setViewport({ width, height, hasTouch: touch, isMobile: false });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => { void (new URL(request.url()).pathname === '/combined-fixture'
      ? request.respond({ status: 200, contentType: 'text/html', body: fixture }) : request.continue()); });
    await page.goto(`${server.url}/combined-fixture?locale=${locale}&opener&passiveDenied`);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('aithema-session').shadowRoot.querySelector('.composer-status').textContent.length > 0);
    await page.evaluate(async (locale, intake, granted, consent, host, contact, heldImage) => {
      const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
      globalThis.fixtureCopy = { ...base, featureConsent: { ...base.featureConsent, text: base.featureConsent.text, ...(consent ?? {}) } };
      const c = document.querySelector('aithema-session');
      const snapshot = JSON.parse(JSON.stringify(c.session)), best = snapshot.featureMatrix.best;
      if (intake === 'image') best.imageInput = { available: true };
      if (intake === 'document') best.uploads = { available: true };
      if (granted) { best.text = structuredClone(best.analysis); best.voice = structuredClone(best.analysis); }
      if (heldImage) best.imageInput = { available: false, reason: 'current processing consent required' };
      if (host) { const configure = c.configure.bind(c); c.configure = options => configure({ ...options, host }); }
      if (contact) { const button = document.createElement('button'); button.type = 'button'; button.slot = 'contact-launcher';
        button.textContent = locale === 'de' ? 'Kontakt' : 'Contact'; button.style.cssText = 'width:44px;height:44px;overflow:hidden'; c.append(button); }
      mount(snapshot);
    }, locale, intake, granted, consent, host, contact, heldImage);
    await page.waitForFunction(granted => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return granted ? root.querySelector('.composer-reason[data-shortcut]') : root.querySelector('.composer-reason[data-consent-feature="text"] .consent-action');
    }, { timeout: 15_000 }, granted);
    await settleLong(page);
    page.settleClock = await installSettleClock(page);
    return page;
  };
  const read = page => page.$eval('aithema-session', roomState);
  const capture = async (page, name, state) => {
    index.push({ name, shot: `${name}.png`, file: `${name}.json`, ...brief(state) });
    if (!evidence) return;
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
    await writeFile(join(evidence, `${name}.json`), JSON.stringify(state, null, 2));
    await writeFile(join(evidence, `index-${process.pid}-${t.name.replace(/\W+/gu, '-').slice(0, 40)}.json`), JSON.stringify(index, null, 2));
  };
  // r3 (TICK r2 next look): a 3x crop of the dock's bottom-left corner (the notice line's start and the corner curve).
  const crop = async (page, name, dock) => {
    if (!evidence || !(dock?.width > 0)) return;
    await page.screenshot({ path: join(evidence, `${name}-corner-3x.png`), clip: { x: dock.x, y: dock.y + dock.height - 48, width: 120, height: 48, scale: 3 } });
  };
  return { open, read, capture, crop };
}

// (a) TICK's acceptance: a transcript line in both consent states, controls still, status row collapsed and back.
export async function keyboardRoomCheck(t) {
  const { open, read, capture } = await harness(t);
  const [width, height] = [320, 568];
  for (const viewport of [308, 340]) for (const intake of ['image', 'document']) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-${intake}-dock`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake }, problems);
      try {
        const down = await read(page);
        await capture(page, `${name}-keyboard-down`, down);
        if (!down.coarse || !down.hoverNone) failures.push(`${name}: fixture: a touch phone (pointer:coarse, hover:none): ${JSON.stringify([down.coarse, down.hoverNone])}`);
        if (!down.consent) failures.push(`${name}: fixture: consent pending`);
        if (!/./u.test(down.status.text) || !down.status.painted || !(down.status.slot?.height > 0)) failures.push(`${name}: keyboard down: the mic-blocked row shows: ${JSON.stringify(down.status)}`);
        await keyboardUp(page, viewport); await settleLong(page);
        const pending = await read(page);
        await capture(page, `${name}-keyboard-up-pending`, pending);
        if (!pending.keyboard) failures.push(`${name}: the keyboard flag is set`);
        await page.evaluate(() => grant());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'), { timeout: 15_000 });
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const cleared = await read(page);
        await capture(page, `${name}-keyboard-up-cleared`, cleared);
        await wait(page, 2000); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const later = await read(page);
        await capture(page, `${name}-keyboard-up-cleared-plus-2s`, later);
        for (const [when, state] of [['pending', pending], ['cleared', cleared], ['cleared + 2 s', later]]) {
          if (!state.keyboard) failures.push(`${name} ${when}: the keyboard stays up`);
          if (state.lines < 1) failures.push(`${name} ${when}: at least one whole transcript line is visible: ${JSON.stringify(brief(state))}`);
          // The mic-blocked row collapses while the keyboard is up; its words stay for assistive technology.
          if (state.status.painted || (state.status.slot?.height ?? 0) > .5) failures.push(`${name} ${when}: the mic-blocked row collapses with the keyboard up: ${JSON.stringify(state.status)}`);
          if (!/./u.test(state.status.text)) failures.push(`${name} ${when}: the mic-blocked words stay in the DOM: ${JSON.stringify(state.status)}`);
          // The AI notice stays (a required disclosure).
          if (!state.noticePainted || !(state.notice?.width > 0 && state.notice?.height > 0)) failures.push(`${name} ${when}: the AI notice stays: ${JSON.stringify(state.notice)}`);
          if (state.hint?.painted) failures.push(`${name} ${when}: no shortcut hint on a touch phone: ${JSON.stringify(state.hint)}`);
        }
        for (const [when, state] of [['cleared', cleared], ['cleared + 2 s', later]]) failures.push(...stableBoxes(`${name} pending -> ${when}`, pending, state, ['mic', 'send', 'feedback', 'dock', 'field']));
        await keyboardDown(page); await settleLong(page);
        const back = await read(page);
        await capture(page, `${name}-keyboard-closed`, back);
        if (back.keyboard) failures.push(`${name}: the keyboard flag clears`);
        if (!back.status.painted || !(back.status.slot?.width > 0 && back.status.slot?.height > 0)) failures.push(`${name}: the mic-blocked row returns when the keyboard closes: ${JSON.stringify(back.status)}`);
        else if (Math.abs(back.status.slot.height - down.status.slot.height) > .5) failures.push(`${name}: the returned mic-blocked row has its keyboard-down height: ${down.status.slot.height} -> ${back.status.slot.height}`);
        t.diagnostic(`${name}: room down/pending/cleared/+2 s ${down.room.toFixed(1)} / ${pending.room.toFixed(1)} / ${cleared.room.toFixed(1)} / ${later.room.toFixed(1)}; lines ${pending.lines} / ${cleared.lines} / ${later.lines}; dock ${pending.dock?.height} / ${cleared.dock?.height}; band ${pending.band?.height}; notice ${pending.notice?.height}; status ${JSON.stringify(pending.status.slot)}; Send y ${pending.send?.y} / ${cleared.send?.y} / ${later.send?.y}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (b) The hint: absent on a touch phone (keyboard down and up, never toggling
// while typing, its box kept), present on a phone-sized window with a
// hardware keyboard and pointer, and on desktop.
export async function keyboardHintCheck(t) {
  const { open, read, capture } = await harness(t);
  for (const locale of ['en', 'de']) {
    await t.test(`320x568-${locale}-touch-no-hint`, async () => {
      const name = `320x568-${locale}-touch-no-hint`, problems = [], failures = [];
      const page = await open({ width: 320, height: 568, locale, granted: true }, problems);
      try {
        const down = await read(page);
        await capture(page, `${name}-keyboard-down`, down);
        if (!down.coarse || !down.hoverNone) failures.push(`${name}: fixture: a touch phone: ${JSON.stringify([down.coarse, down.hoverNone])}`);
        if (!down.hint?.text) failures.push(`${name}: fixture: the idle hint is in the DOM: ${JSON.stringify(down.hint)}`);
        if (down.hint?.painted) failures.push(`${name}: keyboard down: the hint is not painted on a touch phone: ${JSON.stringify(down.hint)}`);
        await keyboardUp(page, 308); await settleLong(page);
        const states = [];
        for (const lines of [1, 2, 3]) {
          await page.$eval('aithema-session', (c, lines) => { const input = c.shadowRoot.querySelector('textarea');
            input.value = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n'); input.dispatchEvent(new Event('input', { bubbles: true })); }, lines);
          await settleLong(page); states.push(await read(page));
        }
        await capture(page, `${name}-keyboard-up-typing`, states.at(-1));
        for (const [i, state] of states.entries()) if (state.hint?.painted) failures.push(`${name}: typing (${i + 1} lines): the hint never appears: ${JSON.stringify(state.hint)}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
    for (const [width, height] of [[320, 568], [1440, 900]]) {
      const name = `${width}x${height}-${locale}-hardware-keyboard-hint`;
      await t.test(name, async () => {
        const problems = [], failures = [];
        const page = await open({ width, height, locale, granted: true, touch: false }, problems);
        try {
          const state = await read(page);
          await capture(page, name, state);
          if (state.coarse || state.hoverNone) failures.push(`${name}: fixture: a fine pointer with hover: ${JSON.stringify([state.coarse, state.hoverNone])}`);
          if (!state.hint?.painted || !(state.hint.box?.width > 0 && state.hint.box?.height > 0) || !/Enter/u.test(state.hint.text)) failures.push(`${name}: the hint shows: ${JSON.stringify(state.hint)}`);
          if (!state.status.painted || !(state.status.slot?.height > 0)) failures.push(`${name}: the mic-blocked row shows: ${JSON.stringify(state.status)}`);
        } finally { await page.close(); }
        none(failures, name);
        assert.deepEqual(problems, []);
      });
    }
  }
}

// (c) AIT-618 r2, TICK's decision (a)+(b) after r1: while the phone keyboard is
// up the voice band is ONE 44 px row (the small band orb at the start, the
// pause/resume control and the settings gear, each at its keyboard-down
// horizontal position and size; the volume control and the wave/level line
// are hidden and leave the focus order), and the AI notice is ONE text line
// with its 44 px "More" target as an overlap (k1's consent-action pattern).
// Both change only when the keyboard opens or closes: the row is 44 px whether
// a reply plays or is paused, and nothing moves within the keyboard-up state.
// A reply playing/paused is emulated with the attributes the session sets
// (band orb data-voice, rail data-state, the pause control's aria-pressed):
// this check is about geometry, and no provider or audio runs here.
const bandState = c => {
  const root = c.shadowRoot, box = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const painted = n => Boolean(n) && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().height > .5
    && n.getBoundingClientRect().width > .5 && [...(function* up(e) { for (; e && e !== root; e = e.parentElement ?? e.parentNode?.host) yield e; })(n)].every(e => getComputedStyle(e).clipPath === 'none');
  const cell = root.querySelector('.voice-cell--pause');
  const pause = [...(cell?.querySelectorAll(':scope > button') ?? [])].find(painted) ?? null;
  const output = [...root.querySelectorAll('.voice-cell--output > button, .voice-signal, .voice-wave')];
  const notice = root.querySelector('.composer-notice'), more = root.querySelector('.composer-notice__more');
  const noticeLines = (() => { if (!notice) return 0; const tops = new Set(); const walker = document.createTreeWalker(notice, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement.checkVisibility()) continue; const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > .5 && r.height > .5) tops.add(Math.round(r.top)); } return tops.size; })();
  const moreTarget = more ? (() => { const after = getComputedStyle(more, '::after'); const r = more.getBoundingClientRect();
    return { content: after.content, height: parseFloat(after.height) || 0, width: parseFloat(after.width) || r.width, hit: (() => {
      const x = r.left + r.width / 2, y = r.top + r.height / 2 + 14; const hit = c.shadowRoot.elementFromPoint(x, y); return hit === more || more.contains(hit); })() }; })() : null;
  // r3 (TICK r2 M1, Codex gate1c), inside bandState ($eval serializes only this function): the notice line's insets against the field text's, and every
  // 44 px hit target of the dock and the band (an overlap ::after counts with its own box).
  const insetState = c => {
    const root = c.shadowRoot, rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const hitOf = n => { if (!n) return null; const r = n.getBoundingClientRect(), a = getComputedStyle(n, '::after');
      if (a.content === 'none' || a.position !== 'absolute') return rect(n);
      const width = parseFloat(a.width) || r.width, height = parseFloat(a.height) || 0;
      return { x: r.x + (parseFloat(a.left) || 0), y: r.y + (parseFloat(a.top) || 0), width, height }; };
    const composer = root.querySelector('.composer'), field = root.querySelector('textarea'), first = root.querySelector('.composer-notice__first');
    if (!composer || !field) return {};
    const d = composer.getBoundingClientRect(), dc = getComputedStyle(composer), f = field.getBoundingClientRect(), fc = getComputedStyle(field);
    const text = (() => { const node = [...(first?.childNodes ?? [])].find(n => n.nodeType === 3 && n.textContent.trim()); if (!node) return null;
      const range = document.createRange(); range.selectNodeContents(node); const r = range.getClientRects()[0]; return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })();
    const fieldText = { left: f.left + parseFloat(fc.borderLeftWidth) + parseFloat(fc.paddingLeft), top: f.top + parseFloat(fc.borderTopWidth) + parseFloat(fc.paddingTop) };
    const action = root.querySelector('.composer-feedback .composer-reason[data-consent-feature="text"] > .consent-action');
    const targets = [['field', field], ['mic', root.querySelector('.composer-mic')], ['send', root.querySelector('.send')], ['consent action', action],
      ...[...root.querySelectorAll('.composer-feedback :is(button, a[href])')].filter(n => n !== action).map(n => ['feedback control', n])]
      .filter(([, n]) => n && n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().width > .5).map(([name, n]) => [name, hitOf(n)]);
    const header = [...root.querySelectorAll('.band .header-actions :is(button, [slot]), .band .header-actions slot')]
      .flatMap(n => n.localName === 'slot' ? n.assignedElements() : [n])
      .filter(n => n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().width > .5 && n.getBoundingClientRect().height > .5)
      .map(n => [n.className || n.localName, rect(n)]);
    return {
      composerBox: rect(composer), composerBorder: { bottom: parseFloat(dc.borderBottomWidth), left: parseFloat(dc.borderLeftWidth) },
      noticeText: text, fieldText,
      insets: text ? { fieldLeft: +(fieldText.left - d.left).toFixed(2), fieldTop: +(fieldText.top - d.top).toFixed(2),
        noticeLeft: +(text.x - d.left).toFixed(2), noticeBottom: +(d.bottom - (text.y + text.height)).toFixed(2) } : null,
      moreHit: hitOf(root.querySelector('.composer-notice__more')), targets, header,
    };
  };
  const status = root.querySelector('.audio-rail .voice-state');
  return {
    keyboard: root.querySelector('.workspace').hasAttribute('data-phone-keyboard'), bandUp: root.querySelector('.workspace').hasAttribute('data-phone-keyboard-band'),
    band: box(root.querySelector('.band')), orb: box(root.querySelector('.band-orb')), orbPainted: painted(root.querySelector('.band-orb .orb') ?? root.querySelector('.band-orb')),
    orbVoice: root.querySelector('.band-orb .orb')?.dataset.voice ?? null,
    pause: box(pause), pauseName: pause ? (pause.getAttribute('aria-label') || pause.textContent).trim() : '', pausePressed: pause?.getAttribute('aria-pressed') ?? null,
    pauseHit: pause ? (() => { const r = pause.getBoundingClientRect(); const hit = c.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === pause || pause.contains(hit); })() : false,
    pauseHitBy: pause ? (() => { const r = pause.getBoundingClientRect(); const hit = c.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit ? `${hit.tagName.toLowerCase()}.${String(hit.className?.baseVal ?? hit.className).split(' ').join('.')}` : null; })() : null,
    pauseInert: Boolean(pause?.closest('[inert]')), pauseDisabled: Boolean(pause?.disabled),
    // Geometry only: with the rail live (its inert lifted for this one hit test), nothing covers pause.
    pauseHitLive: pause ? (() => { const inert = [...(function* up(e) { for (; e && e !== root; e = e.parentElement) yield e; })(pause)].filter(e => e.inert);
      for (const e of inert) e.inert = false; try { const r = pause.getBoundingClientRect(); const hit = c.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === pause || pause.contains(hit); }
      finally { for (const e of inert) e.inert = true; } })() : false,
    pauseHitLiveBy: pause ? (() => { const inert = [...(function* up(e) { for (; e && e !== root; e = e.parentElement) yield e; })(pause)].filter(e => e.inert);
      for (const e of inert) e.inert = false; try { const r = pause.getBoundingClientRect(); const hit = c.shadowRoot.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit ? `${hit.tagName.toLowerCase()}.${String(hit.className?.baseVal ?? hit.className).split(' ').join('.')}${hit.parentElement ? ` in ${hit.parentElement.className}` : ''}` : null; }
      finally { for (const e of inert) e.inert = true; } })() : null,
    pauseClass: pause?.className ?? null,
    gear: box(root.querySelector('.settings-open')), gearPainted: painted(root.querySelector('.settings-open')),
    gearName: (root.querySelector('.settings-open')?.textContent ?? '').trim(),
    outputPainted: output.filter(painted).map(n => n.className.baseVal ?? n.className),
    outputFocusable: [...root.querySelectorAll('.voice-cell--output > button')].filter(n => n.checkVisibility({ visibilityProperty: true }) && !n.disabled && n.tabIndex >= 0).map(n => n.className),
    status: status ? { text: status.textContent.trim(), inTree: status.checkVisibility({ visibilityProperty: true }) || getComputedStyle(status).display !== 'none' && getComputedStyle(status).visibility !== 'hidden', role: status.getAttribute('role') } : null,
    notice: box(notice), noticeLines, noticeLineHeight: notice ? parseFloat(getComputedStyle(notice).lineHeight) || 0 : 0, more: box(more), moreTarget,
    mic: box(root.querySelector('.composer-mic')), send: box(root.querySelector('.send')), dock: box(root.querySelector('.composer-dock')),
    ...insetState(c),
  };
};
const intersects = (a, b) => a && b && a.x < b.x + b.width - .5 && b.x < a.x + a.width - .5 && a.y < b.y + b.height - .5 && b.y < a.y + a.height - .5;
// The notice line: the field text's left inset and at least its top inset at the bottom; "More" keeps a
// 44 px target inside the dock box that intersects no other target.
const noticeTargets = (tag, s) => {
  const failures = [], more = s.moreHit, d = s.composerBox;
  if (!s.insets || !(s.noticeText?.width > 0 && s.noticeText?.height > 0)) return [`${tag}: the notice line has a positive text box: ${JSON.stringify(s.noticeText)}`];
  if (Math.abs(s.insets.noticeLeft - s.insets.fieldLeft) > .5) failures.push(`${tag}: the notice text starts at the field text's left inset: ${JSON.stringify(s.insets)}`);
  if (s.insets.noticeBottom < s.insets.fieldTop - .5) failures.push(`${tag}: the notice line's bottom inset is at least the field text's top inset: ${JSON.stringify(s.insets)}`);
  if (!(more?.width > 0) || more.height < 44 - .5) failures.push(`${tag}: "More" has a 44 px target: ${JSON.stringify(more)}`);
  else if (more.y < d.y - .5 || more.y + more.height > d.y + d.height - s.composerBorder.bottom + .5 || more.x < d.x - .5 || more.x + more.width > d.x + d.width + .5)
    failures.push(`${tag}: the "More" target stays inside the dock box: ${JSON.stringify([more, d])}`);
  for (const [name, target] of s.targets) if (intersects(more, target)) failures.push(`${tag}: the "More" target intersects the ${name} target: ${JSON.stringify([more, target])}`);
  // r4 (Codex gate2c Low): no fractional overlap either. Where "More" and the consent target share
  // columns, More's top is at or below the consent target's bottom exactly (0 tolerance; 1/64 px fails).
  for (const [name, target] of s.targets) if (name === 'consent action' && target?.width > 0 && more.x < target.x + target.width && target.x < more.x + more.width
    && more.y < target.y + target.height && target.y < more.y + more.height) failures.push(`${tag}: the "More" target starts at or below the consent target's bottom exactly: ${more.y} < ${target.y + target.height}`);
  return failures;
};
// r3 (Codex gate1c Medium 1): a paused CALL as the product renders it: the rail presses its own
// pause button (audio-rail.js render: the hidden twin in the same cell) and the session mirrors
// that onto the visible pause (#syncVoicePause). Both are pressed, as in the product.
const reply = (page, playing) => page.$eval('aithema-session', (c, playing) => {
  const root = c.shadowRoot;
  root.querySelector('.band-orb .orb')?.setAttribute('data-voice', playing ? 'speaking' : 'paused');
  const rail = root.querySelector('.audio-rail'); if (rail) rail.dataset.state = playing ? 'speaking' : 'paused';
  for (const pause of root.querySelectorAll('.voice-cell--pause > :is(.pause, .voice-pause)')) pause.setAttribute('aria-pressed', String(!playing));
}, playing);
// The conversation pause through its real toggle: the visible pause's click handler posts the
// pause and the session renders the acknowledged session.paused event.
const togglePause = async (page, paused) => {
  await page.$eval('aithema-session', c => {
    if (!globalThis.pauseRoute) {
      globalThis.pauseRoute = true; const fixtureFetch = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => /\/api\/sessions\/[^/]+\/pause$/u.test(String(url))
        ? Response.json({ event: { seq: c.session.seq + 1, type: 'session.paused', data: { paused: JSON.parse(options.body).paused } } }) : fixtureFetch(url, options);
    }
    c.shadowRoot.querySelector('.voice-cell--pause > .pause').click();
  });
  await page.waitForFunction(paused => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-cell--pause > .pause')?.getAttribute('aria-pressed') === String(paused), { timeout: 15_000 }, paused);
};

export async function keyboardBandCheck(t) {
  const { open, read, capture, crop } = await harness(t);
  const readBand = page => page.$eval('aithema-session', bandState);
  const [width, height] = [320, 568];
  for (const viewport of [308, 340]) for (const intake of ['image', 'document']) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-${intake}-dock-band`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake }, problems);
      try {
        await reply(page, true); await settleLong(page);
        const down = await readBand(page);
        await capture(page, `${name}-keyboard-down-playing`, { ...(await read(page)), band: down });
        await reply(page, false); await settleLong(page);
        const downPaused = await readBand(page);
        await capture(page, `${name}-keyboard-down-paused`, { ...(await read(page)), band: downPaused });
        await reply(page, true); await settleLong(page);
        for (const part of ['band', 'orb', 'pause', 'gear']) if (!(down[part]?.width > 0 && down[part]?.height > 0)) failures.push(`${name}: keyboard down: ${part} positive box: ${JSON.stringify(down[part])}`);
        if (!down.outputPainted.length) failures.push(`${name}: fixture: the volume control shows with the keyboard down`);
        await keyboardUp(page, viewport); await settleLong(page);
        const states = [];
        const step = async (label, playing) => {
          await reply(page, playing); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
          const room = await read(page), band = await readBand(page);
          states.push([label, room, band]); await capture(page, `${name}-keyboard-up-${label}`, { ...room, band });
          if (['pending-playing', 'cleared-playing'].includes(label)) await crop(page, `${name}-keyboard-up-${label}`, band.dock);
        };
        await step('pending-playing', true);
        await step('pending-paused', false);
        await page.evaluate(() => grant());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'), { timeout: 15_000 });
        await step('cleared-paused', false);
        await step('cleared-playing', true);
        await wait(page, 2000); await step('cleared-playing-plus-2s', true);
        const [, firstRoom, first] = states[0];
        for (const [label, room, band] of states) {
          const tag = `${name} ${label}`;
          if (!band.keyboard) failures.push(`${tag}: the keyboard stays up`);
          if (room.lines < 1) failures.push(`${tag}: at least one whole transcript line is visible: ${JSON.stringify(brief(room))}`);
          if (!(band.band?.width > 0) || Math.abs(band.band.height - 44) > .5) failures.push(`${tag}: the band is one 44 px row: ${JSON.stringify(band.band)}`);
          for (const part of ['orb', 'pause', 'gear']) {
            const a = down[part], b = band[part];
            if (!(b?.width > 0 && b?.height > 0)) { failures.push(`${tag}: ${part} stays, positive box: ${JSON.stringify(b)}`); continue; }
            for (const key of ['x', 'width', 'height']) if (Math.abs(a[key] - b[key]) > .5) failures.push(`${tag}: ${part} keeps its keyboard-down ${key}: ${a[key]} -> ${b[key]}`);
            if (b.y < band.band.y - .5 || b.y + b.height > band.band.y + band.band.height + .5) failures.push(`${tag}: ${part} sits inside the 44 px band: ${JSON.stringify([b, band.band])}`);
          }
          if (!band.orbPainted) failures.push(`${tag}: the small orb is painted`);
          if (!band.gearPainted || !band.gearName) failures.push(`${tag}: the gear is painted and keeps its name: ${band.gearName}`);
          // Reachable as with the keyboard down: the same hit-test result, inert and disabled state (this ready-stage fixture's
          // rail answers its own way before a conversation; the keyboard must not change it).
          if (!band.pauseName || band.pauseHit !== down.pauseHit || band.pauseInert !== down.pauseInert || band.pauseDisabled !== down.pauseDisabled)
            failures.push(`${tag}: pause/resume keeps its name and its keyboard-down reachability: ${JSON.stringify([band.pauseName, [down.pauseHit, down.pauseHitBy, down.pauseInert, down.pauseDisabled], [band.pauseHit, band.pauseHitBy, band.pauseInert, band.pauseDisabled]])}`);
          // Like for like: the keyboard-down state with the same reply state (playing or paused).
          const same = /paused/u.test(label) ? downPaused : down;
          if (!down.pauseHitLive || !downPaused.pauseHitLive || band.pauseHitLive !== same.pauseHitLive) failures.push(`${tag}: with the rail live nothing covers pause, as with the keyboard down: ${JSON.stringify([[down.pauseHitLive, down.pauseHitLiveBy], [same.pauseHitLive, same.pauseHitLiveBy], [band.pauseHitLive, band.pauseHitLiveBy, band.pauseClass]])}`);
          if (band.outputPainted.length || band.outputFocusable.length) failures.push(`${tag}: the volume control and level line are hidden and out of the focus order: ${JSON.stringify([band.outputPainted, band.outputFocusable])}`);
          if (band.status?.text && !band.status.inTree) failures.push(`${tag}: the rail's status stays in the accessibility tree: ${JSON.stringify(band.status)}`);
          if (band.noticeLines !== 1 || !(band.notice?.height > 0) || band.notice.height > band.noticeLineHeight * 1.5 + .5) failures.push(`${tag}: the AI notice is one text line: ${JSON.stringify([band.noticeLines, band.notice, band.noticeLineHeight])}`);
          if (!band.moreTarget || Math.max(band.moreTarget.height, band.more?.height ?? 0) < 44 - .5 || !(band.more?.width > 0 && band.more?.height > 0)) failures.push(`${tag}: "More" keeps a 44 px target over its line: ${JSON.stringify([band.more, band.moreTarget])}`);
          failures.push(...stableBoxes(`${tag} vs pending-playing`, first, band, ['band', 'orb', 'pause', 'gear', 'mic', 'send', 'notice', 'more']));
          failures.push(...stableBoxes(`${tag} vs pending-playing (dock)`, firstRoom, room, ['mic', 'send', 'feedback', 'dock', 'field']));
          // r3 (TICK r2 M1, Codex gate1c Medium 3): the notice line's insets and the "More" target.
          failures.push(...noticeTargets(tag, band));
          // r3 (Codex gate1c Medium 1): the painted pause is the session's own control and takes the hit, playing and paused.
          if (!/\bpause\b/u.test(band.pauseClass ?? '') || !band.pauseHitLive) failures.push(`${tag}: the visible pause takes the hit at its centre: ${JSON.stringify([band.pauseClass, band.pauseHitLiveBy])}`);
        }
        // r3 (Codex gate1c Medium 1): the conversation pause through its real toggle, keyboard up: pressed and released, pause stays put and takes the hit.
        for (const paused of [true, false]) {
          await togglePause(page, paused); await settleLong(page);
          const toggled = await readBand(page), tag = `${name} keyboard up, conversation ${paused ? 'paused' : 'resumed'} by the real toggle`;
          // Pausing the conversation disables the composer, so focus leaves the field (AIT-188: the keyboard flag clears);
          // the viewport is still short, so the compact band stays and Pause with it.
          if (!toggled.bandUp) failures.push(`${tag}: the keyboard-up band stays`);
          if (toggled.pausePressed !== String(paused) || !toggled.pauseHitLive) failures.push(`${tag}: the visible pause is pressed as toggled and takes the hit: ${JSON.stringify([toggled.pausePressed, toggled.pauseClass, toggled.pauseHitLiveBy])}`);
          failures.push(...stableBoxes(`${tag} vs pending-playing`, first, toggled, ['band', 'pause', 'gear']));
        }
        // r3 (Codex gate1c Medium 2): focus leaving the composer while the keyboard is still up (the viewport still short)
        // keeps the keyboard-up band: Pause does not move as focus lands in the header; only the keyboard's close ends it.
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.settings-open').focus());
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const headerFocus = await readBand(page);
        if (!headerFocus.bandUp) failures.push(`${name}: header focus with the viewport still short: the keyboard-up band stays`);
        failures.push(...stableBoxes(`${name} header focus, keyboard still up`, first, headerFocus, ['band', 'orb', 'pause', 'gear']));
        await keyboardDown(page); await settleLong(page);
        const back = await readBand(page);
        await capture(page, `${name}-keyboard-closed`, { ...(await read(page)), band: back });
        if (back.keyboard || back.bandUp) failures.push(`${name}: the keyboard and band flags clear when the keyboard closes`);
        if (!back.outputPainted.length) failures.push(`${name}: the volume control returns when the keyboard closes`);
        failures.push(...stableBoxes(`${name} keyboard down -> closed`, down, back, ['band', 'orb', 'pause', 'gear']));
        t.diagnostic(`${name}: band down/up ${down.band?.height} / ${first.band?.height}; lines ${states.map(([label, room]) => `${label}=${room.lines}`).join(' ')}; room ${states.map(([, room]) => room.room.toFixed(1)).join('/')}; notice ${first.notice?.height} (${first.noticeLines} line); insets ${JSON.stringify(first.insets)}; More hit ${JSON.stringify(first.moreHit)}; pause x ${down.pause?.x} -> ${first.pause?.x}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (d) AIT-618 r3 (Codex gate1c Medium 3): on a PLAIN dock (no image or document
// intake) the pending consent row has no floor; with a long host action its
// 44 px consent target and the notice's 44 px "More" target never intersect,
// pending and cleared, and "More" stays inside the dock box (320x568, vv308 and
// vv340, EN/DE; the saved long-action case of AIT-603 PR-A r5).
const LONG_ACTION = { en: { action: 'Review and agree to sending your messages now…', actionNarrow: 'Review and agree to message sending' },
  de: { action: 'Verarbeitung prüfen und jetzt gleich zustimmen…', actionNarrow: 'Verarbeitung prüfen, zustimmen' } };
export async function keyboardTargetsCheck(t) {
  const { open, read, capture } = await harness(t);
  const readBand = page => page.$eval('aithema-session', bandState);
  const [width, height] = [320, 568];
  for (const viewport of [308, 340]) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-plain-dock-long-action`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, consent: LONG_ACTION[locale] }, problems);
      try {
        await keyboardUp(page, viewport); await settleLong(page);
        const pending = await readBand(page), pendingRoom = await read(page);
        await capture(page, `${name}-keyboard-up-pending`, { ...pendingRoom, band: pending });
        if (!pending.keyboard) failures.push(`${name}: the keyboard flag is set`);
        if (!pending.targets.some(([target]) => target === 'consent action')) failures.push(`${name}: fixture: the consent action is a target: ${JSON.stringify(pending.targets)}`);
        await page.evaluate(() => grant());
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason[data-consent-feature="text"]'), { timeout: 15_000 });
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const cleared = await readBand(page), clearedRoom = await read(page);
        await capture(page, `${name}-keyboard-up-cleared`, { ...clearedRoom, band: cleared });
        for (const [when, band, room] of [['pending', pending, pendingRoom], ['cleared', cleared, clearedRoom]]) {
          failures.push(...noticeTargets(`${name} ${when}`, band));
          if (room.lines < 1) failures.push(`${name} ${when}: at least one whole transcript line is visible: ${JSON.stringify(brief(room))}`);
        }
        failures.push(...stableBoxes(`${name} pending -> cleared`, pending, cleared, ['mic', 'send', 'dock', 'notice', 'more']));
        t.diagnostic(`${name}: lines ${pendingRoom.lines} / ${clearedRoom.lines}; room ${pendingRoom.room.toFixed(1)} / ${clearedRoom.room.toFixed(1)}; More hit ${JSON.stringify(pending.moreHit)}; targets ${JSON.stringify(pending.targets)}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (e) AIT-618 r3 (Codex gate1c Medium 4): a host with Conversations, Contact and
// Settings in the header. With the keyboard up no band target intersects
// another (the small orb, pause/resume, the host controls, the gear), Pause keeps
// its keyboard-down box, and at least one whole transcript line stays visible
// (320x568, vv308 and vv340, EN/DE, image dock).
export async function keyboardHostBandCheck(t) {
  const { open, read, capture } = await harness(t);
  const readBand = page => page.$eval('aithema-session', bandState);
  const [width, height] = [320, 568];
  const bandTargets = band => [['orb', band.orb], ['pause', band.pause], ...band.header];
  const crossings = (tag, band) => {
    const failures = [], targets = bandTargets(band);
    for (const [part, box] of targets) if (!(box?.width > 0 && box?.height > 0)) failures.push(`${tag}: ${part} positive box: ${JSON.stringify(box)}`);
    for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++)
      if (intersects(targets[i][1], targets[j][1])) failures.push(`${tag}: the ${targets[i][0]} and ${targets[j][0]} targets intersect: ${JSON.stringify([targets[i][1], targets[j][1]])}`);
    return failures;
  };
  for (const viewport of [308, 340]) for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-host-header-band`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image', host: { library: true }, contact: true }, problems);
      try {
        await reply(page, true); await settleLong(page);
        const down = await readBand(page);
        await capture(page, `${name}-keyboard-down`, { ...(await read(page)), band: down });
        const names = down.header.map(([part]) => part).join(' ');
        if (!/conversations-toggle/u.test(names) || !/settings-open/u.test(names) || down.header.length < 3) failures.push(`${name}: fixture: Conversations, Contact and Settings in the header: ${names}`);
        failures.push(...crossings(`${name} keyboard down`, down));
        await keyboardUp(page, viewport); await settleLong(page);
        const up = await readBand(page), room = await read(page);
        await capture(page, `${name}-keyboard-up`, { ...room, band: up });
        if (!up.keyboard) failures.push(`${name}: the keyboard flag is set`);
        failures.push(...crossings(`${name} keyboard up`, up));
        for (const key of ['x', 'width', 'height']) if (Math.abs(up.pause[key] - down.pause[key]) > .5) failures.push(`${name}: pause keeps its keyboard-down ${key}: ${down.pause[key]} -> ${up.pause[key]}`);
        if (!up.pauseHitLive) failures.push(`${name}: the visible pause takes the hit: ${up.pauseHitLiveBy}`);
        if (up.outputPainted.length) failures.push(`${name}: the volume control is hidden with the keyboard up: ${JSON.stringify(up.outputPainted)}`);
        if (room.lines < 1) failures.push(`${name}: at least one whole transcript line is visible: ${JSON.stringify(brief(room))}`);
        failures.push(...noticeTargets(`${name} keyboard up`, up));
        // r4 (TICK Q2, Codex gate2c M3): the approved 88 px exception. Pause keeps x 170 in both layouts, and the row
        // decision latches when the keyboard opens: a host slot change (Contact removed, then added back) never flips it
        // while the keyboard is up; nothing in the band or the dock moves.
        for (const [when, band] of [['keyboard down', down], ['keyboard up', up]]) if (Math.abs((band.pause?.x ?? -1) - 170) > .5) failures.push(`${name} ${when}: pause sits at x 170: ${JSON.stringify(band.pause)}`);
        if (Math.abs((up.band?.height ?? 0) - 88) > .5) failures.push(`${name}: fixture: the host header takes the pause column, so the band keeps the rail row (88 px): ${JSON.stringify(up.band)}`);
        for (const [step, change] of [['contact removed', 'remove'], ['contact added back', 'add']]) {
          await page.$eval('aithema-session', (c, change, locale) => {
            if (change === 'remove') c.querySelector('[slot="contact-launcher"]')?.remove();
            else { const button = document.createElement('button'); button.type = 'button'; button.slot = 'contact-launcher';
              button.textContent = locale === 'de' ? 'Kontakt' : 'Contact'; button.style.cssText = 'width:44px;height:44px;overflow:hidden'; c.append(button); }
          }, change, locale);
          await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
          const changed = await readBand(page), changedRoom = await read(page);
          await capture(page, `${name}-keyboard-up-${step.replace(/\s+/gu, '-')}`, { ...changedRoom, band: changed });
          if (!changed.keyboard) failures.push(`${name} ${step}: the keyboard stays up`);
          failures.push(...stableBoxes(`${name} ${step} (band)`, up, changed, ['band', 'orb', 'pause', 'gear', 'notice', 'more']));
          failures.push(...stableBoxes(`${name} ${step} (dock)`, room, changedRoom, ['mic', 'send', 'feedback', 'dock', 'field']));
          if (changedRoom.lines < 1) failures.push(`${name} ${step}: at least one whole transcript line is visible: ${JSON.stringify(brief(changedRoom))}`);
        }
        t.diagnostic(`${name}: band down/up ${down.band?.height} / ${up.band?.height}; lines ${room.lines}; room ${room.room.toFixed(1)}; pause ${JSON.stringify(up.pause)}; header ${JSON.stringify(up.header)}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (f) AIT-618 r4 (TICK Q1 (a), Codex gate2c M1): ONE keyboard-up state. Footer, dock, feedback latch,
// notice/More and the compact band open together (focus in the composer, the viewport obstructed) and
// end together, in ONE reflow: when the viewport grows back, or (AIT-188's stale-height escape) at the
// settle (~1 s, an injected clock here) after focus left the composer. A header tap and a real Pause that
// disables the composer move nothing before that end. 320x568 vv308, EN/DE, image dock.
const settleParts = { room: ['dock', 'mic', 'send', 'feedback', 'field', 'notice'], band: ['band', 'pause'] };
export async function keyboardSettleCheck(t) {
  const { open, read, capture } = await harness(t);
  const readBand = page => page.$eval('aithema-session', bandState);
  const [width, height, viewport] = [320, 568, 308];
  const both = async page => ({ room: await read(page), band: await readBand(page) });
  for (const locale of ['en', 'de']) for (const cause of ['header-tap', 'pause-disables-composer']) for (const end of ['settle', 'viewport-grows']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-image-dock-${cause}-ends-by-${end}`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image' }, problems);
      try {
        if (!page.settleClock) failures.push(`${name}: the keyboard settle clock is injectable (layout.js keyboardSettle)`);
        await reply(page, true); await settleLong(page);
        await keyboardUp(page, viewport); await settleLong(page);
        const before = await both(page);
        await capture(page, `${name}-1-before`, { ...before.room, band: before.band });
        if (cause === 'header-tap') await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.settings-open').focus());
        else await togglePause(page, true);
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const during = await both(page), settles = await pendingSettles(page);
        await capture(page, `${name}-2-during`, { ...during.room, band: during.band, settles });
        const editing = await page.$eval('aithema-session', c => Boolean(c.shadowRoot.activeElement?.closest('.composer')));
        if (editing) failures.push(`${name}: fixture: focus left the composer`);
        // DURING: focus is out, the viewport is still small, the settle has not run: nothing moves.
        if (!before.room.keyboard || !before.band.bandUp) failures.push(`${name}: before: the keyboard-up state is open: ${JSON.stringify([before.room.keyboard, before.band.bandUp])}`);
        if (!during.room.keyboard || !during.band.bandUp) failures.push(`${name}: during: the ONE keyboard-up state stays until its end (footer, dock and band together): ${JSON.stringify([during.room.keyboard, during.band.bandUp])}`);
        if (during.room.footerShown !== before.room.footerShown) failures.push(`${name}: during: the footer stays as it was: ${before.room.footerShown} -> ${during.room.footerShown}`);
        failures.push(...stableBoxes(`${name} before -> during (dock)`, before.room, during.room, settleParts.room));
        failures.push(...stableBoxes(`${name} before -> during (band)`, before.band, during.band, settleParts.band));
        if (page.settleClock && end === 'settle' && !settles.length) failures.push(`${name}: during: a settle is pending`);
        if (end === 'settle') await fireSettle(page);
        else await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.k1Viewport }); window.dispatchEvent(new Event('resize')); });
        await settleLong(page);
        const after = await both(page);
        await capture(page, `${name}-3-after`, { ...after.room, band: after.band });
        // AFTER: the whole state ended at once (one reflow): footer back, full band, keyboard flags clear.
        if (after.room.keyboard || after.band.bandUp) failures.push(`${name}: after: the whole keyboard-up state ended: ${JSON.stringify([after.room.keyboard, after.band.bandUp])}`);
        // The footer is back unless the visual viewport is still overlaid (AIT-188: [data-phone-short][data-phone-overlay]
        // hides it on its own, keyboard state or not): at the settle the viewport is still small, so it stays hidden.
        if (after.room.overlay !== (end === 'settle')) failures.push(`${name}: after: fixture: the viewport is ${end === 'settle' ? 'still overlaid' : 'unobstructed'}: ${after.room.overlay}`);
        if (end === 'settle' && after.room.footerShown) failures.push(`${name}: after: the overlaid viewport keeps the footer hidden (AIT-188 overlay rule)`);
        if (end !== 'settle' && (!after.room.footerShown || !(after.room.footer?.width > 0 && after.room.footer?.height > 0))) failures.push(`${name}: after: the footer is back with a positive box: ${JSON.stringify(after.room.footer)}`);
        if (!(after.band.band?.height > 44 + .5)) failures.push(`${name}: after: the full band is back: ${JSON.stringify(after.band.band)}`);
        if (end === 'viewport-grows' && (await pendingSettles(page)).length) failures.push(`${name}: after: the viewport's growth cancelled the settle`);
        // ONE reflow: a further paint (and any leftover settle) changes nothing.
        await fireSettle(page); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const later = await both(page);
        failures.push(...stableBoxes(`${name} after -> later (dock)`, after.room, later.room, settleParts.room));
        failures.push(...stableBoxes(`${name} after -> later (band)`, after.band, later.band, settleParts.band));
        if (later.room.footerShown !== after.room.footerShown) failures.push(`${name}: after -> later: the footer stays`);
        t.diagnostic(`${name}: settles ${JSON.stringify(settles)}; before/during/after keyboard ${before.room.keyboard}/${during.room.keyboard}/${after.room.keyboard}, band ${before.band.band?.height}/${during.band.band?.height}/${after.band.band?.height}; pause ${JSON.stringify(before.band.pause)} -> ${JSON.stringify(during.band.pause)}; Send y ${before.room.send?.y} / ${during.room.send?.y} / ${after.room.send?.y}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
  // No latch after blur (gate2c M1 tail): a same-width height drop on a touch device with focus OUTSIDE the
  // composer never opens the state, neither before a keyboard ever opened nor after the settle ended one.
  for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-${locale}-image-dock-height-drop-after-blur`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image' }, problems);
      const drop = h => page.evaluate(h => {
        globalThis.k1Viewport ??= visualViewport;
        const viewport = new EventTarget(); Object.assign(viewport, { height: h, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        window.dispatchEvent(new Event('resize'));
      }, h);
      try {
        await page.$eval('aithema-session', c => { c.shadowRoot.querySelector('textarea').focus({ preventScroll: true }); });
        await settleLong(page);
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.settings-open').focus()); await settleLong(page);
        await drop(viewport); await settleLong(page);
        const first = await both(page);
        if (first.room.keyboard || first.band.bandUp) failures.push(`${name}: a height drop after blur opens no keyboard-up state: ${JSON.stringify([first.room.keyboard, first.band.bandUp])}`);
        await page.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, value: globalThis.k1Viewport }); window.dispatchEvent(new Event('resize')); });
        await settleLong(page);
        await keyboardUp(page, viewport); await settleLong(page);
        await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.settings-open').focus()); await settleLong(page);
        await fireSettle(page); await settleLong(page);
        await drop(viewport - 40); await settleLong(page);
        const second = await both(page);
        if (second.room.keyboard || second.band.bandUp) failures.push(`${name}: after the settle a further height drop with focus outside opens no state: ${JSON.stringify([second.room.keyboard, second.band.bandUp])}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}

// (g) AIT-618 r4 (Codex gate2c M2): the notice slot's 8 px pad latches with the feedback row. A held image
// (image input behind its own consent) shows its consent control in the feedback row; the hold expires on
// its own timer (180 s, an injected clock here) while the keyboard is up: Mic, Send, the field and the
// dock do not move. 320x568 vv308, EN/DE, image dock.
export async function keyboardHeldImageCheck(t) {
  const { open, read, capture } = await harness(t);
  const [width, height, viewport] = [320, 568, 308];
  for (const locale of ['en', 'de']) {
    const name = `${width}x${height}-vv${viewport}-${locale}-image-dock-held-image-expires`;
    await t.test(name, async () => {
      const problems = [], failures = [];
      const page = await open({ width, height, locale, intake: 'image', granted: true, heldImage: true }, problems);
      try {
        // The hold's 180 s timer is captured; every other timer runs natively.
        await page.evaluate(() => {
          const native = window.setTimeout.bind(window); globalThis.heldTimers = [];
          window.setTimeout = (fn, ms, ...rest) => ms === 180000 ? (globalThis.heldTimers.push(fn), -1 - globalThis.heldTimers.length) : native(fn, ms, ...rest);
        });
        await keyboardUp(page, viewport); await settleLong(page);
        await page.$eval('aithema-session', c => {
          const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([255, 216, 255, 224])], 'held.jpg', { type: 'image/jpeg' }));
          const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        });
        const shown = await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback .held-upload-consent .consent-action'), { timeout: 15_000 }).then(() => true, () => false);
        if (!shown) failures.push(`${name}: fixture: the held image shows its consent control`);
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const held = await read(page);
        await capture(page, `${name}-keyboard-up-held`, held);
        const timers = await page.evaluate(() => globalThis.heldTimers.length);
        if (!timers) failures.push(`${name}: fixture: the hold's timer is captured`);
        await page.evaluate(() => { for (const fn of globalThis.heldTimers.splice(0)) fn(); });
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer-feedback .held-upload-consent'), { timeout: 15_000 }).catch(() => failures.push(`${name}: fixture: the hold expired`));
        await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await settleLong(page);
        const expired = await read(page);
        await capture(page, `${name}-keyboard-up-expired`, expired);
        if (!held.keyboard || !expired.keyboard) failures.push(`${name}: the keyboard stays up: ${held.keyboard} / ${expired.keyboard}`);
        failures.push(...stableBoxes(`${name} held -> expired`, held, expired, ['mic', 'send', 'field', 'dock', 'feedback']));
        t.diagnostic(`${name}: dock ${held.dock?.height} -> ${expired.dock?.height}; Send y ${held.send?.y} -> ${expired.send?.y}; lines ${held.lines} / ${expired.lines}`);
      } finally { await page.close(); }
      none(failures, name);
      assert.deepEqual(problems, []);
    });
  }
}
