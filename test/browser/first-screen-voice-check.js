import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fixture as combinedFixture } from './combined-entrance-check.js';
import { fixture as creditFixture } from './visitor-credit-tiers-helpers.js';

const html = combinedFixture.replace('globalThis.mount=', 'globalThis.fixtureClient=client;globalThis.mount=').replace("entrance:'combined'", "entrance:new URL(location.href).searchParams.get('entrance')||'combined'");
const variants = [{ width: 390, locale: 'de', theme: 'dark' }, { width: 1440, locale: 'en', theme: 'light' }];
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-first-screen-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'fixture.sqlite'),
    { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
  const browser = await browserForFile();
  t.after(async () => { try { await browser.close(); } finally { await server.kill(); } });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => void (new URL(r.url()).pathname === '/first-screen-fixture'
    ? r.respond({ status: 200, contentType: 'text/html', body: html }) : r.continue()));
  return { page, server };
}
async function open(page, server, variant, entrance = 'combined') {
  await page.setViewport({ width: variant.width, height: variant.height ?? 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: variant.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${server.url}/first-screen-fixture?locale=${variant.locale}&entrance=${entrance}${variant.opener ? '&opener' : ''}`);
  await page.waitForFunction(() => globalThis.ready);
  await page.evaluate(({ theme, entrance }) => {
    c.setAttribute('theme', theme); c.style.setProperty('--aithema-height', '100dvh');
    const configure = c.configure.bind(c); c.configure = options => configure({ entrance, ...options, voiceClient: options.voiceClient ?? fixtureClient });
  }, { theme: variant.theme, entrance });
}
async function observe(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  return page.evaluate(() => {
    const root = c.shadowRoot, visible = n => Boolean(n && n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const pause = root.querySelector('.pause'), rail = root.querySelector('.audio-rail');
    const geometry = Object.fromEntries(['.band', '.composer', 'textarea', '.composer-mic', '.send'].map(selector => {
      const b = root.querySelector(selector)?.getBoundingClientRect(); return [selector, b ? [b.x, b.y, b.width, b.height] : null];
    }));
    const microphones = [...root.querySelectorAll('.voice-start,.voice-input,.composer-mic')].filter(visible);
    return { geometry, call: rail.dataset.call, pause: { visible: visible(pause), pressed: pause.getAttribute('aria-pressed'),
      background: getComputedStyle(pause).backgroundColor, ink: getComputedStyle(c).getPropertyValue('--aithema-ink').trim() },
      microphones: microphones.map(n => n.className), focusableMics: microphones.filter(n => !n.disabled && !n.closest('[inert]') && n.tabIndex >= 0).map(n => n.className),
      startVisible: visible(root.querySelector('.voice-start')), inputVisible: visible(root.querySelector('.voice-input')),
      status: root.querySelector('.voice-state').textContent, idleLabel: c.copy?.voiceStates?.idle };
  });
}
function positive(geometry) {
  for (const [selector, box] of Object.entries(geometry)) assert.ok(box[2] > 0 && box[3] > 0, `${selector}: positive width and height`);
}
async function retain(page, name, record) {
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'look', 'r1'); await mkdir(dir, { recursive: true });
  await page.mouse.move(-1, -1);
  await page.screenshot({ path: join(dir, `${name}.png`) });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(record, null, 2));
}

test('AIT-553 item 1: idle pause is neutral and unpressed in both entrances; call transitions pin the combined composer', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of variants) {
    const label = `${variant.width}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant);
    const idle = await observe(page); await retain(page, `${label}-first-screen`, idle);
    await page.evaluate(() => grant());
    await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
    await page.click('aithema-session >>> .composer-mic');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
    const live = await observe(page); await retain(page, `${label}-during-call`, live);
    await page.click('aithema-session >>> .voice-close');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    const ended = await observe(page); await retain(page, `${label}-after-call`, ended);
    await open(page, server, variant, 'choice');
    const choice = await observe(page);
    records.push({ label, idle, live, ended, choice });
  }
  for (const { label, idle, live, ended, choice } of records) {
    for (const state of [idle, live, ended]) positive(state.geometry);
    assert.deepEqual(live.geometry, idle.geometry, `${label}: call start moves composer 0 px`);
    assert.deepEqual(ended.geometry, idle.geometry, `${label}: call end moves composer 0 px`);
    for (const state of [idle, choice]) {
      assert.equal(state.pause.pressed, 'false');
      assert.equal(state.pause.background, 'rgba(0, 0, 0, 0)', `${label}: idle pause has no active fill`);
    }
    assert.equal(live.pause.visible, true, 'live pause stays visible');
  }
});

