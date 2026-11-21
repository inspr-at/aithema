import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fixture as combinedFixture } from './combined-entrance-check.js';
import { fixture as creditFixture } from './visitor-credit-tiers-helpers.js';

// Slice 3 (?hostrow=<brand px>): a host header row like the consumer's real page, modelled on its
// shipped geometry: 288 px host actions (account slot), headerRailReservation({ actionsWidth: '288px' })
// with the flexing rail floor (railMinWidth: voiceRailFlexMinWidth, the host's opt-in),
// a visible host brand and a 16 px host column beside the shell. The rail track is then about 700 px
// at 1366 and about 600 px at 1280.
// r2: &optout omits the opt-in (the library's default 544 px floor); &fp serves the render-blocking
// firstPaintStyles and placeholder and defers mount until the test calls mount(pendingSession).
const hostRow = `const hostRow=new URL(location.href).searchParams.get('hostrow'),hostParams=new URL(location.href).searchParams;
if(hostRow){const {headerRailReservation,voiceRailFlexMinWidth,firstPaintStyles,firstPaintMarkup}=await import('/packages/ui/src/first-paint.js');
const style=document.createElement('style');style.textContent=(hostParams.has('fp')?firstPaintStyles:'')+'body{display:flex}.host-side{flex:none;width:16px}.aithema-shell{container:aithema-shell / inline-size;flex:1;min-width:0}.aithema-shell>:is(aithema-session,.aithema-first-paint){--aithema-header-actions-width:288px}'+headerRailReservation({actionsWidth:'288px',...hostParams.has('optout')?{}:{railMinWidth:voiceRailFlexMinWidth}});document.head.append(style);
const side=document.createElement('div');side.className='host-side';const shell=document.createElement('div');shell.className='aithema-shell';
const brand=document.createElement('span');brand.slot='brand';brand.textContent='Host';brand.style.cssText='display:inline-block;width:'+Number(hostRow)+'px';
const account=document.createElement('span');account.slot='account';account.style.cssText='display:inline-block;width:200px;height:44px';
c.append(brand,account);shell.append(c);if(hostParams.has('fp'))shell.insertAdjacentHTML('beforeend',firstPaintMarkup);document.body.append(side,shell);}else document.body.append(c);`;
const html = combinedFixture.replace('globalThis.mount=', 'globalThis.fixtureClient=client;globalThis.mount=').replace("entrance:'combined'", "entrance:new URL(location.href).searchParams.get('entrance')||'combined'")
  .replace("const c=document.createElement('aithema-session');document.body.append(c);", () => `const c=document.createElement('aithema-session');${hostRow}`)
  .replace('mount(session);', () => "globalThis.pendingSession=session;if(!new URL(location.href).searchParams.has('fp'))mount(session);");
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
  await page.goto(`${server.url}/first-screen-fixture?locale=${variant.locale}&entrance=${entrance}${variant.opener ? '&opener' : ''}${variant.brand ? `&hostrow=${variant.brand}` : ''}${variant.query ? `&${variant.query}` : ''}`);
  await page.waitForFunction(() => globalThis.ready);
  await page.evaluate(({ theme, entrance }) => {
    c.setAttribute('theme', theme); c.style.setProperty('--aithema-height', '100dvh');
    const configure = c.configure.bind(c); c.configure = options => configure({ entrance, ...options, voiceClient: options.voiceClient ?? fixtureClient });
    // AIT-587 (Codex gate1c C12): record every provider Pause/Resume receipt. A pause check waits for the
    // receipt, because the rail presses Pause optimistically before the provider answers.
    // globalThis.refusedReceipt[command] replaces the provider's answer (a missing acknowledgement).
    globalThis.voiceReceipts = [];
    const start = fixtureClient.start.bind(fixtureClient);
    fixtureClient.start = async (...args) => {
      const session = await start(...args);
      for (const command of ['pause', 'resume']) {
        const send = session[command].bind(session);
        session[command] = async (...rest) => {
          const receipt = globalThis.refusedReceipt?.[command] ?? await send(...rest);
          voiceReceipts.push({ command, ...receipt }); return receipt;
        };
      }
      return session;
    };
  }, { theme: variant.theme, entrance });
}
// Press the rail's Pause (paused = true) or Resume (false) and wait until that command is acknowledged.
// A timeout throws with the label.
async function togglePause(page, paused, label, timeout = 10_000) {
  await page.evaluate(() => c.shadowRoot.querySelector('.pause').click());
  await page.waitForFunction(v => c.shadowRoot.querySelector('.pause').getAttribute('aria-pressed') === String(v)
    || c.shadowRoot.querySelector('.voice-pause').getAttribute('aria-pressed') === String(v), { timeout }, paused)
    .catch(error => { throw new Error(`${label}: the ${paused ? 'pause' : 'resume'} was not acknowledged within ${timeout / 1000} s`, { cause: error }); });
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
    // AIT-587 (AIT-553 gate1 L4): sample the pause on every rail change while the call closes.
    await page.evaluate(() => {
      const root = c.shadowRoot, rail = root.querySelector('.audio-rail'), pause = root.querySelector('.pause');
      globalThis.closingPause = [];
      const sample = () => closingPause.push({ state: rail.dataset.state, call: rail.dataset.call, pressed: pause.getAttribute('aria-pressed'),
        disabled: pause.disabled, visible: pause.checkVisibility({ checkVisibilityCSS: true }), background: getComputedStyle(pause).backgroundColor });
      globalThis.closingWatch = new MutationObserver(sample);
      closingWatch.observe(rail, { attributes: true, attributeFilter: ['data-state', 'data-call', 'data-call-reconciling'] });
    });
    await page.click('aithema-session >>> .voice-close');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    const closing = await page.evaluate(() => { closingWatch.disconnect(); return closingPause; });
    const ended = await observe(page); await retain(page, `${label}-after-call`, ended);
    // An unpressed, enabled pause is never filled: not during the call, not while it closes.
    assert.equal(live.pause.pressed, 'false', `${label}: the live pause starts unpressed`);
    assert.equal(live.pause.background, 'rgba(0, 0, 0, 0)', `${label}: the live, unpressed pause has no active fill`);
    assert.ok(closing.length > 0, `${label}: the close was sampled`);
    for (const sample of closing) if (sample.visible && !sample.disabled && sample.pressed === 'false')
      assert.equal(sample.background, 'rgba(0, 0, 0, 0)', `${label}: an unpressed pause has no active fill while closing: ${JSON.stringify(closing)}`);
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
    await page.evaluate(() => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight; });
    const end = await entranceGeometry(page);
    if (variant.locale === 'en' && variant.width !== 1280) await retain(page, `${variant.width}-${variant.height}-desktop-intro`, { initial, end });
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

