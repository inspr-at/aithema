// AIT-395: one browser/page, in-place receipts; no provider, mail or paid calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceCommit, shadow, until } from './start2-display-helpers.js';

export async function sessionCreditsCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-session-credits-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile(), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [], shots = [], errors = [];
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const head = event?.pull_request?.head?.sha ?? evidenceCommit;
  if (evidence) await mkdir(evidence, { recursive: true });
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => {
    window.ait395 = { seed: structuredClone(c.session), receipt: null, samples: [], sample: false };
    const nativeFetch = window.fetch;
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname, f = window.ait395;
      if (path.endsWith('/credits')) {
        const receipt = structuredClone(f.receipt);
        // Exercise the loading interval across sibling changes.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Response.json(receipt);
      }
      if (path.endsWith('/identity')) return Response.json({ identity: c.session.identity, delivery: true, privacyDocumentConfigured: true });
      if (path.endsWith('/visitor/email')) return Response.json({ visitor: { address: c.session.identity.address }, notice: { version: 'ait395', deliveryEnabled: true }, privacyDocumentConfigured: true });
      if (path.endsWith('/features')) return Response.json({});
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      return nativeFetch(url, options);
    };
    const sample = () => {
      if (f.sample) {
        const root = c.shadowRoot;
        f.samples.push({ id: c.session.id, value: root.querySelector('.host-credits__value').textContent,
          current: root.querySelector('.host-credits__current').textContent, next: root.querySelector('.host-credits__next').textContent,
          rects: Object.fromEntries(['.host-credits__button', '.host-credits__measure'].map(s => { const b = root.querySelector(s).getBoundingClientRect(); return [s, [b.x, b.y, b.width, b.height]]; })),
          offer: !root.querySelector('.credits-email').hidden });
      }
      requestAnimationFrame(sample);
    };
    const f = window.ait395; requestAnimationFrame(sample);
  });
  const settle = () => shadow(page, async c => {
    await document.fonts.ready;
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const scene = async (state, locale, theme, { switchTo, equal = true, canCollect = true, upgrade = true } = {}) => {
    await shadow(page, async (c, { state, locale, theme, switchTo, equal, canCollect, upgrade }) => {
      const f = window.ait395, current = state === 'k2' ? 'emailConfirmed' : ['k4', 'k5'].includes(state) ? 'emailGiven' : 'anonymous';
      const limitMicro = current === 'emailConfirmed' ? 10_000_000 : 2_500_000;
      f.receipt = { scope: 'session', exhausted: ['k5', 'k6'].includes(state), dailyCapReached: state === 'k6',
        balance: { owner: { limitMicro, availableMicro: state === 'k5' ? 0 : limitMicro, committedMicro: state === 'k5' ? limitMicro : 0, reservedMicro: 0 } },
        tiers: { current, next: !upgrade || current === 'emailConfirmed' ? null : current === 'anonymous' ? 'emailGiven' : 'emailConfirmed',
          canConfirm: upgrade, delta: 7_500_000, allowancesMicro: { anonymous: 2_500_000, emailGiven: equal ? 2_500_000 : 5_000_000, emailConfirmed: upgrade ? 10_000_000 : 2_500_000 } } };
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = structuredClone(f.seed); session.id = switchTo ?? 'ait395-b'; session.locale = locale; session.demo = true;
      session.transcript = []; session.identity = { status: current === 'emailConfirmed' ? 'verified' : current === 'emailGiven' ? 'verification-pending' : 'guest',
        address: current === 'anonymous' ? null : 'reader@example.test', verificationRequired: false, assessmentUnlocked: true, conceptsUnlocked: true, roles: ['visitor'] };
      session.credits = { status: 'active', endReason: null };
      session.settings.origin = 'chosen'; session.processingPreset = 'best';
      session.featureMatrix.best = { text: { available: false }, analysis: { available: false }, voice: { available: false } };
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      c.configure({ copy, session, host: { credits: true, verification: canCollect } });
      f.expected = ['k5', 'k6'].includes(state) ? '0' : new Intl.NumberFormat(locale).format(limitMicro / 10_000);
    }, { state, locale, theme, switchTo, equal, canCollect, upgrade });
    await until(page, () => {
      const root = document.querySelector('aithema-session').shadowRoot;
      return root.querySelector('.host-credits__value').textContent === window.ait395.expected &&
        (root.querySelector('.credits-email').hidden || root.querySelector('.credits-email').textContent.length > 0);
    });
    await shadow(page, c => { c.shadowRoot.querySelector('.host-credits__button').click(); });
    await settle();
  };
  const measure = () => shadow(page, c => {
    const r = c.shadowRoot, selectors = ['.host-credits__button', '.host-credits__measure', '.host-credits__current', '.host-credits__next', '.credits-email'];
    const rects = Object.fromEntries(selectors.map(s => { const b = r.querySelector(s).getBoundingClientRect(); return [s, [b.x, b.y, b.width, b.height]]; }));
    const visible = s => !r.querySelector(s).hidden && getComputedStyle(r.querySelector(s)).visibility !== 'hidden';
    return { rects, value: r.querySelector('.host-credits__value').textContent, scope: r.querySelector('.host-credits__scope').textContent,
      current: visible('.host-credits__current') ? r.querySelector('.host-credits__current').textContent.trim() : '',
      next: visible('.host-credits__next') ? r.querySelector('.host-credits__next').textContent : '',
      offer: visible('.credits-email'), action: r.querySelector('.credits-email').textContent,
      dailyCap: visible('.host-credits__daily-cap') ? r.querySelector('.host-credits__daily-cap').textContent : '',
      demo: r.querySelector('.host-credits__demo').textContent,
      popupVisible: getComputedStyle(r.querySelector('.credits-popup')).visibility,
      nextVisibility: getComputedStyle(r.querySelector('.host-credits__next')).visibility };
  });
  const shot = async (width, theme, locale, state) => {
    if (!evidence || !['390/light/de/k1', '1440/light/en/k1', '1440/light/en/k3-b'].includes(`${width}/${theme}/${locale}/${state}`)) return;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); scrollTo(0, 0); });
    await page.mouse.move(-1, -1); await settle();
    const name = `ait395-${width}-${theme}-${locale}-${state}.png`;
    await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false }); shots.push(name);
  };
  for (const width of [390, 1440]) for (const locale of ['de', 'en']) {
    await page.setViewport({ width, height: 1000 });
    let baseline;
    for (const state of ['k1', 'k4', 'k5', 'k2', 'k6']) {
      await scene(state, locale, 'light');
      const value = await measure(), label = `${width}/light/${locale}/${state}`;
      assert.equal(value.popupVisible, 'visible', label);
      assert.doesNotMatch(value.scope, /all your conversations|alle Ihre Gespräche/u, label);
      if (state === 'k1') { assert.equal(value.value, '250'); assert.equal(value.offer, true); assert.equal(value.next, locale === 'de' ? 'Mit bestätigter E-Mail-Adresse: 1.000\u00a0Credits' : 'With a confirmed email address: 1,000\u00a0credits'); }
      if (state === 'k2') { assert.equal(value.value, locale === 'de' ? '1.000' : '1,000'); assert.equal(value.offer, false); assert.match(value.current, locale === 'de' ? /Mit bestätigter E-Mail-Adresse: 1\.000\u00a0Credits/u : /With a confirmed email address: 1,000\u00a0credits/u); }
      if (state === 'k4') { assert.equal(value.offer, true); assert.equal(value.action, locale === 'de' ? 'E-Mail-Adresse bestätigen' : 'Confirm your email address'); assert.equal(value.next, locale === 'de' ? 'Nach der Bestätigung: 1.000\u00a0Credits' : 'After confirmation: 1,000\u00a0credits'); }
      if (state === 'k5') { assert.equal(value.value, '0'); assert.equal(value.next, locale === 'de' ? 'Nach der Bestätigung: 1.000\u00a0Credits' : 'After confirmation: 1,000\u00a0credits'); assert.equal(value.offer, true); assert.equal(value.demo, locale === 'de' ? 'Nur Demo: Hier gibt es kein Aufladen.' : 'Demo only: no top-ups here.'); }
      if (state === 'k6') { assert.equal(value.offer, false); assert.equal(value.next, ''); assert.equal(value.dailyCap, locale === 'de' ? 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.' : "This email address has reached today's limit."); }
      baseline ??= value.rects;
      assert.deepEqual(value.rects, baseline, `${label}: 0 px across K1–K6`);
      checks.push({ width, locale, theme: 'light', state, ...value, movementPx: 0 });
      if (state !== 'k5' || width === 390 && locale === 'de') await shot(width, 'light', locale, state);
    }
    // A hovered balance receipt changes in place without rebuilding the element.
    await scene('k1', locale, 'light');
    const before = await measure(), b = before.rects['.host-credits__button'];
    await page.mouse.move(b[0] + b[2] / 2, b[1] + b[3] / 2);
    await shadow(page, c => {
      window.ait395.receipt.balance.owner.availableMicro = 1_250_000;
      c.receive({ seq: c.session.seq + 1, type: 'credits.state', data: { status: 'active', endReason: null } });
    });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent === '125');
    assert.deepEqual((await measure()).rects, before.rects, 'hovered balance update moves 0px');
    checks.push({ width, locale, state: 'hover-update', movementPx: 0 });
    if (locale === 'de') {
      // The hover case deliberately left B at 125. Restore B and wait for its
      // K1 receipt before sampling the separate sibling-switch matrix.
      await scene('k1', locale, 'light', { switchTo: 'ait395-b' });
      await shadow(page, () => { window.ait395.sample = true; });
      // Force a sampler frame before the next protocol command, rather than
      // relying on whether Chrome happens to paint between sibling scenes.
      await until(page, () => window.ait395.samples.length > 0);
      for (let cycle = 0; cycle < 3; cycle++) for (const [id, state] of [['ait395-a', 'k2'], ['ait395-b', 'k1']]) {
        await scene(state, locale, 'light', { switchTo: id });
        assert.deepEqual((await measure()).rects, baseline, 'sibling switch moves 0px');
        if (width === 1440 && cycle === 0) await shot(width, 'light', locale, state === 'k2' ? 'k3-a' : 'k3-b');
      }
      const samples = await shadow(page, () => { window.ait395.sample = false; return window.ait395.samples.splice(0); });
      assert.ok(samples.length >= 12, 'sample every animation frame through six switches');
      for (const sample of samples) {
        for (const [selector, rect] of Object.entries(sample.rects)) assert.deepEqual(rect, baseline[selector], 'sibling loading frames move 0px');
        assert.ok(['…', sample.id === 'ait395-a' ? '1.000' : '250'].includes(sample.value), JSON.stringify(sample));
        if (sample.id === 'ait395-b') {
          assert.doesNotMatch(sample.current, /bestätigter|1\.000/u, 'B never inherits A current tier');
          assert.ok(['', 'Mit bestätigter E-Mail-Adresse: 1.000\u00a0Credits'].includes(sample.next), 'B only offers its own confirmed tier');
        }
        else assert.equal(sample.offer, false, 'confirmed A never shows B offer');
      }
      checks.push({ width, locale, state: 'k3', samples, movementPx: 0 });
    }
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await scene('k2', 'en', 'light', { switchTo: 'ait395-a' });
  const siblingBaseline = (await measure()).rects;
  await scene('k1', 'en', 'light', { switchTo: 'ait395-b' });
  const sibling = await measure();
  assert.equal(sibling.next, 'With a confirmed email address: 1,000\u00a0credits');
  assert.deepEqual(sibling.rects, siblingBaseline, 'EN sibling K3-b moves 0px');
  checks.push({ width: 1440, locale: 'en', theme: 'light', state: 'k3-b', ...sibling, movementPx: 0 });
  await shot(1440, 'light', 'en', 'k3-b');
  await scene('k5', 'de', 'dark'); await shot(1440, 'dark', 'de', 'k5');
  await scene('k5', 'de', 'light', { upgrade: false });
  let value = await measure(); assert.equal(value.offer, false); assert.equal(value.next, 'Weitere Credits gibt es hier derzeit nicht.');
  checks.push({ state: 'k5-no-upgrade', ...value });
  await scene('k1', 'de', 'light');
  const filled = await measure();
  await scene('k1', 'de', 'light', { canCollect: false });
  const unavailable = await measure();
  assert.equal(unavailable.offer, false); assert.equal(unavailable.next, '');
  assert.deepEqual(unavailable.rects, filled.rects, 'empty next slot keeps the same box as K1');
  checks.push({ width: 1440, locale: 'de', theme: 'light', state: 'k1-no-offer', ...unavailable, movementPx: 0 });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__next').children.length), 0, 'next slot has no check mark');
  await scene('k1', 'de', 'light', { equal: false }); value = await measure();
  assert.equal(value.action, 'E-Mail-Adresse angeben'); assert.equal(value.next, 'Mit E-Mail-Adresse: 500\u00a0Credits');
  // AIT-445: reuse this page for the RC17 U3 copy and geometry evidence.
  await page.setViewport({ width: 390, height: 1000 });
  await scene('k1', 'de', 'light');
  await shadow(page, async c => {
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const session = structuredClone(c.session), f = window.ait395;
    f.receipt.dailyCapReached = true;
    f.receipt.balance.owner = { limitMicro: 10_000_000, availableMicro: 8_000_000, committedMicro: 2_000_000, reservedMicro: 0 };
    session.demo = false; session.conceptVisualKind = 'html'; session.visualsBound = true;
    session.conceptCost = { maxMicro: 400_000 };
    session.featureMatrix.best.html = { available: false, reason: 'budget denied' };
    session.transcript = [{ id: 'ait445-visitor', role: 'user', content: 'Ich möchte meine Anforderungen besprechen.' }];
    c.configure({ copy, session, host: { credits: true, verification: true } });
  });
  await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__amount').textContent === '800');
  await settle();
  const drafts = await shadow(page, c => {
    const r = c.shadowRoot, status = r.querySelector('.concept-activity-text');
    const rects = () => Object.fromEntries(['.concept-bar', '.concept-rail', '.concept-activity-text', '.composer-shell', '.display-foot']
      .map(selector => { const b = r.querySelector(selector).getBoundingClientRect(); return [selector, [b.x, b.y, b.width, b.height]]; }));
    const text = status.textContent, current = rects();
    status.textContent = 'Für einen weiteren Entwurf sind gerade nicht genug Credits verfügbar.';
    const legacy = rects(); status.textContent = text;
    const b = status.getBoundingClientRect();
    return { text, current, legacy, amount: r.querySelector('.host-credits__amount').textContent,
      visible: b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && getComputedStyle(status).visibility === 'visible',
      requestHidden: r.querySelector('.concept-request').hidden, font: getComputedStyle(status).fontFamily };
  });
  assert.equal(drafts.text, 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.');
  assert.equal(drafts.amount, '800'); assert.equal(drafts.visible, true); assert.equal(drafts.requestHidden, true);
  assert.deepEqual(drafts.current, drafts.legacy, 'AIT-445: replacing the low-balance sentence moves the drafts rail, composer and footer 0 px');
  await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
  await page.mouse.move(-1, -1); await settle();
  if (evidence) {
    const name = 'ait445-390-light-de-U3.png';
    await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false });
    await writeFile(join(evidence, 'ait445-checks.json'), JSON.stringify({ head, workflowSHA: evidenceCommit,
      runId: process.env.GITHUB_RUN_ID ?? null, spec: 'Tick spec v1 · AIT-445', capture: 'viewport',
      reducedMotion: true, blurredControls: true, pointerOutside: true, movementPx: 0, drafts, shots: [name] }, null, 2));
  }
  assert.deepEqual(errors, []);
  if (evidence) {
    assert.equal(shots.length, 3, 'Tick fix1 reshoot matrix');
    await writeFile(join(evidence, 'ait395-checks.json'), JSON.stringify({ head, workflowSHA: evidenceCommit, runId: process.env.GITHUB_RUN_ID ?? null, checks, shots, errors }, null, 2));
  }
}