test('AIT-553 item 2: combined idle and ended screens expose only the composer mic; choice keeps its Start mic', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t);
  for (const variant of variants) {
    await open(page, server, variant);
    const idle = await observe(page);
    await page.evaluate(() => grant());
    await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
    const ready = await observe(page);
    await page.click('aithema-session >>> .composer-mic');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
    const live = await observe(page);
    await page.click('aithema-session >>> .voice-close');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    const ended = await observe(page);
    await open(page, server, variant, 'choice');
    const choice = await observe(page);
    for (const state of [idle, ready, ended]) {
      assert.deepEqual(state.microphones, ['composer-mic'], 'exactly one visible mic before and after a call');
      assert.deepEqual(state.focusableMics, ['composer-mic'], 'exactly one focusable mic');
      assert.doesNotMatch(state.status, /Ready to talk|Bereit zum Sprechen/);
    }
    assert.equal(live.inputVisible, true, 'live band retains its input control');
    assert.equal(choice.startVisible, true, 'choice keeps its existing idle Start control');
  }
});

test('AIT-553 item 3: used-up upgrade copy has an exposed export link; the host can still suppress daily-cap actions', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of variants) {
    await open(page, server, variant);
    await creditFixture(page, variant.locale, { spent: 12_000_000 });
    const record = await page.evaluate(() => {
      const root = c.shadowRoot, out = root.querySelector('.composer-out'), link = root.querySelector('.composer-out__export');
      const b = link.getBoundingClientRect();
      link.focus();
      return { next: out.dataset.next, text: out.querySelector('[data-active="true"]').textContent,
        visible: link.checkVisibility({ checkVisibilityCSS: true }), hidden: link.getAttribute('aria-hidden'), inert: link.inert,
        focused: root.activeElement === link, href: link.getAttribute('href'), box: [b.x, b.y, b.width, b.height] };
    });
    await page.evaluate(() => c.shadowRoot.activeElement?.blur());
    await retain(page, `${variant.width}-${variant.locale}-${variant.theme}-used-up-upgrade`, record);
    records.push(record);
    await creditFixture(page, variant.locale, { spent: 12_000_000, dailyCap: true });
    await page.evaluate(async () => c.configure({ session: c.session, copy: (await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale], host: { credits: true, usedUp: { dailyCapActions: 'none' } } }));
    await page.waitForFunction(() => c.shadowRoot.querySelector('.composer-out').dataset.creditActions === 'none');
    assert.equal(await page.evaluate(() => c.shadowRoot.querySelector('.composer-out__export').getAttribute('aria-hidden')), 'true');
  }
  for (const record of records) {
    assert.equal(record.next, 'give'); assert.match(record.text, /export it|exportieren/);
    positive({ export: record.box });
    assert.equal(record.visible, true, 'used-up upgrade exposes the existing export control');
    assert.equal(record.hidden, 'false'); assert.equal(record.inert, false); assert.equal(record.focused, true);
    assert.match(record.href, /\/api\/sessions\/[^/]+\/export$/);
  }
});


async function entranceGeometry(page) {
  await observe(page);
  return page.evaluate(() => {
    const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const intro = root.querySelector('.intro'), card = root.querySelector('.ready'), scroller = root.querySelector('.conversation-scroll');
    const opener = root.querySelector('[data-host-opener]'), text = opener.querySelector('.turn-text');
    const range = document.createRange(); range.selectNodeContents(text);
    const lines = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    const last = lines.at(-1);
    return { boxes: { intro: box(intro), card: box(card), scroller: box(scroller), opener: box(opener), text: box(text),
      lastLine: [last.x, last.y, last.width, last.height], composer: box(root.querySelector('.composer')) },
      tracks: getComputedStyle(intro).gridTemplateRows, columns: getComputedStyle(intro).gridTemplateColumns,
      padding: parseFloat(getComputedStyle(opener).paddingBottom), border: parseFloat(getComputedStyle(opener).borderBottomWidth),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, overflow: getComputedStyle(scroller).overflowY };
  });
}

const desktops = [
  { width: 1366, height: 768, locale: 'en', theme: 'light', opener: true },
  { width: 1440, height: 900, locale: 'en', theme: 'light', opener: true },
  { width: 1280, height: 720, locale: 'en', theme: 'light', opener: true },
  { width: 1366, height: 768, locale: 'de', theme: 'dark', opener: true },
  { width: 1440, height: 900, locale: 'de', theme: 'dark', opener: true },
  { width: 1280, height: 720, locale: 'de', theme: 'dark', opener: true }
];
async function openIntro(page, server, variant) {
  await open(page, server, variant);
  await page.evaluate(async () => {
    const session = structuredClone(c.session);
    session.opener.text = session.locale === 'de'
      ? 'Willkommen. Ihre KI-Assistenz ist für Sie bereit. Erzählen Sie uns von Ihrer Idee und Ihren Anforderungen. Gemeinsam können wir die Ziele, die verfügbaren Ressourcen und die nächsten Schritte besprechen. Sie können Ihre Fragen eingeben oder das Mikrofon verwenden, um das Gespräch zu beginnen.'
      : 'Welcome. Your AI assistant is ready to help. Tell us about your idea and requirements. Together we can discuss your goals, available resources and next steps. You can type your questions or use the microphone to begin the conversation. Take your time and share whatever matters most to you.';
    c.configure({ session, copy: (await import(`/packages/ui/src/i18n/${session.locale}.js`))[session.locale] });
  });
}