// Slice 2: a host header sits above the widget, as on the consumer's page.
const shortDesktops = [
  { width: 1366, height: 768, locale: 'en', theme: 'light', opener: true },
  { width: 1366, height: 768, locale: 'de', theme: 'dark', opener: true },
  { width: 1280, height: 720, locale: 'en', theme: 'light', opener: true },
  { width: 1280, height: 720, locale: 'de', theme: 'dark', opener: true },
  { width: 1366, height: 768, locale: 'en', theme: 'dark', opener: true },
  { width: 1280, height: 720, locale: 'de', theme: 'light', opener: true }
];
const hostHeader = 64;
async function hostChrome(page) {
  await page.evaluate(height => {
    if (!document.querySelector('header.host-chrome')) {
      const header = document.createElement('header'); header.className = 'host-chrome';
      header.style.cssText = `height:${height}px;box-sizing:border-box;border-bottom:1px solid #ccc`;
      header.textContent = 'Host'; document.body.prepend(header);
    }
    c.style.setProperty('--aithema-height', `calc(100dvh - ${height}px)`);
  }, hostHeader);
}
// The middle line can carry an opener-length status between the controls.
const longStatus = { en: 'Welcome. Your AI assistant is ready to help. Tell us about your idea and requirements, your goals, resources and next steps, in your own time.',
  de: 'Willkommen. Ihre KI-Assistenz ist für Sie bereit. Erzählen Sie uns von Ihrer Idee, Ihren Zielen, Ressourcen und nächsten Schritten, ganz in Ruhe.' };
async function bandRecord(page, state) {
  // A click may scroll the host page; measure every state from the page top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await observe(page);
  return page.evaluate(state => {
    const root = c.shadowRoot, band = root.querySelector('.band'), rail = root.querySelector('.audio-rail'), top = band.getBoundingClientRect().y;
    const box = n => { const b = n.getBoundingClientRect(); return [b.x, b.y - top, b.width, b.height]; };
    const cells = Object.fromEntries(['output', 'pause', 'mic', 'end'].map(name => [name, box(root.querySelector(`.voice-cell--${name}`))]));
    const visibleControls = [...rail.querySelectorAll('button')].filter(b => b.checkVisibility({ checkVisibilityCSS: true }))
      .map(b => ({ name: b.className, box: box(b) }));
    const status = root.querySelector('.voice-state'), signal = root.querySelector('.voice-signal');
    return { state, railState: rail.dataset.state, call: rail.dataset.call, band: box(band), rail: box(rail), cells, visibleControls,
      signal: box(signal), status: { text: status.textContent, box: box(status), visible: status.checkVisibility({ checkVisibilityCSS: true }),
        scrollWidth: status.scrollWidth, clientWidth: status.clientWidth, overflow: getComputedStyle(status).overflowX,
        textOverflow: getComputedStyle(status).textOverflow, clipped: status.hasAttribute('data-clipped'), mask: getComputedStyle(status).maskImage,
        wave: getComputedStyle(root.querySelector('.voice-wave')).visibility },
      rowAttr: band.hasAttribute('data-rail-row'), scrollY, bandTop: top };
  }, state);
}

test('AIT-553 slice 2 item 1: the call band keeps one row in every voice state on short desktops with host chrome', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of shortDesktops.slice(0, 4)) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant); await hostChrome(page);
    // Host copy carries an opener-length line in every voice state.
    await page.evaluate(async text => {
      const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
      for (const key of ['connecting', 'listening', 'speaking', 'paused', 'failed']) copy.voiceStates[key] = text;
      c.configure({ session: c.session, copy });
    }, longStatus[variant.locale]);
    const states = [await bandRecord(page, 'idle')];
    // Every transient rail state (connecting included) is sampled synchronously.
    await page.evaluate(() => {
      const root = c.shadowRoot, band = root.querySelector('.band'), rail = root.querySelector('.audio-rail');
      globalThis.bandSamples = [];
      const sample = () => { const b = band.getBoundingClientRect();
        bandSamples.push({ state: rail.dataset.state, call: rail.dataset.call, height: b.height, row: band.hasAttribute('data-rail-row') }); };
      globalThis.bandWatch?.disconnect();
      globalThis.bandWatch = new MutationObserver(sample);
      bandWatch.observe(rail, { attributes: true, attributeFilter: ['data-state', 'data-call'] });
      bandWatch.observe(band, { attributes: true, attributeFilter: ['data-rail-row'] });
    });
    await page.evaluate(() => grant());
    await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
    await page.click('aithema-session >>> .composer-mic');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'connecting', { timeout: 10_000 }).catch(() => {});
    states.push(await bandRecord(page, 'live'));
    // AIT-587: an unacknowledged pause fails here; it is never recorded as a paused state.
    await togglePause(page, true, label);
    states.push(await bandRecord(page, 'paused'));
    if (variant.width === 1366 || variant.locale === 'de') await retain(page, `s2-${label}-band-paused`, states.at(-1));
    await togglePause(page, false, label);
    states.push(await bandRecord(page, 'resumed'));
    await retain(page, `s2-${label}-band-live`, states.at(-1));
    await page.evaluate(() => c.shadowRoot.querySelector('.voice-close').click());
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    states.push(await bandRecord(page, 'ended'));
    await retain(page, `s2-${label}-band-ended`, states.at(-1));
    const samples = await page.evaluate(() => { bandWatch.disconnect(); return bandSamples; });
    records.push({ label, states, samples });
  }
  for (const { label, states, samples } of records) {
    const [idle] = states;
    assert.ok(samples.length > 0, `${label}: band transitions were sampled`);
    for (const sample of samples) {
      assert.equal(sample.row, false, `${label}: no second band row in ${sample.state}: ${JSON.stringify(samples)}`);
      assert.ok(sample.height > 0 && Math.abs(sample.height - idle.band[3]) <= .5, `${label}: band height constant in ${sample.state}: ${JSON.stringify(samples)}`);
    }
    for (const s of states) {
      const where = `${label}/${s.state}: ${JSON.stringify(s)}`;
      positive({ band: s.band, rail: s.rail, signal: s.signal, ...s.cells });
      for (const control of s.visibleControls) positive({ [control.name]: control.box });
      assert.equal(s.rowAttr, false, `band never moves the rail to a second row: ${where}`);
      assert.ok(s.band[3] <= 90.5, `band is one 90 px row: ${where}`);
      assert.deepEqual(s.band, idle.band, `band box constant across states: ${where}`);
      assert.deepEqual(s.cells, idle.cells, `control cells do not move: ${where}`);
      for (const box of Object.values(s.cells)) assert.ok(box[2] >= 44 && box[3] >= 44, `44 px control cells: ${where}`);
      for (const control of s.visibleControls) {
        assert.ok(control.box[2] >= 44 && control.box[3] >= 44, `44 px target ${control.name}: ${where}`);
        assert.ok(control.box[0] >= s.rail[0] - .5 && control.box[0] + control.box[2] <= s.rail[0] + s.rail[2] + .5, `control inside rail: ${where}`);
      }
      // The middle line yields: it ends inside its signal track, never across a control.
      if (s.status.visible) assert.ok(s.status.box[0] >= s.signal[0] - .5 && s.status.box[0] + s.status.box[2] <= s.signal[0] + s.signal[2] + .5, `status stays in its track: ${where}`);
      // AIT-239: a cut line clips and fades (8 px fade plus 8 px clear space), never an ellipsis, with no waveform under it.
      if (s.status.visible) assert.notEqual(s.status.textOverflow, 'ellipsis', `status never ends in an ellipsis: ${where}`);
      if (s.status.visible && s.status.scrollWidth > s.status.clientWidth) {
        assert.equal(s.status.textOverflow, 'clip', `cut status clips: ${where}`);
        assert.equal(s.status.clipped, true, `cut status is marked for its fade: ${where}`);
        assert.match(s.status.mask, /linear-gradient.*calc\(100% - 16px\).*calc\(100% - 8px\)/, `cut status ends in the 8 px fade plus 8 px clear space: ${where}`);
        assert.equal(s.status.wave, 'hidden', `no waveform under the cut status: ${where}`);
      } else assert.equal(s.status.mask, 'none', `a whole or empty status keeps every glyph unfaded: ${where}`);
    }
  }
});

