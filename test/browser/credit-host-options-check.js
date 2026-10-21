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
  const round2 = [], footer80 = [], round2Shots = [], legalChecks = [], legalShots = [];
  t.after(async () => {
    if (evidence) {
      await writeFile(join(evidence, 'ait435-round2-checks.json'), JSON.stringify({ head, footer80, checks: round2, shots: round2Shots, errors }, null, 2));
      await writeFile(join(evidence, 'ait435-r4-checks.json'), JSON.stringify({ head, spec:'Tick v1.7', footer80, legalChecks, shots:legalShots, errors }, null, 2));
    }
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
      if (innerWidth >= 600) footerTargets.push(...[...c.querySelectorAll('[slot="legal"] a, a[slot="legal"]')]
        .filter(n => n.checkVisibility({ visibilityProperty:true })).map((n, i) => ({ selector:`legal[${i}]`, ...box(n) })));
      const targetOverlaps = footerTargets.flatMap((a, i) => footerTargets.slice(i + 1).map(b => ({
        controls: [a.selector, b.selector], area: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) })));
      let legalState = null;
      const toggle = r.querySelector('.legal-toggle');
      if (innerWidth < 600 && toggle) {
        const positions = () => ['.display-foot', '.display-foot__row', '.composer-dock', '.ai-notice', '.host-credits__button', '.engine-info', '.legal-toggle'].map(selector => box(r.querySelector(selector)));
        const modal = r.querySelector('dialog[open]');
        if (modal) modal.close();
        const closed = positions(), sources = [...c.querySelectorAll('[slot="legal"] a, a[slot="legal"]')];
        const attrs = n => ({ label:n.getAttribute('aria-label') ?? n.textContent, href:n.getAttribute('href'), target:n.getAttribute('target'), rel:n.getAttribute('rel') });
        toggle.click();
        for (const animation of r.querySelector('.legal-popup').getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        const popup = r.querySelector('.legal-popup'), links = [...popup.querySelectorAll('a')];
        legalState = { closed, open:positions(), popup:box(popup), control:box(toggle), fontSize:getComputedStyle(toggle).fontSize, label:toggle.textContent,
          haspopup:toggle.getAttribute('aria-haspopup'), expanded:toggle.getAttribute('aria-expanded'), controls:toggle.getAttribute('aria-controls'),
          role:popup.getAttribute('role'), name:popup.getAttribute('aria-label'), modal:popup.getAttribute('aria-modal'),
          firstFocused:r.activeElement === links[0], source:sources.map(attrs), links:links.map(attrs),
          linkHits:links.map(n => { const b = n.getBoundingClientRect(); return [[b.left+1,b.top+1],[b.right-1,b.top+1],[b.left+1,b.bottom-1],[b.right-1,b.bottom-1],[(b.left+b.right)/2,(b.top+b.bottom)/2]].every(([x,y]) => n.contains(r.elementFromPoint(x,y))); }),
          linkBoxes:links.map(box), lines:links.map(n => { const range = document.createRange(); range.selectNodeContents(n); return new Set([...range.getClientRects()].map(b => b.y)).size; }),
          originalLinksVisible:sources.some(n => n.checkVisibility({ visibilityProperty:true })),
          visiblePopups:[...r.querySelectorAll('.footer-popup')].filter(n => n.checkVisibility({ visibilityProperty:true, opacityProperty:true })).map(n => n.className) };
        popup.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
        legalState.escaped = positions(); legalState.escapeFocused = r.activeElement === toggle;
        legalState.closedExpanded = toggle.getAttribute('aria-expanded');
        toggle.blur();
        if (modal) modal.showModal();
      }
      const footerGeometry = { legalState, footerTargets, targetOverlaps, stackRight: box(stack).right, flagLeft: flag.left, stackFlagGap: flag.left - box(stack).right,
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
  await t.test('AIT-435 Tick v1.7: one-row phone legal dialog, exact links and zero movement', async () => {
    for (const value of round2.filter(v => v.width < 600)) {
      const sizing = value.footerSizing, state = value.legalState, label = `${value.profile}/${value.locale}/${value.theme}/${value.state}`;
      assert.deepEqual(sizing.rows, [44], `${label}: one 44 px row`);
      assert.equal(sizing.height, 57, `${label}: original footer budget`);
      assert.deepEqual(sizing.row1Targets, [44, 44, 44], `${label}: notice, credits and engine keep real 44 px targets`);
      assert.ok(sizing.paddingTop >= 6 && sizing.paddingBottom >= 6, `${label}: footer padding >=6 px`);
      assert.equal(sizing.composerGap, 12, `${label}: original composer gap`);
      assert.ok(state.control.width >= 44 && state.control.height === 44, label);
      assert.equal(state.fontSize, '12.5px', label);
      assert.equal(state.control.right, value.width - 12, `${label}: control at gutter`);
      assert.equal(state.label, value.locale === 'de' ? 'Rechtliches' : 'Legal');
      assert.equal(state.haspopup, 'dialog'); assert.equal(state.expanded, 'true'); assert.equal(state.controls, 'legal-popup');
      assert.equal(state.role, 'dialog'); assert.equal(state.name, state.label); assert.notEqual(state.modal, 'true');
      assert.equal(state.firstFocused, true); assert.equal(state.escapeFocused, true); assert.equal(state.closedExpanded, 'false');
      assert.deepEqual(state.open, state.closed, `${label}: opening moves nothing`);
      assert.deepEqual(state.escaped, state.closed, `${label}: closing moves nothing`);
      assert.deepEqual(state.links, state.source, `${label}: configured labels, href bytes, targets and rel in order`);
      assert.equal(state.originalLinksVisible, false, `${label}: no host legal link in the footer row`);
      assert.equal(state.visiblePopups.length, 1, `${label}: exactly one footer popup`);
      assert.ok(state.popup.width >= 200 && state.popup.width <= value.width - 24, label);
      assert.equal(state.popup.right, value.width - 12, `${label}: popup at gutter`);
      assert.ok(state.popup.bottom < state.control.top, `${label}: popup opens upward`);
      for (const link of state.linkBoxes) { assert.equal(link.height, 44, label); assert.equal(link.width, state.linkBoxes[0].width, label); }
      assert.ok(state.linkHits.every(Boolean), `${label}: every link corner and centre is clickable`);
      assert.ok(state.lines.every(lines => lines >= 1 && lines <= 2), `${label}: labels never truncate`);
    }
    const capture = async name => {
      if (!evidence) return;
      await page.mouse.move(-1, -1);
      const state = await shadow(page, async c => {
        c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready;
        await Promise.all(c.shadowRoot.getAnimations({ subtree:true }).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = c.shadowRoot, button = r.querySelector('.legal-toggle'), popup = r.querySelector('.legal-popup');
        return { expanded:button.getAttribute('aria-expanded'), visible:popup.checkVisibility({ visibilityProperty:true, opacityProperty:true }),
          active:r.activeElement?.className ?? null, pinned:r.querySelector('.host-legal').hasAttribute('data-pinned'), dismissed:r.querySelector('.host-legal').hasAttribute('data-dismissed') };
      });
      assert.equal(state.expanded, String(name.endsWith('-open.png')), `${name}: capture expansion ${JSON.stringify(state)}`);
      assert.equal(state.visible, name.endsWith('-open.png'), `${name}: capture visibility ${JSON.stringify(state)}`);
      legalChecks.push({ shot:name, ...state });
      await page.screenshot({ path:join(evidence, name), fullPage:false, captureBeyondViewport:false }); legalShots.push(name);
    };
    for (const [locale, theme] of [['de', 'light'], ['de', 'dark'], ['en', 'light']]) {
      await page.setViewport({ width:390, height:844 });
      await scene('U3', locale, theme, 'O5');
      if (locale === 'de' && theme === 'light') await capture('ait435-r4-390-light-de-O5-U3-closed.png');
      await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').focus());
      await page.keyboard.press('Enter');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('.legal-popup a')), true, 'Enter focuses first link');
      await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.activeElement === c.shadowRoot.querySelector('.legal-toggle')), true, 'real Escape returns focus');
      await page.keyboard.press('Space');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').getAttribute('aria-expanded')), 'true', 'Space opens');
      await shadow(page, c => c.shadowRoot.querySelector('.legal-popup a:last-child').focus());
      await page.keyboard.press('Tab');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').getAttribute('aria-expanded')), 'false', 'Tab past last link closes without trapping focus');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-legal').contains(c.shadowRoot.activeElement)), false, 'Tab continues outside legal');
      await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').click());
      await page.mouse.click(1, 1);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').getAttribute('aria-expanded')), 'false', 'outside tap closes');
      await shadow(page, c => {
        const r = c.shadowRoot;
        r.querySelector('.host-credits__button').click(); r.querySelector('.legal-toggle').click();
      });
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits').hasAttribute('data-pinned')), false, 'legal closes credits');
      await shadow(page, c => c.shadowRoot.querySelector('.engine-info').focus());
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').getAttribute('aria-expanded')), 'false', 'engine focus closes legal');
      await shadow(page, c => c.shadowRoot.querySelector('.legal-toggle').click());
      assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility), 'hidden', 'legal closes engine popup');
      await capture(`ait435-r4-390-${theme}-${locale}-O5-U3-open.png`);
      legalChecks.push({ locale, theme, keyboard:true, outside:true, tabContinues:true, exclusive:true });
    }
    await page.setViewport({ width:320, height:844 });
    const narrow = await scene('U3', 'de', 'light', 'O5');
    assert.equal(narrow.footerGeometry.legalState.fontSize, '12.5px', '320px credit host keeps specified control type');
    assert.ok(narrow.footerGeometry.textFlagGap >= 8);
    assert.ok(narrow.footerGeometry.targetOverlaps.every(pair => pair.area === 0));
    legalChecks.push({ width:320, profile:'O5', ...narrow.footerGeometry });
    // Boundary and host independence: no credit ports, nested links, exact URL bytes,
    // a two-line label, and live edits before activation all use the same dialog.
    await shadow(page, async c => {
      for (const n of c.querySelectorAll('[slot="legal"]')) n.remove();
      const nav = document.createElement('nav'); nav.slot = 'legal';
      nav.innerHTML = '<a href="/imprint?x=%2f&amp;y=1#top" target="_blank" rel="noopener external">Legal information and contact details</a><a href="/privacy">Privacy</a>';
      c.append(nav); const { en:copy } = await import('/packages/ui/src/i18n/en.js'); c.configure({ copy, host:{}, session:c.session });
    });
    for (const width of [320, 599, 600, 1024]) {
      await page.setViewport({ width, height:844 });
      const state = await shadow(page, async c => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = c.shadowRoot, button = r.querySelector('.legal-toggle'), source = c.querySelector('nav[slot="legal"] a');
        const shown = n => n.checkVisibility({ visibilityProperty:true });
        const before = r.querySelector('.display-foot').getBoundingClientRect().height;
        if (innerWidth < 600) button.click();
        const links = [...r.querySelectorAll('.legal-popup a')];
        const result = { control:shown(button), fontSize:getComputedStyle(button).fontSize, source:shown(source), height:before,
          href:links[0]?.getAttribute('href'), target:links[0]?.getAttribute('target'), rel:links[0]?.getAttribute('rel'),
          rows:links.map(n => n.getBoundingClientRect().height), clipped:links.some(n => n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) };
        if (innerWidth < 600) button.click(); return result;
      });
      assert.equal(state.control, width < 600); assert.equal(state.source, width >= 600);
      assert.equal(state.height, 57);
      if (width < 600) { assert.equal(state.fontSize, '12.5px'); assert.equal(state.href, '/imprint?x=%2f&y=1#top'); assert.equal(state.target, '_blank'); assert.equal(state.rel, 'noopener external'); assert.deepEqual(state.rows, [44, 44]); assert.equal(state.clipped, false); }
      legalChecks.push({ width, ...state });
    }
  });
  t.diagnostic(`${checks.length} state checks; 20 viewport shots; one reused page`);
}
