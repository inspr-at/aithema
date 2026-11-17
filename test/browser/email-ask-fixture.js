import assert from 'node:assert/strict';
import { shadow, until } from './start2-display-helpers.js';

// Wait for rendered state and finite transitions, including the phone dock's
// lift. Infinite call/wave animations must not hold the evidence capture open.
export const settle = page => shadow(page, async c => {
  await document.fonts.ready;
  await new Promise(requestAnimationFrame);
  await Promise.all(c.shadowRoot.querySelector('.workspace').getAnimations({ subtree: true })
    .filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime))
    .map(a => a.finished.catch(() => {})));
  await new Promise(requestAnimationFrame);
});
export const stable = (before, after, label) => {
  const shift = Math.max(...before.flatMap((row, i) => row.map((value, j) => Math.abs(value - after[i][j]))));
  assert.equal(shift, 0, `${label}: layout shift ${shift} px; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return shift;
};

// Only this test supplies fixture values. The shipped component reads every
// tier, price, balance, address and ask record through its normal host routes.
export async function fixture(page, locale, { delivery = false, confirmationEnabled = delivery, address = null, confirmed = false, low = false, out = false, voice = false, motion = 'off', consentDelayMs = 0, emailOffer, initialMessages = 4, lock = false, tierAllowances, opener = false, visitorStore = true } = {}) {
  await shadow(page, async (c, options) => {
    const { locale, delivery, confirmationEnabled, address, confirmed, low, out, voice, motion, consentDelayMs, emailOffer, initialMessages, lock, tierAllowances, opener, visitorStore } = options;
    const canConfirm = delivery && confirmationEnabled;
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { inputRevision } = await import('/packages/core/src/session.js');
    const { voiceEvents } = await import('/packages/core/src/live-voice.js');
    window.ait164Fetch ??= window.fetch.bind(window);
    const allowancesMicro = tierAllowances ?? { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
    window.ait164Locale = locale;
    const state = window.ait164 = { address, confirmed, spent: 3_450_000, ask: {}, after: 0, lowClaim: { after: 0, armed: true }, creditsReads: 0, visitorReads: 0, identityReads: 0, saving: false, saveFails: false, linkFails: false, requests: [], voiceEvents: null };
    const tier = () => state.confirmed ? 'emailConfirmed' : visitorStore && state.address ? 'emailGiven' : 'anonymous';
    const identity = () => ({ ...c.session.identity, address: state.address, status: state.confirmed ? 'verified' : state.address && canConfirm ? 'verification-pending' : 'guest',
      assessmentUnlocked: !lock || state.confirmed, conceptsUnlocked: !lock || state.confirmed, verificationRequired: lock, pollVerification: false, resendAfterMs: 0, delivery: 'sent' });
    const visitor = () => ({ address: state.address, tier: tier(), limitMicro: allowancesMicro[tier()] });
    if (low || out) state.spent = allowancesMicro[tier()] - (out ? 0 : 980_000);
    const credits = () => { const current = tier(), limitMicro = allowancesMicro[current], next = !visitorStore ? canConfirm && !state.confirmed ? 'emailConfirmed' : null : !state.address ? allowancesMicro.emailGiven > allowancesMicro.anonymous ? 'emailGiven' : canConfirm && allowancesMicro.emailConfirmed > allowancesMicro.anonymous ? 'emailConfirmed' : null : canConfirm && !state.confirmed ? 'emailConfirmed' : null;
      return { tiers: { current, next, delta: next ? allowancesMicro[next] - limitMicro : 0, canConfirm, allowancesMicro },
        exhausted: state.spent >= limitMicro, lowAtMicro: Math.max(limitMicro / 10, 5 * 100_000), lowAtMaxMicro: Math.max(allowancesMicro.emailConfirmed / 10, 5 * 100_000),
        emailOffer: state.offer ?? {}, emailAsk: state.ask, emailAskAfter: state.after, lowEmailAsk: state.lowClaim, nowMs: Date.now(), limitSlot: null,
        balance: { owner: { limitMicro, committedMicro: state.spent, confirmedSpendMicro: state.spent, reservedMicro: 0, uncertainSpendMicro: 0, availableMicro: Math.max(0, limitMicro - state.spent) } } }; };
    state.credits = credits;
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname, method = init.method ?? 'GET';
      if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      if (path.endsWith('/credits')) { state.creditsReads++; return Response.json(credits()); }
      if (path === `/api/sessions/${c.session.id}`) return Response.json({ ...c.session, identity: identity(), featureMatrix: c.session.featureMatrix });
      if (path.endsWith('/visitor/email')) {
        state.visitorReads++;
        if (!visitorStore) { if (method === 'PUT') state.requests.push('refused-save'); return Response.json({ error: 'visitor-unavailable' }, { status: 404 }); }
        if (method === 'PUT') { state.requests.push('save'); state.noticeVersion = JSON.parse(init.body).noticeVersion; while (state.saving) await new Promise(resolve => setTimeout(resolve, 20)); if (state.saveFails || state.saveStatus) return Response.json({ error: 'unavailable' }, { status: state.saveStatus ?? 503 }); state.address = JSON.parse(init.body).address; state.confirmed = false; }
        return Response.json({ visitor: visitor(), notice: { version: 'ait-135-v1', deliveryEnabled: delivery }, privacyDocumentConfigured: true });
      }
      if (path.endsWith('/identity')) { state.identityReads++; return Response.json({ identity: identity(), delivery, privacyDocumentConfigured: true, ...(emailOffer ? { visitorEmail: { canSave: visitorStore, canDelete: visitorStore } } : {}) }); }
      if (/\/identity\/(request|change|resend)$/u.test(path)) {
        state.requests.push('link');
        (state.identityCommands ??= []).push({ command: path.split('/').at(-1), body: JSON.parse(init.body) });
        while (state.linking) await new Promise(resolve => setTimeout(resolve, 20));
        const status = state.linkStatus ?? (state.linkFails ? 503 : 200);
        if (!visitorStore && status === 200) state.address = JSON.parse(init.body).address ?? state.address;
        return Response.json({ identity: { ...identity(), delivery: state.linkDelivery ?? 'sent' } }, { status });
      }
      if (path.endsWith('/email-ask')) {
        const body = JSON.parse(init.body); state.askRequests ??= []; state.askRequests.push(body);
        if (body.why === 'offer') {
          const accepted = body.action === 'dismiss' || !state.offer?.offered;
          state.offer = { offered: true, open: body.action === 'show', dismissed: body.action === 'dismiss', at: c.session.transcript.at(-1).id };
          return Response.json({ accepted, emailOffer: state.offer });
        }
        const count = c.session.transcript.filter(t => t.role === 'user' && !t.erased).length;
        let accepted = true;
        if (body.action === 'show') {
          if (body.why === 'turn5' && state.after > Date.now() || body.why === 'low' && (!state.lowClaim.armed || state.lowClaim.after > Date.now())) accepted = false;
          else { Object.assign(state.ask, { open: true, why: body.why, openedAt: count, folded: false });
            if (body.why === 'turn5') { state.ask.shown5 = true; state.after = Date.now() + 86_400_000; }
            else state.lowClaim = { after: Date.now() + 86_400_000, armed: false }; }
        } else if (body.action === 'line') {
          const values = credits(), next = values.tiers.next;
          state.ask.lowLine ??= { at: c.session.transcript.at(-1).id, kind: next === 'emailGiven' ? 'give' : next === 'emailConfirmed' ? 'confirm' : 'none', deltaMicro: values.tiers.delta, availableMicro: values.balance.owner.availableMicro };
        } else if (body.action === 'rearm') {
          accepted = credits().balance.owner.availableMicro > credits().lowAtMicro && !state.lowClaim.armed;
          if (accepted) state.lowClaim.armed = true;
        } else { state.ask.open = false; state.ask.folded = body.action === 'fold'; }
        if (accepted) state.ask.revision = (state.ask.revision ?? 0) + 1;
        return Response.json({ accepted, emailAsk: state.ask, emailAskAfter: state.after, lowEmailAsk: state.lowClaim, nowMs: Date.now() });
      }
      // The post-save credit refresh also reads consent before sending a link.
      if (consentDelayMs && path.endsWith('/consent')) await new Promise(resolve => setTimeout(resolve, consentDelayMs));
      return window.ait164Fetch(url, init);
    };
    for (const n of c.querySelectorAll('[slot="legal"]')) n.remove();
    const legal = document.createElement('a'); legal.slot = 'legal'; legal.href = '/privacy'; legal.setAttribute('data-aithema-privacy', ''); c.append(legal);
    const session = structuredClone(c.session); session.locale = locale; session.demo = false; session.paused = false; delete session.voiceLifecycle;
    session.identity = identity(); if (emailOffer) session.emailOffer = emailOffer; else delete session.emailOffer; session.settings = { ...session.settings, origin: 'chosen', voice: 'off', visuals: 'off' };
    session.transcript = Array.from({ length: initialMessages }, (_, i) => [
      { id: `fixture-u${i}`, role: 'user', content: locale === 'de' ? 'Ich möchte meine Anforderungen besprechen.' : 'I would like to discuss my requirements.' },
      { id: `fixture-a${i}`, role: 'assistant', content: locale === 'de' ? 'Welche Ziele haben Sie?' : 'What are your goals?' },
    ]).flat();
    if (opener) {
      session.opener = { locale, text: locale === 'de' ? 'Willkommen. Ihre KI-Assistenz ist bereit.' : 'Welcome. Your AI assistant is ready.' };
      if (opener === 'persisted') session.transcript.unshift({ id: 'host:opener', role: 'assistant', origin: 'host', content: session.opener.text });
    } else delete session.opener;
    session.understanding = { ...session.understanding, inputRevision: inputRevision(session), readinessAssessed: true,
      summary: locale === 'de' ? 'Die Person möchte eine Website für ihr Vorhaben.' : 'The person wants a website for their project.', conversationReadiness: .5, implementationReadiness: .2 };
    session.featureMatrix = { best: { text: { available: !out }, analysis: { available: true }, voice: { available: !out } } };
    const voiceClient = voice ? { manifest: { liveVoice: { capabilities: { setInput: 'native', setOutput: 'native', pause: 'native', resume: 'native', updateContext: 'native' } } },
      async start(request) { const events = voiceEvents(); state.voiceEvents = events; return { callId: request.callId, providerSessionId: 'gate-fixture-provider', events,
        async setInput() {}, async setOutput() {}, async updateContext() {}, async heartbeat() {}, async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; }, async close() { events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } }; } } : undefined;
    c.setAttribute('motion', motion); c.configure({ session, copy, voiceClient, ...(opener ? { entrance: 'combined' } : {}), host: { credits: true, verification: { delivery, privacyDocumentConfigured: true } } });
    state.reply = () => { const i = c.session.transcript.length;
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `u${i}`, role: 'user', content: locale === 'de' ? 'Ja.' : 'Yes.' } });
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `a${i}`, role: 'assistant', content: locale === 'de' ? 'Wie soll es weitergehen?' : 'How would you like to continue?' } }); };
    if (voice) c.shadowRoot.querySelector('.voice-start').click();
  }, { locale, delivery, confirmationEnabled, address, confirmed, low, out, voice, motion, consentDelayMs, emailOffer, initialMessages, lock, tierAllowances, opener, visitorStore });
  await until(page, visitorStore => {
    const c = document.querySelector('aithema-session'), s = window.ait164;
    return s.creditsReads > 0 && (visitorStore ? s.visitorReads > 0 : true) && s.identityReads > 0 &&
      c.shadowRoot.querySelector('.host-credits__amount').textContent.trim() !== '';
  }, visitorStore);
  if (voice) await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
  await settle(page);
  // Capture the live dock above the fixed footer, with the sticky band still
  // in the viewport. A full-page capture would repaint that band over content.
  if (page.viewport().width < 960) {
    await shadow(page, c => c.shadowRoot.querySelector('.composer-dock').scrollIntoView({ block: 'end' }));
    await page.evaluate(() => window.scrollBy(0, 72));
    await settle(page);
  }
}


export const click = (page, selector) => shadow(page, (c, selector) => c.shadowRoot.querySelector(selector).click(), selector);