// r3: only ordinary status may clip, fade or hide. A notice the visitor must
// read (here the used-up credit notice, a text-only band line without a message
// bubble) stays whole, as on main: it still drives the band's row decision.
const longNotice = { en: 'Your conversation time is used up for now. Your conversation is saved; you can export it or continue later with new credits.',
  de: 'Ihre Gesprächszeit ist vorerst aufgebraucht. Ihr Gespräch ist gespeichert; Sie können es exportieren oder später mit neuem Guthaben fortsetzen.' };
test('AIT-553 slice 2 r3: an important band notice is never clipped, faded or hidden on short desktops with host chrome', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of shortDesktops.slice(0, 4)) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant); await hostChrome(page);
    await creditFixture(page, variant.locale, { spent: 12_000_000 });
    await page.evaluate(async text => {
      const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
      for (const key of Object.keys(copy.voiceCreditStatus)) copy.voiceCreditStatus[key] = text;
      copy.voiceStates.usedUp = text;
      c.configure({ session: c.session, copy, host: { credits: true } });
    }, longNotice[variant.locale]);
    await page.waitForFunction(text => c.shadowRoot.querySelector('.voice-state').textContent === text, { timeout: 10_000 }, longNotice[variant.locale]);
    const record = await bandRecord(page, 'used-up notice');
    record.viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    await retain(page, `s2r3-${label}-band-notice`, record);
    records.push({ label, record });
  }
  for (const { label, record: s } of records) {
    const where = `${label}: ${JSON.stringify(s)}`;
    positive({ band: s.band, rail: s.rail, signal: s.signal, status: s.status.box });
    assert.equal(s.status.visible, true, `important notice stays visible: ${where}`);
    assert.ok(s.status.scrollWidth <= s.status.clientWidth, `important notice is never cut: ${where}`);
    assert.equal(s.status.mask, 'none', `important notice is never faded: ${where}`);
    assert.notEqual(s.status.textOverflow, 'ellipsis', `important notice never ends in an ellipsis: ${where}`);
    assert.ok(s.status.box[0] >= -.5 && s.status.box[0] + s.status.box[2] <= s.viewport[0] + .5, `important notice lies inside the viewport: ${where}`);
  }
});

test('AIT-553 slice 2 item 2: on short desktops the readiness card is whole at first paint above the pinned composer', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of shortDesktops) {
    await openIntro(page, server, variant); await hostChrome(page);
    const pinned = (await observe(page)).geometry;
    const first = await page.evaluate(() => {
      const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const card = root.querySelector('.ready'), scroller = root.querySelector('.conversation-scroll');
      const lines = [...card.querySelectorAll('h3, .ready__row, .ready__actions button')].filter(n => n.checkVisibility({ checkVisibilityCSS: true }))
        .map(n => ({ name: n.className || n.localName, text: n.textContent.trim(), box: box(n) }));
      return { scrollTop: scroller.scrollTop, scrollY, viewport: [innerWidth, innerHeight], card: box(card), scroller: box(scroller),
        composer: box(root.querySelector('.composer')), opener: box(root.querySelector('[data-host-opener]')), lines,
        text: card.innerText.replace(/\s+/g, ' ').trim() };
    });
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    if (shortDesktops.indexOf(variant) < 4) await retain(page, `s2-${label}-readiness-first-paint`, first);
    await page.evaluate(() => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight; });
    records.push({ label, first, pinned, after: (await observe(page)).geometry });
  }
  for (const { label, first, pinned, after } of records) {
    const where = `${label}: ${JSON.stringify(first)}`, [, cy, , ch] = first.card, [, sy, , sh] = first.scroller;
    positive({ card: first.card, scroller: first.scroller, composer: first.composer, opener: first.opener });
    for (const line of first.lines) positive({ [line.name]: line.box });
    positive(pinned); assert.deepEqual(after, pinned, `composer stays pinned: ${label}`);
    assert.ok(cy >= sy - .5 && cy + ch <= sy + sh + .5, `card whole inside the visible conversation area at first paint: ${where}`);
    assert.ok(cy >= 0 && cy + ch <= first.viewport[1] + .5, `card whole inside the viewport at first paint: ${where}`);
    assert.ok(cy + ch <= first.composer[1] - 8, `card clears the composer: ${where}`);
    assert.ok(first.opener[1] >= sy - .5, `the welcome stays at the top: ${where}`);
    assert.ok(first.card[2] >= 320, `readable card width: ${where}`);
    assert.match(first.text, /Before you start|Vor dem Gespräch/u, `card keeps its title: ${where}`);
    assert.match(first.text, /Change settings|Einstellungen ändern/u, `card keeps its settings action: ${where}`);
    for (const line of first.lines.filter(l => /button/.test(l.name) || /ready__change/.test(l.name))) assert.ok(line.box[3] >= 44, `44 px action: ${where}`);
  }
});

