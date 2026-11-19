import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fixture as combinedFixture } from './combined-entrance-check.js';
import { fixture as creditFixture } from './visitor-credit-tiers-helpers.js';

const html = combinedFixture.replace("entrance:'combined'", "entrance:new URL(location.href).searchParams.get('entrance')||'combined'");
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
  await page.setViewport({ width: variant.width, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: variant.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${server.url}/first-screen-fixture?locale=${variant.locale}&entrance=${entrance}`);
  await page.waitForFunction(() => globalThis.ready);
  await page.evaluate(theme => { c.setAttribute('theme', theme); c.style.setProperty('--aithema-height', '100dvh'); }, variant.theme);
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
    await page.evaluate(() => c.configure({ host: { credits: true, usedUp: { dailyCapActions: 'none' } } }));
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