test('AIT-553 item 4: combined readiness owns a readable grid track inside the scroll area above the pinned composer', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of desktops) {
    await openIntro(page, server, variant);
    const initial = await entranceGeometry(page), pinned = (await observe(page)).geometry;
    if (variant.locale === 'en' && variant.width !== 1280) await retain(page, `${variant.width}-${variant.height}-desktop-intro`, initial);
    await page.evaluate(() => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight; });
    const end = await entranceGeometry(page);
    records.push({ variant, initial, end, pinned, after: (await observe(page)).geometry });
  }
  for (const { variant, initial, end, pinned, after } of records) {
    const label = `${variant.width}/${variant.locale}: ${JSON.stringify({initial,end})}`;
    positive(initial.boxes); positive(end.boxes); positive(pinned); positive(after);
    assert.deepEqual(after, pinned, 'scrolling readiness does not move composer controls');
    assert.ok(initial.tracks.split(' ').every(track => parseFloat(track) > 0), `intro track stays positive: ${label}`);
    assert.ok(initial.boxes.card[2] >= 320, `readable card width: ${label}`);
    assert.ok(end.boxes.card[1] + end.boxes.card[3] <= end.boxes.composer[1] - 8, `card clears composer by 8 px: ${label}`);
    assert.ok(end.boxes.scroller[1] + end.boxes.scroller[3] <= end.boxes.composer[1] - 8, `scroll surface clears composer: ${label}`);
    assert.ok(['auto','scroll'].includes(end.overflow));
  }
});

test('AIT-553 item 5: desktop render-only opener ends at the last text line plus normal padding', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of desktops.filter(v => v.width === 1440)) {
    await openIntro(page, server, variant);
    const record = await entranceGeometry(page);
    await retain(page, `1440-${variant.locale}-opener`, record); records.push(record);
  }
  for (const record of records) {
    positive(record.boxes);
    const { opener, lastLine } = record.boxes;
    const whitespace = opener[1] + opener[3] - lastLine[1] - lastLine[3];
    assert.ok(whitespace <= record.padding + record.border + 8, `opener has only normal padding after text: ${JSON.stringify(record)}`);
  }
});

test('AIT-553 item 6: phone used-up confirmation stacks a one-line 44 px action below its text without moving the dock', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const locale of ['en','de']) {
    await open(page, server, { width: 390, height: 844, locale, theme: locale === 'de' ? 'dark' : 'light' });
    await creditFixture(page, locale, { address: 'visitor@example.test', delivery: true, spent: 0 });
    const before = (await observe(page)).geometry;
    await page.evaluate(() => { a2.spent = 18_000_000; c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }); });
    await page.waitForFunction(() => c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up'));
    await observe(page);
    const record = await page.evaluate(() => {
      const root = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; };
      const out = root.querySelector('.composer-out'), text = out.querySelector('.composer-out__steps [data-next="confirm"]'), button = out.querySelector('.composer-out__upgrade'), label = button.querySelector('[data-next="confirm"]');
      const range = document.createRange(); range.selectNodeContents(label);
      const lines = [...range.getClientRects()].filter(b => b.width > 0 && b.height > 0);
      return { next: out.dataset.next, boxes: { text: box(text), button: box(button), label: box(label) },
        lines: [...new Set(lines.map(b => b.y))].length, label: label.textContent, visible: button.checkVisibility({ checkVisibilityCSS: true }) };
    });
    await retain(page, `390-${locale}-used-up-confirm`, record);
    records.push({ before, after: (await observe(page)).geometry, record });
  }
  for (const { before, after, record } of records) {
    positive(before); positive(after); positive(record.boxes);
    assert.deepEqual(after, before, 'used-up confirmation leaves composer, mic and Send pinned');
    assert.equal(record.next, 'confirm'); assert.equal(record.visible, true);
    assert.ok(record.boxes.button[1] >= record.boxes.text[1] + record.boxes.text[3], `button below text: ${JSON.stringify(record)}`);
    assert.equal(record.lines, 1, 'full confirmation label stays on one line');
    assert.ok(record.boxes.button[3] >= 44);
  }
});