// Slice 3: beside the consumer's real header the opener playback row (speaker,
// progress line, pause) flexes its line down to a 160 px floor before the band
// takes a second row; the compact readiness then clears the pinned composer.
const hostRowDesktops = [
  { width: 1366, height: 768, locale: 'en', theme: 'light', opener: true, brand: 150 },
  { width: 1366, height: 768, locale: 'de', theme: 'dark', opener: true, brand: 150 },
  { width: 1280, height: 720, locale: 'en', theme: 'light', opener: true, brand: 167 },
  { width: 1280, height: 720, locale: 'de', theme: 'dark', opener: true, brand: 167 }
];
test('AIT-553 slice 3 M1: beside a host header the opener playback row keeps one band row', { timeout: 240_000 }, async t => {
  assert.match(html, /hostRow/u, 'the host header row fixture is installed');
  const { page, server } = await harness(t), records = [];
  for (const variant of hostRowDesktops) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant);
    await page.evaluate(async text => {
      const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
      for (const key of ['connecting', 'listening', 'speaking', 'paused']) copy.voiceStates[key] = text;
      c.configure({ session: c.session, copy });
    }, longStatus[variant.locale]);
    const track = await page.evaluate(() => {
      const band = c.shadowRoot.querySelector('.band'); return getComputedStyle(band).gridTemplateColumns.split(' ').map(Number.parseFloat)[1];
    });
    const states = [await bandRecord(page, 'idle')];
    await page.evaluate(() => grant());
    await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
    await page.click('aithema-session >>> .composer-mic');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'connecting', { timeout: 10_000 }).catch(() => {});
    states.push(await bandRecord(page, 'opener playback'));
    await retain(page, `s3-${label}-band-opener-playback`, { track, ...states.at(-1) });
    // AIT-587: the paused record exists only once the pause is acknowledged; a timeout fails the test.
    await togglePause(page, true, label);
    states.push(await bandRecord(page, 'paused'));
    await page.evaluate(() => c.shadowRoot.querySelector('.voice-close').click());
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    records.push({ label, track, states });
  }
  for (const { label, track, states } of records) {
    const [idle] = states;
    assert.ok(track > 0, `${label}: positive rail track`);
    for (const s of states) {
      const where = `${label}/${s.state} (rail track ${track}): ${JSON.stringify(s)}`;
      positive({ band: s.band, rail: s.rail, signal: s.signal, ...s.cells });
      for (const control of s.visibleControls) positive({ [control.name]: control.box });
      assert.equal(s.rowAttr, false, `no data-rail-row: ${where}`);
      assert.ok(s.band[3] <= 90.5, `band is one 90 px row: ${where}`);
      assert.deepEqual(s.cells, idle.cells, `control cells do not move: ${where}`);
      for (const box of Object.values(s.cells)) assert.ok(box[2] >= 44 && box[3] >= 44, `44 px control cells: ${where}`);
      for (const control of s.visibleControls) assert.ok(control.box[2] >= 44 && control.box[3] >= 44, `44 px target ${control.name}: ${where}`);
      if (s.status.visible) assert.ok(s.status.box[0] + s.status.box[2] <= s.signal[0] + s.signal[2] + .5, `status stays in its track: ${where}`);
    }
  }
});

// AIT-587 (Codex gate1c C12): the rail presses Pause before the provider answers and keeps it pressed when the
// answer is missing (the local media hold stays). A pause check must therefore fail on a missing acknowledgement.
test('AIT-587: a pause check fails when the provider does not acknowledge the pause', { timeout: 60_000 }, async t => {
  const { page, server } = await harness(t);
  await open(page, server, hostRowDesktops[0]);
  await page.evaluate(() => { globalThis.refusedReceipt = { pause: { acknowledged: false, paused: false } }; grant(); });
  await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
  await page.click('aithema-session >>> .composer-mic');
  await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
  await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'connecting', { timeout: 10_000 }).catch(() => {});
  await assert.rejects(togglePause(page, true, 'refused', 3_000), /refused: the pause was not acknowledged within 3 s/u);
  const after = await page.evaluate(() => ({ pressed: c.shadowRoot.querySelector('.pause').getAttribute('aria-pressed'), receipts: voiceReceipts }));
  assert.deepEqual(after.receipts, [{ command: 'pause', acknowledged: false, paused: false }], 'the provider answered without an acknowledgement');
  assert.equal(after.pressed, 'true', 'the optimistic, unacknowledged pause stays pressed, so aria-pressed alone cannot prove an acknowledgement');
});

