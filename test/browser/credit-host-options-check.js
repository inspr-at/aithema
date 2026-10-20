// AIT-411: one page, state iterations and batched geometry, no provider or mail.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { evidenceCommit, shadow, until } from './start2-display-helpers.js';

export async function creditHostOptionsCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-credit-options-'));
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
    window.ait411 = { seed: structuredClone(c.session), receipt: {}, canDelete: true, lineRequests: 0, deletes: 0 };
    const nativeFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
      const path = new URL(url, location.href).pathname, f = window.ait411;
      if (path.endsWith('/credits')) return Response.json(f.receipt);
      if (path.endsWith('/identity')) return Response.json({ identity: c.session.identity, visitorEmail: { canSave: true, canDelete: f.canDelete }, delivery: true, privacyDocumentConfigured: true });
      if (path.endsWith('/visitor/email')) {
        if (options.method === 'DELETE') f.deletes++;
        return Response.json({ visitor: { address: c.session.identity.address }, notice: { version: 'ait411', deliveryEnabled: true }, privacyDocumentConfigured: true });
      }
      if (path.endsWith('/email-ask')) { f.lineRequests++; return Response.json({ accepted: false, emailAsk: {} }); }
      if (path.endsWith('/features')) return Response.json({});
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      return nativeFetch(url, options);
    };
  });
  const states = ['B1', 'U1', 'U2', 'U3', 'offer', 'confirmed', 'reconciling', 'reconciled', 'low-off', 'low-on', 'S1', 'S2', 'S3', 'delete-false', 'delete-true'];
  const scene = async (state, locale, theme) => {
    await shadow(page, async (c, { state, locale, theme }) => {
      const f = window.ait411, { [locale]: source } = await import(`/packages/ui/src/i18n/${locale}.js`), copy = structuredClone(source);
      const confirmed = ['U2', 'S2', 'S3', 'confirmed', 'delete-false', 'delete-true'].includes(state);
      const ended = ['U1', 'U2', 'U3', 'S1', 'S2', 'S3'].includes(state);
      const current = confirmed ? 'emailConfirmed' : 'anonymous', low = state.startsWith('low-');
      const limitMicro = confirmed ? 10000000 : 2500000, availableMicro = ended ? 0 : low ? 10000 : limitMicro;
      f.canDelete = state !== 'delete-false'; f.lowCredits = !['low-off', 'S1'].includes(state); f.lineRequests = 0; f.deletes = 0;
      f.receipt = { scope: 'session', dailyCapReached: state === 'U3', dailyCapResetAt: Date.now() + 3600000,
        exhausted: ended, reconciling: state === 'reconciling', lowAtMicro: 250000, nowMs: Date.now(),
        emailAsk: low ? { lowLine: { at: 'reply', kind: 'confirm', deltaMicro: 7500000, availableMicro } } : {},
        balance: { owner: { limitMicro, availableMicro, committedMicro: limitMicro - availableMicro, reservedMicro: 0 } },
        tiers: { current, next: confirmed ? null : 'emailConfirmed', canConfirm: true, delta: 7500000,
          allowancesMicro: { anonymous: 2500000, emailGiven: 2500000, emailConfirmed: 10000000 } } };
      const session = structuredClone(f.seed); session.id = 'ait411'; session.locale = locale; session.demo = false;
      const { inputRevision } = await import('/packages/core/src/session.js');
      session.transcript = [{ id: 'visitor', role: 'user', content: locale === 'de' ? 'Anforderungen besprechen.' : 'Discuss requirements.' }];
      const question = locale === 'de' ? 'Welche Anforderungen stehen im Vordergrund?' : 'Which requirements matter most?';
      session.transcript.push({ id: 'reply', role: 'assistant', content: question, inputRevision: inputRevision(session),
        question_short: question, options: [{ text: locale === 'de' ? 'Ziele' : 'Goals', likely: true }, { text: locale === 'de' ? 'Ressourcen' : 'Resources' }] });
      session.identity = { status: confirmed ? 'verified' : 'guest', address: confirmed ? 'reader@example.test' : null,
        verificationRequired: false, assessmentUnlocked: true, conceptsUnlocked: true, roles: ['visitor'] };
      session.credits = { status: state.startsWith('S') ? 'ended' : 'active', endReason: state.startsWith('S') ? 'session' : null };
      session.settings.origin = 'chosen'; session.processingPreset = 'best';
      session.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: false } };
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      copy.hostSurface.credits.afterConfirm = locale === 'de' ? 'Nach der Bestätigung: {tier}\u00a0Credits' : 'After confirmation: {tier} credits';
      c.configure({ copy, session, host: { verification: true, credits: { scope: 'session', reconcilingVisible: true, dailyCapReset: true },
        usedUp: { newConversation: { enabled: state !== 'S3' }, dailyCapActions: 'none' }, emailAsk: { lowCredits: f.lowCredits } } });
      let legal = c.querySelector('[slot="legal"][data-aithema-privacy]');
      if (!legal) { legal = document.createElement('a'); legal.slot = 'legal'; legal.setAttribute('data-aithema-privacy', ''); legal.href = '/privacy'; legal.textContent = 'Privacy'; c.append(legal); }
      await document.fonts.ready;
    }, { state, locale, theme });
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent !== '…');
    if (state.startsWith('delete-')) await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    // Settle once after all mutations, then read every box in the same frame.
    return shadow(page, async c => {
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = c.shadowRoot, rect = selector => { const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const footerLabel = r.querySelector('.host-credits__reconciling').getBoundingClientRect(), footer = r.querySelector('.display-foot').getBoundingClientRect();
      const footerNeighbors = ['.footer-left', '.host-legal', '.engine-info'].map(selector => ({ selector, box: r.querySelector(selector).getBoundingClientRect() }));
      const footerTextFits = footerLabel.left >= footer.left && footerLabel.right <= footer.right && footerNeighbors.every(({ box }) =>
        box.width === 0 || box.height === 0 || footerLabel.right <= box.left || footerLabel.left >= box.right || footerLabel.bottom <= box.top || footerLabel.top >= box.bottom);
      const visible = selector => { const n = r.querySelector(selector); return !!n && !n.hidden && !n.inert && getComputedStyle(n).visibility === 'visible'; };
      const body = r.querySelector('.composer-out__body');
      const reservation = [...body.children].map(n => ({ key: n.dataset.creditVariant ?? n.dataset.creditOptionVariant,
        option: n.hasAttribute('data-credit-option-variant'), text: n.textContent,
        cell: [getComputedStyle(n).gridRowStart, getComputedStyle(n).gridColumnStart].join('/'),
        hidden: getComputedStyle(n).visibility === 'hidden', ariaHidden: n.getAttribute('aria-hidden'),
        height: n.getBoundingClientRect().height }));
      return { boxes: Object.fromEntries(['.composer-shell', '.question-card', '.composer-out', '.display-foot'].map(s => [s, rect(s)])),
        reservation, bodyHeight: body.getBoundingClientRect().height,
        footerTextFits, footerTextRects: { label: [footerLabel.x, footerLabel.y, footerLabel.width, footerLabel.height], neighbors: footerNeighbors.map(({ selector, box }) => ({ selector, rect: [box.x, box.y, box.width, box.height] })) },
        lowCredits: window.ait411.lowCredits, overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth), emailBox: rect('.host-verify'), title: r.querySelector('.composer-out__title span').textContent, body: r.querySelector('.composer-out__body span').textContent,
        newAction: visible('.composer-out__new'), upgrade: visible('.composer-out__upgrade'), export: visible('.composer-out__export'),
        actionRowHidden: r.querySelector('.composer-out__actions').getAttribute('aria-hidden'), next: r.querySelector('.host-credits__next').textContent,
        current: r.querySelector('.host-credits__current').textContent, panelDeadline: r.querySelector('.composer-out__deadline')?.textContent, deadline: r.querySelector('.host-credits__deadline').textContent,
        reconciling: visible('.host-credits__reconciling'), live: r.querySelector('.host-credits__reconcile-live')?.textContent,
        transcript: rect('.transcript-shell'), reply: rect('.transcript-shell ol > li[data-id="reply"]'), lowLines: r.querySelectorAll('.email-low-line').length, deleteDisabled: r.querySelector('.m-delete-mail')?.disabled,
        deleteReason: r.querySelector('.m-mail-notice .m-notice-content')?.textContent.trim(), deleteTab: r.querySelector('.m-delete-mail')?.tabIndex,
        deleteCopy: r.querySelector('.m-delete-normal').textContent, deletes: window.ait411.deletes };
    });
  };
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    let baseline, deleteBaseline, lowBaseline;
    for (const state of states) {
      const value = await scene(state, locale, theme), label = `${locale}/${theme}/${width}/${state}`;
      if (!baseline) baseline = value.boxes;
      assert.deepEqual(value.boxes, baseline, `${label}: composer, question card and panel move 0 px`);
      assert.equal(value.overflowPx, 0, `${label}: no horizontal overflow`);
      assert.deepEqual(value.reservation.filter(n => !n.option).map(n => n.key),
        ['active', 'default', 'host-give-measure', 'host-give', 'host-confirm', 'host-confirm-anonymous', 'one-hour', 'session', 'voiceVisitor', 'host-limit', 'daily-cap'], `${label}: AIT-410 v1 variants stay intact`);
      assert.deepEqual(value.reservation.filter(n => n.option).map(n => n.key),
        ['option-new-conversation', 'option-session-emailGiven', 'option-session-emailConfirmed'], `${label}: O1/O7 reserve every hint and upgrade`);
      assert.ok(value.reservation.every(n => n.cell === '1/1'), `${label}: v1 and O variants share one cell`);
      assert.ok(value.reservation.every(n => value.bodyHeight >= n.height), `${label}: cell reserves the tallest variant`);
      assert.ok(value.reservation.filter(n => n.option).every(n => n.hidden && n.ariaHidden === 'true'), `${label}: O measurements stay hidden and outside AX`);
      assert.ok(Number(value.newAction) + Number(value.upgrade) <= 1, `${label}: one primary action`);
      if (['U2', 'S2'].includes(state)) { assert.equal(value.newAction, true); assert.equal(value.export, true); }
      if (state === 'U3') { assert.equal(value.newAction, false); assert.equal(value.export, false); assert.equal(value.actionRowHidden, 'true'); assert.match(value.deadline, locale === 'de' ? /^Ab .+ wieder verfügbar$/u : /^Available again from /u); assert.equal(value.panelDeadline, value.deadline); }
      if (state === 'S1') { assert.equal(value.upgrade, true); assert.equal(value.export, true); assert.match(value.body, /1[.,]000/u); }
      if (state === 'S3') { assert.equal(value.newAction, false); assert.equal(value.export, true); }
      if (state === 'offer') assert.match(value.next, locale === 'de' ? /^Nach der Bestätigung:/u : /^After confirmation:/u);
      if (state === 'confirmed') assert.match(value.current, locale === 'de' ? /Mit bestätigter E-Mail-Adresse:/u : /With confirmed email address:/u);
      if (state === 'reconciling') { assert.equal(value.footerTextFits, true, `${label}: visible reconciliation never overlaps legal or footer controls ${JSON.stringify(value.footerTextRects)}`); assert.equal(value.reconciling, true); assert.equal(value.live, locale === 'de' ? 'Credits werden abgeglichen …' : 'Updating credits …'); }
      if (state === 'reconciled') { assert.equal(value.reconciling, false); assert.equal(value.live, ''); }
      if (state === 'low-off') { assert.equal(value.lowLines, 0); lowBaseline = { transcript: value.transcript, reply: value.reply }; }
      if (state === 'low-on') { assert.equal(value.lowLines, 1); assert.deepEqual({ transcript: value.transcript, reply: value.reply }, lowBaseline, `${label}: low ask switch moves transcript 0 px`); }
      if (state === 'delete-false') {
        deleteBaseline = value.emailBox; assert.equal(value.deleteDisabled, true); assert.equal(value.deleteTab, -1); assert.equal(value.deleteCopy, '');
        assert.equal(value.deleteReason, locale === 'de' ? 'Hier nicht möglich. Wie die Adresse gelöscht wird, steht in der Datenschutzerklärung.' : 'Not available here. The privacy notice explains how to have the address deleted.');
        await shadow(page, c => c.shadowRoot.querySelector('.m-delete-mail').click()); assert.equal(value.deletes, 0);
      }
      if (state === 'delete-true') { assert.equal(value.deleteDisabled, false); assert.deepEqual(value.emailBox, deleteBaseline, `${label}: capability row keeps its height`); }
      checks.push({ width, locale, theme, state, displacementPx: 0, pass: true, ...value });
      const mobile = width === 390, wideDE = width === 1440 && locale === 'de';
      const capture = theme === 'light' && ((mobile && ['U2', 'U3', 'S1', 'S2', 'S3', 'delete-false'].includes(state)) ||
        mobile && locale === 'de' && ['offer', 'confirmed', 'reconciling', 'low-off', 'delete-true'].includes(state) || wideDE && ['U2', 'U3', 'S2'].includes(state));
      if (evidence && capture) {
        if (['offer', 'confirmed'].includes(state)) await shadow(page, c => c.shadowRoot.querySelector('.host-credits__button').click());
        await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1);
        await shadow(page, async c => { await document.fonts.ready; await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); });
        const file = `ait411-${width}-${theme}-${locale}-${state}.png`;
        await page.screenshot({ path: join(evidence, file), fullPage: false }); shots.push(file);
        if (mobile && locale === 'de' && state === 'S1') {
          await shadow(page, c => c.shadowRoot.querySelector('.composer-shell').scrollIntoView({ block: 'center', behavior: 'instant' }));
          await page.screenshot({ path: join(evidence, 'ait411-390-light-de-shared-cell.png'), fullPage: false });
          await page.evaluate(() => scrollTo(0, 0));
        }
      }
    }
  }
  await scene('U2', 'de', 'light');
  const eventProof = await shadow(page, c => {
    let detail;
    c.addEventListener('aithema-new-conversation', event => { event.preventDefault(); event.stopImmediatePropagation(); detail = event.detail; }, { once: true });
    c.shadowRoot.querySelector('.composer-out__new').click();
    return detail;
  });
  assert.equal(eventProof.previousSessionId, 'ait411'); assert.equal(eventProof.confirm, true);
  checks.push({ assert: 'O1 existing new-session event', pass: true, ...eventProof });
  for (const state of ['low-off', 'S1']) {
    await scene(state, 'de', 'light');
    const opened = await shadow(page, c => {
      c.shadowRoot.querySelector(window.ait411.receipt.exhausted ? '.composer-out__upgrade' : '.credits-email').click();
      return { open: c.shadowRoot.querySelector('dialog.settings').open, lowCredits: window.ait411.lowCredits };
    });
    assert.equal(opened.open, true, `${state}: confirmation entry still opens email settings`);
    assert.equal(opened.lowCredits, false, `${state}: confirmation works with the inline low ask disabled`);
    checks.push({ assert: 'O6 confirmation path', state, pass: true });
  }
  assert.deepEqual(errors, []);
  if (evidence) {
    assert.equal(shots.length, 20, 'exact Tick v1–v1.3 shot list');
    await writeFile(join(evidence, 'ait411-checks.json'), JSON.stringify({ head, workflowSHA: evidenceCommit, runId: process.env.GITHUB_RUN_ID ?? null, checks, shots,
      sharedCellShot: 'ait411-390-light-de-shared-cell.png', errors }, null, 2));
  }
  t.diagnostic(`${checks.length} state checks; 20 viewport shots; one reused page`);
}
