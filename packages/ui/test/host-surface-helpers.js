import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window({ url: 'http://localhost/' });
// Dispose pending DOM tasks after all component assertions, as in session-element.test.js.
const dumpHandles = process.env.AITHEMA_UNIT_HANDLES === '1'
  ? (await import('../../../scripts/unit-handles.js')).dumpHandles : () => {};
test.after(async () => {
  dumpHandles('before happyDOM.close');
  await window.happyDOM.close();
  dumpHandles('after happyDOM.close');
  setImmediate(() => dumpHandles('after teardown microtasks'));
});
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const v = en.hostSurface.verify, l = en.hostSurface.library, h = en.hostSurface.handover, cr = en.hostSurface.credits;

const identity = (extra = {}) => ({ status: 'guest', role: 'visitor', roles: ['visitor'], address: null, verificationRevision: 0, delivery: 'idle',
  expired: false, verificationRequired: false, confirmationAttemptsRemaining: 5, resendAfterMs: 0, canResend: false, pollVerification: false,
  assessmentUnlocked: true, conceptsUnlocked: true, canRunAssessment: true, canRunConcepts: true, paused: false, manualPaused: false, demoBypass: false, ...extra });
const locked = (extra = {}) => identity({ verificationRequired: true, assessmentUnlocked: false, conceptsUnlocked: false, canRunAssessment: false, canRunConcepts: false, ...extra });
const pending = (extra = {}) => locked({ status: 'verification-pending', address: 'visitor@example.com', verificationRevision: 1, delivery: 'sent', resendAfterMs: 60_000, ...extra });
const entry = (id, title, updatedAt) => ({ id, title, revision: 1, createdAt: updatedAt, updatedAt });
const balance = { owner: { limitMicro: 5_000_000, committedMicro: 750_000, availableMicro: 4_250_000, overrunMicro: 0 } };

// A connected component; `routes` maps "METHOD path" (after /api/sessions/:id or /api) to a handler.
function setup(t, { copy = en, host = { library: true, verification: true, handover: true, credits: true }, routes = {}, session: extra = {}, voiceClient } = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  Object.assign(session, extra);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url).replace(`/api/sessions/${c.session.id}`, '').replace(/^\/api/u, ''), method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) { if (options.signal?.aborted) controller.close();
      else options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (routes[key]) return routes[key](body, path);
    if (key === 'GET /identity') return Response.json({ identity: c.session.identity ?? identity(), visitorEmail: { canSave: true, canDelete: true } });
    if (key === 'GET /handover') return Response.json({ handover: { status: 'idle', revision: null }, offer: { available: true } });
    if (key === 'GET /credits') return Response.json({ balance, limitSlot: null });
    if (key === 'GET /library') return Response.json({ items: [], total: 0, offset: 0, limit: 100 });
    return Response.json(c.session);
  });
  c.configure({ copy, session, host, voiceClient }); document.body.append(c);
  t.after(async () => {
    c.remove();
    // Disconnect starts async voice/host cleanup. Drain those continuations while
    // this test's fetch/timer mocks still own them, before the next fixture starts.
    await tick(12);
  });
  return { c, root: c.shadowRoot, calls };
}
const userTurn = (c, id = 't1') => c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id, role: 'user', content: 'We need a preorder app.' } });

const a2Allowances = { anonymous: 12_000_000, emailGiven: 18_000_000, emailConfirmed: 24_000_000 };
function a2Setup(t, { copy = en, address = null, spent = 3_450_000, reserved = 0, delivery = false, privacy = true, handover = false, save, link, visitorRead, creditsRead, question, blocked = false, voiceClient, waitingCall, confirmed = false, endReason = null } = {}) {
  let saved = address, raised = false;
  const allowances = () => ({ ...a2Allowances, anonymous: raised ? 18_000_000 : 12_000_000 });
  const tiers = () => ({ allowancesMicro: allowances(), current: confirmed ? 'emailConfirmed' : saved ? 'emailGiven' : 'anonymous',
    next: confirmed ? null : privacy ? saved ? delivery ? 'emailConfirmed' : null : 'emailGiven' : null,
    delta: confirmed ? 0 : privacy ? saved ? delivery ? 6_000_000 : 0 : 6_000_000 : 0, canConfirm: delivery && privacy });
  const visitor = () => ({ address: saved, tier: confirmed ? 'emailConfirmed' : saved ? 'emailGiven' : 'anonymous', limitMicro: confirmed ? 24_000_000 : saved ? 18_000_000 : allowances().anonymous });
  const features = () => ({ best: Object.fromEntries(['text', 'analysis', 'voice'].map(key => [key, {
    available: visitor().limitMicro > spent + reserved, reason: visitor().limitMicro > spent + reserved ? null : 'budget denied',
  }])) });
  const h = setup(t, { copy, voiceClient, host: { verification: { delivery, privacyDocumentConfigured: privacy }, credits: true, handover },
    session: { demo: false, ...(endReason ? { credits: { status: 'ended', endReason } } : {}), ...(blocked || voiceClient ? { featureMatrix: features() } : {}), ...(waitingCall ? { voiceLifecycle: waitingCall } : {}), identity: identity({ address: saved }), settings: { origin: 'chosen', voice: 'off', visuals: 'off' } }, routes: {
      'GET ': () => Response.json({ ...h.c.session, featureMatrix: features() }),
      'GET /identity': () => Response.json({ identity: identity({ address: saved }), visitorEmail: { canSave: true, canDelete: true }, delivery, privacyDocumentConfigured: privacy }),
      'GET /visitor/email': () => { const read = () => Response.json({ visitor: visitor(), notice: { version: 'ait-135-v1', deliveryEnabled: delivery }, privacyDocumentConfigured: privacy }); return visitorRead ? visitorRead(read) : read(); },
      'GET /credits': () => { const read = () => { const limitMicro = visitor().limitMicro; return Response.json({ balance: { owner: { limitMicro, committedMicro: spent + reserved,
        confirmedSpendMicro: spent, reservedMicro: reserved, uncertainSpendMicro: 0, availableMicro: Math.max(0, limitMicro - spent - reserved) } }, exhausted: spent >= limitMicro, limitSlot: null, tiers: tiers() }); }; return creditsRead ? creditsRead(read) : read(); },
      'PUT /visitor/email': async body => { await save?.(body); saved = body.address; return Response.json({ visitor: visitor() }); },
      ...(link ? { 'POST /identity/request': body => link(body), 'POST /identity/change': body => link(body) } : {}),
      'DELETE /visitor/email': () => { saved = null; return Response.json({ visitor: visitor() }); },
    } });
  if (question) h.c.receive({ seq: h.c.session.seq + 1, type: 'turn.final', data: { id: 'a2-question', role: 'assistant',
    content: question.question_short, inputRevision: inputRevision(h.c.session), ...question } });
  if (privacy) {
    const legal = document.createElement('nav'); legal.slot = 'legal';
    const link = document.createElement('a'); link.href = '/privacy?locale=' + (copy === de ? 'de' : 'en'); link.setAttribute('data-aithema-privacy', ''); legal.append(link); h.c.append(legal);
    h.root.querySelector('slot[name="legal"]').dispatchEvent(new window.Event('slotchange'));
  }
  return { ...h, setSpent: value => { spent = value; }, setReserved: value => { reserved = value; }, topUp: () => { raised = true; } };
}


export { window, tick, v, l, h, cr, identity, locked, pending, entry, balance, setup, userTurn, a2Setup, a2Allowances };