test('AIT-553 slice 3 M2: beside a host header the compact readiness clears the pinned composer with its whole outline', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of hostRowDesktops) {
    await openIntro(page, server, variant);
    const pinned = (await observe(page)).geometry;
    const first = await page.evaluate(() => {
      const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const card = root.querySelector('.ready'), scroller = root.querySelector('.conversation-scroll'), style = getComputedStyle(card);
      const [x, y, w, h] = box(card);
      // The bottom outline (border) row, sampled across the card: nothing covers it.
      const hits = [.1, .5, .9].map(f => { const hit = root.elementFromPoint(x + w * f, y + h - .5); return Boolean(hit && card.contains(hit)); });
      return { viewport: [innerWidth, innerHeight], card: [x, y, w, h], scroller: box(scroller), composer: box(root.querySelector('.composer')),
        band: box(root.querySelector('.band')), border: parseFloat(style.borderBottomWidth), borderStyle: style.borderBottomStyle, hits };
    });
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await retain(page, `s3-${label}-readiness-first-paint`, first);
    await page.evaluate(() => { const s = c.shadowRoot.querySelector('.conversation-scroll'); s.scrollTop = s.scrollHeight; });
    records.push({ label, first, pinned, after: (await observe(page)).geometry });
  }
  for (const { label, first, pinned, after } of records) {
    const where = `${label}: ${JSON.stringify(first)}`, [, cy, , ch] = first.card, [, sy, , sh] = first.scroller;
    positive({ card: first.card, scroller: first.scroller, composer: first.composer, band: first.band });
    positive(pinned); assert.deepEqual(after, pinned, `composer stays pinned: ${label}`);
    assert.ok(first.band[3] <= 90.5, `band is one row at first paint: ${where}`);
    assert.ok(first.border > 0 && first.borderStyle !== 'none', `the card has a bottom outline: ${where}`);
    assert.ok(cy >= sy - .5 && cy + ch <= sy + sh - .5, `card and its outline inside the visible conversation area: ${where}`);
    assert.ok(cy + ch <= first.composer[1] - 8, `card clears the composer by 8 px: ${where}`);
    assert.deepEqual(first.hits, [true, true, true], `the bottom outline is not covered: ${where}`);
  }
});

// Slice 3 r2: the opt-in matters below the default 544 px floor. A 1200 px viewport with a
// 240 px host brand gives a rail track of about 450 px (inside 384-543 px): the CSS
// reservation keeps one row with the opt-in and reserves two without it.
const midTrack = [
  { width: 1200, height: 720, locale: 'en', theme: 'light', opener: true, brand: 240 },
  { width: 1200, height: 720, locale: 'de', theme: 'dark', opener: true, brand: 240 }
];
const railTrack = page => page.evaluate(() => getComputedStyle(c.shadowRoot.querySelector('.band')).gridTemplateColumns.split(' ').map(Number.parseFloat)[1]);
async function longOrdinaryStatus(page, locale) {
  await page.evaluate(async text => {
    const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
    for (const key of ['connecting', 'listening', 'speaking', 'paused']) copy.voiceStates[key] = text;
    c.configure({ session: c.session, copy });
  }, longStatus[locale]);
}
test('AIT-553 slice 3 r2: with the opt-in a 384-543 px rail track keeps an ordinary line in one band row; without it the same geometry takes two', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of midTrack) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant); await longOrdinaryStatus(page, variant.locale);
    const track = await railTrack(page), states = [await bandRecord(page, 'idle')];
    await page.evaluate(() => grant());
    await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
    await page.click('aithema-session >>> .composer-mic');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.state !== 'connecting', { timeout: 10_000 }).catch(() => {});
    states.push(await bandRecord(page, 'opener playback'));
    await retain(page, `s3r2-${label}-mid-track-opt-in`, { track, ...states.at(-1) });
    await page.evaluate(() => c.shadowRoot.querySelector('.voice-close').click());
    await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
    await open(page, server, { ...variant, query: 'optout' }); await longOrdinaryStatus(page, variant.locale);
    const optout = { track: await railTrack(page), ...await bandRecord(page, 'idle without the opt-in') };
    await retain(page, `s3r2-${label}-mid-track-opt-out`, optout);
    records.push({ label, track, states, optout });
  }
  for (const { label, track, states, optout } of records) {
    assert.ok(track >= 384 && track < 544, `${label}: the rail track lies between the flexing floor and the default floor (${track})`);
    for (const s of states) {
      const where = `${label}/${s.state} (rail track ${track}): ${JSON.stringify(s)}`;
      positive({ band: s.band, rail: s.rail, signal: s.signal, ...s.cells });
      assert.equal(s.rowAttr, false, `opt-in: no data-rail-row: ${where}`);
      assert.ok(s.band[3] <= 90.5, `opt-in: band is one 90 px row: ${where}`);
      for (const box of Object.values(s.cells)) assert.ok(box[2] >= 44 && box[3] >= 44, `44 px control cells: ${where}`);
      if (s.status.visible) assert.ok(s.status.box[0] + s.status.box[2] <= s.signal[0] + s.signal[2] + .5, `status stays in its track: ${where}`);
    }
    const where = `${label}/without the opt-in: ${JSON.stringify(optout)}`;
    positive({ band: optout.band, rail: optout.rail, signal: optout.signal, ...optout.cells });
    assert.ok(Math.abs(optout.track - track) <= .5, `same rail track without the opt-in: ${where}`);
    assert.ok(optout.band[3] >= 149.5, `without the opt-in the same geometry takes two band rows: ${where}`);
  }
});

const longConsent = { en: 'Voice needs your consent before the assistant can listen and answer aloud',
  de: 'Die Stimme braucht Ihre Zustimmung, bevor die Assistenz zuhören und antworten kann' };
