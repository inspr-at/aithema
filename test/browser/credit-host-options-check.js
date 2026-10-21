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
  const round2 = [], footer80 = [], round2Shots = [];
  t.after(async () => {
    if (evidence) await writeFile(join(evidence, 'ait435-round2-checks.json'), JSON.stringify({ head, footer80, checks: round2, shots: round2Shots, errors }, null, 2));
  });
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
      // This synthetic session owns its event journal. Keep the stream quiet
      // instead of reconnecting to the unrelated demo session between scenes.
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        if (options.signal?.aborted) controller.close();
        else options.signal?.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/features')) return Response.json({});
      if (/\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
      return nativeFetch(url, options);
    };
  });
  const states = ['B1', 'U1', 'U2', 'U3', 'offer', 'confirmed', 'reconciling', 'reconciled', 'low-off', 'low-on', 'S1', 'S2', 'S3', 'delete-false', 'delete-true'];
  const scene = async (state, locale, theme, profile = 'all') => {
    await shadow(page, async (c, { state, locale, theme, profile }) => {
      const f = window.ait411, { [locale]: source } = await import(`/packages/ui/src/i18n/${locale}.js`), copy = structuredClone(source);
      const confirmed = ['U2', 'S2', 'S3', 'confirmed', 'delete-false', 'delete-true'].includes(state);
      const ended = ['U1', 'U2', 'U3', 'S1', 'S2', 'S3', 'host-limit'].includes(state);
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
      session.credits = { status: state.startsWith('S') || state === 'host-limit' ? 'ended' : 'active',
        endReason: state.startsWith('S') ? 'session' : state === 'host-limit' ? 'host-limit' : null };
      session.settings.origin = 'chosen'; session.processingPreset = 'best';
      session.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: false } };
      c.setAttribute('theme', theme); c.setAttribute('motion', 'off');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      c.configure({ copy, session, host: profile === 'none' ? { verification: true, credits: true } : { verification: true, credits: { scope: 'session', reconcilingVisible: profile === 'all' || profile === 'O4', dailyCapReset: profile === 'all' || profile === 'O5' },
        usedUp: { newConversation: { enabled: profile === 'all' && state !== 'S3' }, dailyCapActions: profile === 'all' || profile === 'O2-none' ? 'none' : 'export' }, emailAsk: { lowCredits: f.lowCredits } } });
      let legal = c.querySelector('[slot="legal"][data-aithema-privacy]');
      if (!legal) { legal = document.createElement('a'); legal.slot = 'legal'; legal.setAttribute('data-aithema-privacy', ''); legal.href = '/privacy'; legal.textContent = 'Privacy'; c.append(legal); }
      await document.fonts.ready;
    }, { state, locale, theme, profile });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__value').textContent !== '…', { polling: 'raf', timeout: 30_000 });
    if (state.startsWith('delete-')) await shadow(page, c => c.openSettings(undefined, { tab: 'general', anchor: '#email' }));
    // Settle once after all mutations, then read every box in the same frame.
    return shadow(page, async c => {
      await document.fonts.ready;
      // Measure the settled endpoint of incidental mount transitions. Finishing
      // them avoids paying their wall-clock duration in every matrix scene;
      // the rendered final styles, two paint frames and all asserts stay intact.
      const animations = c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime));
      for (const animation of animations) animation.finish();
      await Promise.all(animations.map(a => a.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = c.shadowRoot, rect = selector => { const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const footerLabel = (r.querySelector('.host-credits__reconciling') ?? r.querySelector('.host-credits__stack')).getBoundingClientRect(), footer = r.querySelector('.display-foot').getBoundingClientRect();
      const footerNeighbors = ['.footer-left', '.host-legal', '.engine-info'].map(selector => ({ selector, box: r.querySelector(selector).getBoundingClientRect() }));
      const footerTextFits = footerLabel.left >= footer.left && footerLabel.right <= footer.right && footerNeighbors.every(({ box }) =>
        box.width === 0 || box.height === 0 || footerLabel.right <= box.left || footerLabel.left >= box.right || footerLabel.bottom <= box.top || footerLabel.top >= box.bottom);
      const visible = selector => { const n = r.querySelector(selector); return !!n && !n.hidden && !n.inert && getComputedStyle(n).visibility === 'visible'; };
      const body = r.querySelector('.composer-out__body');
      const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
      const ink = node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = [];
        while (walker.nextNode()) {
          const text = walker.currentNode, style = getComputedStyle(text.parentElement);
          if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          rects.push(...[...range.getClientRects()].filter(b => b.width > 0 && b.height > 0));
        }
        return rects;
      };
      const primary = r.querySelector('.composer-out__new'), exportLink = r.querySelector('.composer-out__export');
      const primaryBox = primary && !primary.hidden ? box(primary) : null, exportBox = box(exportLink);
      const primaryInk = primaryBox ? ink(primary) : [];
      const activeBody = body.querySelector('[data-active="true"]'), deadline = r.querySelector('.composer-out__deadline');
      const stack = r.querySelector('.host-credits__stack'), flag = box(r.querySelector('.engine__flag'));
      const creditsTarget = box(r.querySelector('.host-credits__button')), engineTarget = box(r.querySelector('.engine-info'));
      const textRight = Math.max(...ink(stack).map(b => b.right));
      const overlapWidth = Math.max(0, Math.min(creditsTarget.right, engineTarget.right) - Math.max(creditsTarget.left, engineTarget.left));
      const overlapHeight = Math.max(0, Math.min(creditsTarget.bottom, engineTarget.bottom) - Math.max(creditsTarget.top, engineTarget.top));
      const legalLinks = [...c.querySelectorAll('[slot="legal"] a, a[slot="legal"]')].map(box);
      const legalGaps = legalLinks.slice(1).map((link, index) => link.left - legalLinks[index].right);
      const footerStyle = getComputedStyle(r.querySelector('.display-foot'));
      const footerSizing = { height: footer.height,
        rows: getComputedStyle(r.querySelector('.display-foot__row')).gridTemplateRows.split(' ').map(parseFloat),
        rowGap: parseFloat(getComputedStyle(r.querySelector('.display-foot__row')).rowGap),
        paddingTop: parseFloat(footerStyle.paddingTop), paddingBottom: parseFloat(footerStyle.paddingBottom),
        composerGap: footer.top - box(r.querySelector('.composer-dock')).bottom,
        row1Targets: ['.ai-notice', '.host-credits__button', '.engine-info'].map(selector => box(r.querySelector(selector)).height),
        legalLinks, legalGaps };
      const footerTargets = ['.ai-notice', '.host-credits__button', '.engine-info', '.legal-toggle']
        .map(selector => { const n = r.querySelector(selector); return n?.checkVisibility({ visibilityProperty: true }) ? { selector, ...box(n) } : null; }).filter(Boolean);
      const targetOverlaps = footerTargets.flatMap((a, i) => footerTargets.slice(i + 1).map(b => ({
        controls: [a.selector, b.selector], area: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) })));
      const footerGeometry = { footerTargets, targetOverlaps, stackRight: box(stack).right, flagLeft: flag.left, stackFlagGap: flag.left - box(stack).right,
        textRight, textFlagGap: flag.left - textRight, creditsTarget, engineTarget, overlapPx2: overlapWidth * overlapHeight, footerSizing };
      const titleNode = r.querySelector('.composer-out__title span'), titleBox = box(titleNode);
      const titleHit = r.elementFromPoint(titleBox.left + titleBox.width / 2, titleBox.top + titleBox.height / 2);
      const actionGeometry = { titleUnobscured: titleNode.contains(titleHit), primary: primaryBox, export: exportBox, rows: [...new Set(primaryInk.map(b => b.top))].length,
        gap: primaryBox ? exportBox.top >= primaryBox.bottom ? exportBox.top - primaryBox.bottom : exportBox.left - primaryBox.right : null,
        bodyBounds: box(activeBody), actions: box(r.querySelector('.composer-out__actions')), deadlineOffset: deadline && !deadline.hidden ? box(deadline).left - box(activeBody).left : null };

      const reservation = [...body.children].map(n => ({ key: n.dataset.creditVariant ?? n.dataset.creditOptionVariant,
        option: n.hasAttribute('data-credit-option-variant'), text: n.textContent,
        cell: [getComputedStyle(n).gridRowStart, getComputedStyle(n).gridColumnStart].join('/'),
        hidden: getComputedStyle(n).visibility === 'hidden', ariaHidden: n.getAttribute('aria-hidden'),
        height: n.getBoundingClientRect().height }));
      return { boxes: Object.fromEntries(['.composer-shell', '.question-card', '.composer-out', '.display-foot'].map(s => [s, rect(s)])),
        footerGeometry, actionGeometry, legalLinks: c.querySelectorAll('[slot="legal"] a, a[slot="legal"]').length,
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
  const recordRound2 = (profile, width, locale, theme, state, value) => {
    const entry = { profile, width, locale, theme, state, body: value.body, ...value.footerGeometry, ...value.actionGeometry };
    round2.push(entry);
    if (['O5', 'O2-none'].includes(profile) && [390, 1440].includes(width) && ['B1', 'U1', 'U2', 'U3', 'S3'].includes(state)) footer80.push(entry);
  };
  const round2Shot = async (profile, state) => {
    if (!evidence) return;
    await shadow(page, async c => {
      c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); scrollTo(0, 0);
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    });
    await page.mouse.move(-1, -1);
    const file = `ait435-390-light-de-${profile}-${state}.png`;
    await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false }); round2Shots.push(file);
  };
  // Exercise the formerly masked option sets without O1. Track the complete
  // inserted/painted union through host-limit, daily-cap and session states.
  for (const profile of ['O4', 'O5', 'O2-none']) await t.test(`${profile} without O1: every option peer can paint`, async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await page.setViewport({ width, height: 1000 });
      let baseline;
      const inserted = new Set(), painted = new Set();
      for (const state of ['B1', 'U1', 'U2', 'U3', 'reconciling', 'reconciled', 'host-limit', 'S1', 'S2', 'S3']) {
        const value = await scene(state, locale, theme, profile), label = `${profile}/${locale}/${theme}/${width}/${state}`;
        recordRound2(profile, width, locale, theme, state, value);
        if (profile === 'O5' && width === 390 && locale === 'de' && theme === 'light' && state === 'U3') await round2Shot(profile, state);
        if (!baseline) baseline = value.boxes;
        assert.deepEqual(value.boxes, baseline, `${label}: composer, question card and panel move 0 px`);
        assert.equal(value.overflowPx, 0, `${label}: no horizontal overflow`);
        assert.ok(Number(value.newAction) + Number(value.upgrade) <= 1, `${label}: one primary action`);
        if (profile === 'O4' && state === 'reconciling') {
          assert.equal(value.reconciling, true); assert.equal(value.footerTextFits, true);
          assert.equal(value.live, locale === 'de' ? 'Credits werden abgeglichen …' : 'Updating credits …');
        }
        if (profile === 'O4' && state === 'reconciled') { assert.equal(value.reconciling, false); assert.equal(value.live, ''); }
        if (profile === 'O5' && state === 'U3') { assert.ok(value.deadline.length > 0); assert.equal(value.panelDeadline, value.deadline); }
        if (profile === 'O2-none' && state === 'U3') { assert.equal(value.actionRowHidden, 'true'); assert.equal(value.export, false); }
        const peers = value.reservation.filter(n => n.option);
        assert.deepEqual(peers.map(n => n.key), state.startsWith('S')
          ? ['option-session-emailConfirmed'] : [], `${label}: no never-painted option peers`);
        const active = state === 'S1' ? 'option-session-emailConfirmed' : null;
        for (const peer of peers) {
          inserted.add(peer.key);
          assert.equal(peer.hidden, peer.key !== active, `${label}: reachable option paint (${peer.key})`);
          assert.equal(peer.ariaHidden, String(peer.key !== active), `${label}: reachable option AX (${peer.key})`);
          if (!peer.hidden) painted.add(peer.key);
        }
        assert.ok(value.reservation.every(n => n.cell === '1/1'), `${label}: one composer reservation`);
        assert.ok(value.reservation.every(n => value.bodyHeight >= n.height), `${label}: tallest real variant fits`);
        assert.equal(value.reservation.some(n => n.key === 'host-give-measure'), false, `${label}: no AIT-434 spacer`);
        checks.push({ profile, width, locale, theme, state, displacementPx: 0, pass: true, ...value });
      }
      assert.deepEqual([...inserted].sort(), [...painted].sort(), `${profile}/${locale}/${theme}/${width}: every inserted option peer paints in a reachable state`);
    }
  });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    let baseline, deleteBaseline, lowBaseline;
    for (const state of states) {
      const value = await scene(state, locale, theme), label = `${locale}/${theme}/${width}/${state}`;
      recordRound2('all', width, locale, theme, state, value);
      if (!baseline) baseline = value.boxes;
      assert.deepEqual(value.boxes, baseline, `${label}: composer, question card and panel move 0 px`);
      assert.equal(value.overflowPx, 0, `${label}: no horizontal overflow`);
      assert.deepEqual(value.reservation.filter(n => !n.option).map(n => n.key),
        ['active', 'default', 'host-give', 'host-confirm', 'host-confirm-anonymous', 'one-hour', 'session', 'voiceVisitor', 'host-limit', 'daily-cap'], `${label}: AIT-410 v1 variants stay intact`);
      assert.deepEqual(value.reservation.filter(n => n.option).map(n => n.key),
        state === 'S3' ? ['option-session-emailConfirmed'] : ['option-new-conversation', 'option-session-emailConfirmed'], `${label}: O1/O7 reserve every enabled hint and upgrade`);
      assert.ok(value.reservation.every(n => n.cell === '1/1'), `${label}: v1 and O variants share one cell`);
      assert.ok(value.reservation.every(n => value.bodyHeight >= n.height), `${label}: cell reserves the tallest variant`);
      const activeOption = state === 'S1' ? 'option-session-emailConfirmed' : ['U2', 'S2'].includes(state) ? 'option-new-conversation' : null;
      for (const variant of value.reservation.filter(n => n.option)) {
        const painted = variant.key === activeOption;
        assert.equal(variant.hidden, !painted, `${label}: real option variant paints in its state (${variant.key})`);
        assert.equal(variant.ariaHidden, String(!painted), `${label}: only painted option text enters AX (${variant.key})`);
      }
      assert.ok(Number(value.newAction) + Number(value.upgrade) <= 1, `${label}: one primary action`);
      if (['U2', 'S2'].includes(state)) { assert.equal(value.newAction, true); assert.equal(value.export, true); }
      if (state === 'U3') { assert.equal(value.newAction, false); assert.equal(value.export, false); assert.equal(value.actionRowHidden, 'true'); assert.match(value.deadline, locale === 'de' ? /^Ab .+ wieder verfügbar$/u : /^Available again from /u); assert.equal(value.panelDeadline, value.deadline); }
      if (state === 'S1') { assert.equal(value.upgrade, true); assert.equal(value.export, true); assert.match(value.body, /1[.,]000/u); }
      if (state === 'S1') assert.equal(value.body, locale === 'de' ? 'Mit bestätigter E-Mail-Adresse geht es mit 1.000\u00a0Credits weiter.' : 'With a confirmed email address, this continues with 1,000\u00a0credits.', `${label}: complete S1 copy and NBSP`);
      if (state === 'S3') { assert.equal(value.newAction, false); assert.equal(value.export, true); }
      if (state === 'offer') {
        assert.match(value.next, locale === 'de' ? /^Nach der Bestätigung:/u : /^After confirmation:/u);
        assert.equal(value.next, locale === 'de' ? 'Nach der Bestätigung: 1.000\u00a0Credits' : 'After confirmation: 1,000\u00a0credits', `${label}: shipped O3 catalog copy and NBSP`);
      }
      if (state === 'confirmed') assert.match(value.current, locale === 'de' ? /Mit bestätigter E-Mail-Adresse:/u : /With a confirmed email address: 1,000\u00a0credits/u);
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
  await page.setViewport({ width: 390, height: 1000 });
  const noOptions = await scene('B1', 'de', 'light', 'none');
  recordRound2('none', 390, 'de', 'light', 'B1', noOptions);
  assert.equal(noOptions.legalLinks, 3, 'no-options evidence host has three legal links');
  await round2Shot('none', 'B1');
  await t.test('AIT-435 item 1: single-line primary, 12 px gap and reserved phone export row', () => {
    const cases = round2.filter(v => v.profile === 'all' && ['S2', 'U2'].includes(v.state));
    for (const value of cases) {
      const label = JSON.stringify(value);
      assert.equal(value.rows, 1, label);
      assert.ok(value.primary.top >= value.bodyBounds.bottom, `${label}: body clears the primary target`);
      assert.ok(value.gap >= 12, label);
      if (value.width < 600) assert.ok(value.export.top >= value.primary.bottom + 12, label);
    }
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      const usedUp = round2.filter(v => v.profile === 'all' && v.locale === locale && v.theme === theme && v.width === width && ['U1', 'U2', 'U3', 'S1', 'S2', 'S3'].includes(v.state));
      for (const value of usedUp) {
        assert.equal(value.titleUnobscured, true, `${locale}/${theme}/${width}/${value.state}: panel title is unobscured`);
        assert.deepEqual(value.actions, usedUp[0].actions, `${locale}/${theme}/${width}/${value.state}: actions reserve 0 px`);
      }
    }
  });
  await t.test('AIT-435 item 2: S3 without O1 paints sessionDefaultBody', () => {
    for (const value of round2.filter(v => v.state === 'S3')) assert.equal(value.body,
      value.locale === 'de' ? 'Ihr Verlauf bleibt gespeichert.' : 'Your transcript stays saved.', JSON.stringify(value));
  });
  await t.test('AIT-435 item 4: U3 deadline aligns with body within 0.5 px', () => {
    for (const value of round2.filter(v => v.deadlineOffset !== null)) assert.ok(Math.abs(value.deadlineOffset) <= .5, JSON.stringify(value));
  });
  await t.test('AIT-435 item 5: 80 measurements, text/flag gap >= 8 px and no target overlap at every width', () => {
    assert.equal(footer80.length, 80);
    assert.ok(round2.every(v => Number.isFinite(v.textRight) && Number.isFinite(v.textFlagGap) && Number.isFinite(v.overlapPx2)), 'every case measures visible credits ink and both tap targets');
    const failures = round2.filter(v => v.textFlagGap < 8 || v.overlapPx2 !== 0);
    assert.deepEqual(failures, [], JSON.stringify(failures));
    for (const value of footer80) {
      if (value.width < 600) assert.equal(value.footerTargets.length, 4, `${JSON.stringify(value)}: four phone controls including legal`);
      assert.ok(value.targetOverlaps.every(pair => pair.area === 0), `${JSON.stringify(value)}: no footer tap targets overlap`);
    }
  });
  await t.test('AIT-435 Tick v1.6: two-row phone minimums and unchanged 44 px first row', () => {
    for (const value of round2.filter(v => v.width < 600)) {
      const sizing = value.footerSizing, label = `${value.profile}/${value.locale}/${value.theme}/${value.state}: ${JSON.stringify(sizing)}`;
      assert.deepEqual(sizing.rows, [44, 28], `${label}: 44 px controls then 28 px legal row`);
      assert.deepEqual(sizing.row1Targets, [44, 44, 44], `${label}: notice, credits and engine keep real 44 px targets`);
      assert.ok(sizing.legalLinks.every(link => link.height >= 24), `${label}: legal hit areas >=24 px high`);
      assert.ok(sizing.legalGaps.every(gap => gap >= 12), `${label}: legal links separated by >=12 px`);
      assert.ok(sizing.paddingTop >= 6 && sizing.paddingBottom >= 6, `${label}: footer padding >=6 px`);
      assert.ok(sizing.composerGap >= 8, `${label}: composer/footer gap >=8 px`);
    }
    t.diagnostic(`AIT-435 Tick v1.6 phone sizing: ${JSON.stringify(round2.find(v => v.width === 390).footerSizing)}`);
  });
  t.diagnostic(`${checks.length} state checks; 20 viewport shots; one reused page`);
}