test('AIT-553 slice 3 r2: with the opt-in at a 384-543 px track an overflowing consent action and an important notice take two rows, whole', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of midTrack) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    // The combined entrance hands voice consent to the composer (audio-rail.js composerOwnsConsent);
    // the choice entrance keeps the inline consent action in the band line.
    await open(page, server, variant, 'choice');
    await page.evaluate(async text => {
      const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
      copy.featureConsent.voice = text; c.configure({ session: c.session, copy });
    }, longConsent[variant.locale]);
    await page.waitForFunction(() => Boolean(c.shadowRoot.querySelector('.voice-state .consent-action:not([hidden])')), { timeout: 10_000 });
    const consent = { track: await railTrack(page), ...await bandRecord(page, 'consent action') };
    consent.action = await page.evaluate(() => { const a = c.shadowRoot.querySelector('.voice-state .consent-action'), b = a.getBoundingClientRect();
      return { box: [b.x, b.y, b.width, b.height], scrollWidth: a.scrollWidth, clientWidth: a.clientWidth, visible: a.checkVisibility({ checkVisibilityCSS: true }) }; });
    consent.viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    await retain(page, `s3r2-${label}-mid-track-consent`, consent);
    await open(page, server, variant);
    await creditFixture(page, variant.locale, { spent: 12_000_000 });
    await page.evaluate(async text => {
      const copy = structuredClone((await import(`/packages/ui/src/i18n/${c.session.locale}.js`))[c.session.locale]);
      for (const key of Object.keys(copy.voiceCreditStatus)) copy.voiceCreditStatus[key] = text;
      copy.voiceStates.usedUp = text;
      c.configure({ session: c.session, copy, host: { credits: true } });
    }, longNotice[variant.locale]);
    await page.waitForFunction(text => c.shadowRoot.querySelector('.voice-state').textContent === text, { timeout: 10_000 }, longNotice[variant.locale]);
    const notice = { track: await railTrack(page), ...await bandRecord(page, 'used-up notice'), notice: await page.evaluate(() => c.shadowRoot.querySelector('.voice-state').hasAttribute('data-notice')) };
    notice.viewport = consent.viewport;
    await retain(page, `s3r2-${label}-mid-track-notice`, notice);
    records.push({ label, consent, notice });
  }
  for (const { label, consent, notice } of records) {
    for (const s of [consent, notice]) {
      const where = `${label}/${s.state}: ${JSON.stringify(s)}`;
      assert.ok(s.track >= 384 && s.track < 544, `rail track between the floors: ${where}`);
      positive({ band: s.band, rail: s.rail, signal: s.signal, status: s.status.box, ...s.cells });
      assert.equal(s.rowAttr, true, `the whole line takes the second row: ${where}`);
      assert.ok(s.band[3] >= 149.5, `band takes two rows: ${where}`);
      assert.equal(s.status.visible, true, `line stays visible: ${where}`);
      assert.ok(s.status.scrollWidth <= s.status.clientWidth, `line is never cut: ${where}`);
      assert.equal(s.status.mask, 'none', `line is never faded: ${where}`);
      assert.ok(s.status.box[0] >= -.5 && s.status.box[0] + s.status.box[2] <= s.viewport[0] + .5, `line lies inside the viewport: ${where}`);
    }
    const where = `${label}/consent: ${JSON.stringify(consent)}`;
    assert.equal(consent.action.visible, true, `consent action visible: ${where}`);
    positive({ action: consent.action.box });
    assert.ok(consent.action.scrollWidth <= consent.action.clientWidth, `consent action is never cut: ${where}`);
    assert.ok(consent.action.box[0] + consent.action.box[2] <= consent.status.box[0] + consent.status.box[2] + .5, `consent action inside its line: ${where}`);
    assert.equal(notice.notice, true, `the used-up line is marked as an important notice: ${label}`);
  }
});

// First paint (render-blocking placeholder) against the mounted widget, with the opt-in:
// the placeholder's band equals the mounted band, and the mounted fit adds no row or shift.
const firstPaintVariants = [
  { ...hostRowDesktops[0], query: 'fp' }, { ...hostRowDesktops[3], query: 'fp' }, { ...midTrack[0], query: 'fp' }, { ...midTrack[1], query: 'fp' }
];
test('AIT-553 slice 3 r2: with the opt-in the first-paint placeholder band equals the mounted band and mount shifts nothing', { timeout: 240_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of firstPaintVariants) {
    const label = `${variant.width}x${variant.height}-${variant.locale}-${variant.theme}`;
    await open(page, server, variant);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const placeholder = await page.evaluate(() => {
      const band = document.querySelector('.aithema-first-paint'), rail = band.querySelector('.audio-rail'), b = band.getBoundingClientRect(), r = rail.getBoundingClientRect();
      return { mounted: c.hasAttribute('data-aithema-mounted'), sessionVisible: c.checkVisibility(), band: [b.x, b.y, b.width, b.height], rail: [r.x, r.y, r.width, r.height],
        row: getComputedStyle(rail).gridRowStart, reserved: getComputedStyle(band).getPropertyValue('--aithema-header-rail-row').trim() };
    });
    // Mount, then measure in the same task (before any observer runs) and again once settled.
    await page.evaluate(() => {
      globalThis.measureMount = () => {
        const root = c.shadowRoot, box = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        const band = root.querySelector('.band'), rail = band.querySelector('.audio-rail');
        return { band: box(band), rail: box(rail), row: band.hasAttribute('data-rail-row'), railRow: getComputedStyle(rail).gridRowStart,
          scroller: box(root.querySelector('.conversation-scroll')), composer: box(root.querySelector('.composer')), card: box(root.querySelector('.ready')),
          placeholderShown: document.querySelector('.aithema-first-paint').checkVisibility() };
      };
    });
    const mountFrame = await page.evaluate(() => { mount(globalThis.pendingSession); return measureMount(); });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const settled = await page.evaluate(() => measureMount());
    settled.track = await railTrack(page);
    await retain(page, `s3r2-${label}-first-paint-vs-mounted`, { placeholder, mountFrame, settled });
    records.push({ label, placeholder, mountFrame, settled });
  }
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= .5);
  for (const { label, placeholder, mountFrame, settled } of records) {
    const where = `${label}: ${JSON.stringify({ placeholder, mountFrame, settled })}`;
    assert.equal(placeholder.mounted, false, `the placeholder is measured before mount: ${where}`);
    positive({ placeholderBand: placeholder.band, placeholderRail: placeholder.rail });
    for (const s of [mountFrame, settled]) positive({ band: s.band, rail: s.rail, scroller: s.scroller, composer: s.composer, card: s.card });
    assert.equal(settled.placeholderShown, false, `the placeholder hides once mounted: ${where}`);
    assert.equal(placeholder.reserved, '1', `the opt-in reservation keeps one row before mount: ${where}`);
    assert.equal(placeholder.row, '1', `placeholder rail in the first row: ${where}`);
    assert.ok(placeholder.band[3] <= 90.5, `placeholder band is one 90 px row: ${where}`);
    assert.ok(Math.abs(settled.band[3] - placeholder.band[3]) <= .5, `mounted band height equals the placeholder: ${where}`);
    assert.ok(Math.abs(settled.band[1] - placeholder.band[1]) <= .5, `mounted band top equals the placeholder: ${where}`);
    assert.equal(settled.row, false, `the mounted fit adds no second row: ${where}`);
    assert.equal(settled.railRow, placeholder.row, `mounted rail row equals the placeholder: ${where}`);
    assert.ok(near(settled.band, mountFrame.band), `band does not move after mount: ${where}`);
    assert.ok(near(settled.scroller, mountFrame.scroller), `conversation does not move after mount: ${where}`);
    assert.ok(near(settled.composer, mountFrame.composer), `composer does not move after mount: ${where}`);
    assert.ok(near(settled.card, mountFrame.card), `readiness does not move after mount: ${where}`);
  }
});

test('AIT-553 item 6: phone used-up confirmation stacks a one-line 44 px action below its text without moving the dock', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const locale of ['en','de']) for (const width of [390, 375, 320]) {
    await open(page, server, { width, height: 844, locale, theme: locale === 'de' ? 'dark' : 'light' });
    await creditFixture(page, locale, { address: 'visitor@example.test', delivery: true, spent: 0 });
    const before = (await observe(page)).geometry;
    await creditFixture(page, locale, { address: 'visitor@example.test', delivery: true, spent: 18_000_000 });
    await page.waitForFunction(() => c.shadowRoot.querySelector('.composer-shell').hasAttribute('data-used-up'));
    await observe(page);
    const record = await page.evaluate(() => {
      const root = c.shadowRoot, box = n => { const b = n.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; };
      const out = root.querySelector('.composer-out'), text = out.querySelector('.composer-out__steps [data-next="confirm"]'), button = out.querySelector('.composer-out__upgrade'), label = button.querySelector('[data-next="confirm"]');
      const range = document.createRange(); range.selectNodeContents(label);
      const lines = [...range.getClientRects()].filter(b => b.width > 0 && b.height > 0);
      return { next: out.dataset.next, boxes: { body: box(out.querySelector('.composer-out__body > [data-active="true"]')), text: box(text), button: box(button), label: box(label), export: box(out.querySelector('.composer-out__export')) },
        lines: [...new Set(lines.map(b => b.y))].length, label: label.textContent, textVisible: text.checkVisibility({ checkVisibilityCSS: true }), visible: button.checkVisibility({ checkVisibilityCSS: true }) };
    });
    await retain(page, `${width}-${locale}-used-up-confirm`, record);
    records.push({ before, after: (await observe(page)).geometry, record });
  }
  for (const { before, after, record } of records) {
    positive(before); positive(after); positive(record.boxes);
    assert.deepEqual(after, before, 'used-up confirmation leaves composer, mic and Send pinned');
    assert.equal(record.next, 'confirm'); assert.equal(record.visible, true); assert.equal(record.textVisible, true);
    assert.ok(record.boxes.button[1] >= record.boxes.text[1] + record.boxes.text[3], `button below text: ${JSON.stringify(record)}`);
    assert.equal(record.lines, 1, 'full confirmation label stays on one line');
    assert.ok(record.boxes.button[3] >= 44);
    assert.ok(record.boxes.text[1] >= record.boxes.body[1] + record.boxes.body[3], `offer text clears saved-conversation copy: ${JSON.stringify(record)}`);
    assert.ok(record.boxes.export[1] >= record.boxes.button[1] + record.boxes.button[3] + 12, 'export retains its separate 12 px phone row');
    assert.ok(record.boxes.button[0] + record.boxes.button[2] + 8 <= record.boxes.export[0], `independent phone actions have an 8 px gap: ${JSON.stringify(record)}`);
  }
});

// Gate1 M1: the combined entrance hides the idle band Start, so a keyboard End
// must hand focus to the composer microphone instead of dropping it to <body>.
async function keyboardEnd(page, startSelector) {
  await page.evaluate(() => grant());
  await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
  if (startSelector === '.composer-mic') await page.click(`aithema-session >>> ${startSelector}`);
  else {
    // Choice: START's explicit voice start (ready card voice mode + Start, or the band Start).
    await page.waitForFunction(() => !c.shadowRoot.querySelector('.voice-start').disabled);
    await page.evaluate(() => {
      const root = c.shadowRoot;
      if (root.querySelector('.workspace').dataset.stage === 'ready' && root.querySelector('.ready__start')) {
        root.querySelector('.ready__mode[data-mode="voice"]')?.click(); root.querySelector('.ready__start').click();
      } else root.querySelector('.voice-start').click();
    });
  }
  await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'active', { timeout: 10_000 })
    .catch(async error => { throw new Error(`${startSelector} did not start a call: ${await page.evaluate(() => JSON.stringify({ stage: c.shadowRoot.querySelector('.workspace').dataset.stage, rail: c.shadowRoot.querySelector('.audio-rail').dataset.state, start: c.shadowRoot.querySelector('.voice-start').disabled }))}`, { cause: error }); });
  await page.waitForFunction(() => !c.shadowRoot.querySelector('.voice-close').disabled);
  await page.evaluate(() => c.shadowRoot.querySelector('.voice-close').focus());
  const before = await page.evaluate(() => c.shadowRoot.activeElement?.className ?? null);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail').dataset.call === 'none');
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); await new Promise(resolve => setTimeout(resolve, 250)); });
  return page.evaluate(before => {
    const active = c.shadowRoot.activeElement, b = active?.getBoundingClientRect();
    return { before, active: active?.className ?? null, documentActive: document.activeElement?.localName ?? null,
      disabled: Boolean(active?.disabled), box: b ? [b.x, b.y, b.width, b.height] : null,
      visible: Boolean(active?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) };
  }, before);
}

test('AIT-553 M1: keyboard End keeps focus on the composer mic in combined and on Start in choice', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of variants) {
    const label = `${variant.width}-${variant.locale}`;
    await open(page, server, variant);
    records.push({ label, entrance: 'combined', expected: 'composer-mic', ...await keyboardEnd(page, '.composer-mic') });
    await open(page, server, variant, 'choice');
    records.push({ label, entrance: 'choice', expected: 'voice-start', ...await keyboardEnd(page, '.voice-start') });
  }
  for (const record of records) {
    const label = `${record.label} ${record.entrance}: ${JSON.stringify(record)}`;
    assert.match(record.before ?? '', /\bvoice-close\b/, `band End holds keyboard focus before Enter: ${label}`);
    assert.equal(record.documentActive, 'aithema-session', `focus stays inside the element, not <body>: ${label}`);
    assert.ok(record.active?.split(/\s+/).includes(record.expected), `End returns focus to ${record.expected}: ${label}`);
    assert.equal(record.disabled, false, `focused control is enabled: ${label}`);
    assert.equal(record.visible, true, `focused control is visible: ${label}`);
    assert.ok(record.box[2] > 0 && record.box[3] > 0, `focused control has a positive box: ${label}`);
  }
});

async function micUnavailableAfterFocusMove(page) {
  await page.evaluate(() => grant());
  await page.waitForFunction(() => c.session.featureMatrix.best.voice.available);
  // Hold the start open, then fail it with "no microphone API" once focus has moved on.
  await page.evaluate(() => {
    globalThis.failStart = null;
    fixtureClient.start = () => new Promise((resolve, reject) => {
      globalThis.failStart = () => reject(Object.assign(new Error('fixture: no media API'), { name: 'NoMediaAPIError' }));
    });
  });
  await page.click('aithema-session >>> .composer-mic');
  await page.waitForFunction(() => typeof globalThis.failStart === 'function');
  const moved = await page.evaluate(() => {
    const field = c.shadowRoot.querySelector('textarea'); field.focus();
    return c.shadowRoot.activeElement === field ? 'textarea' : (c.shadowRoot.activeElement?.className ?? null);
  });
  await page.evaluate(() => failStart());
  await page.waitForFunction(() => c.shadowRoot.querySelector('.audio-rail[data-no-mic-api]'));
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); await new Promise(resolve => setTimeout(resolve, 250)); });
  return page.evaluate(moved => {
    const active = c.shadowRoot.activeElement, b = active?.getBoundingClientRect();
    return { moved, active: active?.localName === 'textarea' ? 'textarea' : (active?.className ?? null),
      documentActive: document.activeElement?.localName ?? null, box: b ? [b.x, b.y, b.width, b.height] : null };
  }, moved);
}

test('AIT-553 gate2c: an asynchronous mic-unavailable failure leaves focus on the control the user moved to', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  for (const variant of variants) {
    await open(page, server, variant);
    records.push({ label: `${variant.width}-${variant.locale}`, ...await micUnavailableAfterFocusMove(page) });
  }
  for (const record of records) {
    const label = `${record.label} combined: ${JSON.stringify(record)}`;
    assert.equal(record.moved, 'textarea', `focus moved to the message field during startup: ${label}`);
    assert.equal(record.documentActive, 'aithema-session', `focus stays inside the element: ${label}`);
    assert.equal(record.active, 'textarea', `the failure does not take focus from the message field: ${label}`);
    assert.ok(record.box[2] > 0 && record.box[3] > 0, `focused control has a positive box: ${label}`);
  }
});

// AIT-587 (RC25 look 15): the ready card's check stays beside its value, also when the value wraps.
test('AIT-587: a ready-card check stays beside the first line of a wrapped value', { timeout: 120_000 }, async t => {
  const { page, server } = await harness(t), records = [];
  // AIT-587 r2 (Codex gate1c A3): short desktops (600 px wide or more, at most 860 px high) show the combined
  // readiness as one compact row with its own flex layout; those variants run inside that breakpoint.
  const compact = [{ width: 1366, height: 768, locale: 'en', theme: 'light', compact: true }, { width: 1280, height: 720, locale: 'de', theme: 'dark', compact: true }];
  const cases = [...variants.flatMap(variant => ['choice', 'combined'].map(entrance => [variant, entrance])), ...compact.map(variant => [variant, 'combined'])];
  for (const [variant, entrance] of cases) {
    const label = `${variant.width}x${variant.height ?? 1000}-${variant.locale}-${variant.theme}-${entrance}`;
    await open(page, server, variant, entrance);
    await page.evaluate(() => grant());
    await page.waitForFunction(() => [...c.shadowRoot.querySelectorAll('.ready__row')]
      .some(row => row.querySelector('.ready__check').checkVisibility({ checkVisibilityCSS: true })), { timeout: 10_000 })
      .catch(async error => { throw new Error(`${label}: no ready-card check shows: ${await page.evaluate(() => c.shadowRoot.querySelector('.ready')?.outerHTML.slice(0, 600))}`, { cause: error }); });
    const layout = await page.evaluate(() => getComputedStyle(c.shadowRoot.querySelector('.ready')).display);
    const rows = await page.evaluate(repeat => [...c.shadowRoot.querySelectorAll('.ready__row')]
      .filter(row => row.querySelector('.ready__check').checkVisibility({ checkVisibilityCSS: true })).map(row => {
        const value = row.querySelector('dd > span:last-child'), check = row.querySelector('.ready__check'), original = value.textContent;
        const measure = () => {
          const range = document.createRange(); range.selectNodeContents(value);
          const lines = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0), b = check.getBoundingClientRect();
          return { check: [b.x, b.y, b.width, b.height], first: lines[0] ? [lines[0].x, lines[0].y, lines[0].width, lines[0].height] : null,
            lines: new Set(lines.map(r => Math.round(r.y))).size, row: row.getBoundingClientRect().height };
        };
        const single = measure();
        value.textContent = Array(repeat).fill(original).join(' ');
        const wrapped = measure();
        value.textContent = original;
        return { row: row.dataset.ready, single, wrapped, restored: measure() };
      }), variant.compact ? 40 : 10);
    records.push({ label, rows, layout, compact: Boolean(variant.compact) });
    await retain(page, `ait587-${label}-ready-check`, { layout, rows });
  }
  for (const { label, rows, layout, compact } of records) {
    if (compact) assert.equal(layout, 'flex', `${label}: the compact readiness row is active`);
    assert.ok(rows.length > 0, `${label}: at least one ready-card check is measured`);
    for (const { row, single, wrapped, restored } of rows) {
      const where = `${label}/${row}: ${JSON.stringify({ single, wrapped })}`;
      for (const [name, box] of Object.entries({ singleCheck: single.check, singleText: single.first, wrappedCheck: wrapped.check, wrappedText: wrapped.first }))
        assert.ok(box && box[2] > 0 && box[3] > 0, `${name}: positive width and height: ${where}`);
      assert.ok(wrapped.lines > 1, `the forced value wraps: ${where}`);
      const gap = state => state.first[0] - (state.check[0] + state.check[2]);
      assert.ok(gap(single) >= -.5, `the check precedes its value: ${where}`);
      assert.ok(Math.abs(gap(wrapped) - gap(single)) <= .5, `a wrapped value keeps the check beside its first line: ${where}`);
      const middle = box => box[1] + box[3] / 2;
      assert.ok(Math.abs(middle(wrapped.check) - middle(wrapped.first)) <= wrapped.first[3] / 2, `the check stays on the first line: ${where}`);
      assert.deepEqual(restored.check, single.check, `restoring the value moves the check 0 px: ${where}`);
      assert.equal(restored.row, single.row, `restoring the value restores the row height: ${where}`);
    }
  }
});
