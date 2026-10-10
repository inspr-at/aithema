import { createIdentity, identityView, reduceIdentity, createHandover, handoverView, reduceHandover,
  assertLibraryPort, assertHandoverPort, budgetCreditView, createCredits, rebindCredits, reduceCredits, creditsView, inputRevision, LibraryPortError,
  operationScope, untilCancelled } from '@inspr/aithema-core';
import { NotFoundError } from './storage.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const idPattern = '[a-zA-Z0-9_-]{1,128}';
const object = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key));

/** Host ports are trusted server configuration, never request payloads.
 * identity: configuration({sessionId,ownerToken}), requestVerification(effect),
 * verify({sessionId,ownerToken,address,revision,token?}) -> authoritative evidence.
 * library(ownerToken,hooks), handover(ownerToken), wallet(ownerToken) are owner-bound.
 * All asynchronous replies recheck ownership before publication. */
export function createHostHandlers({ storage, host, ownership, readBody, publish, snapshot, createConversation,
  eraseConversation, unlocked, budget, now = () => Date.now(), signal, deadlineMs = 30_000 }) {
  if (host?.policy?.verificationRequired === true && (host.identity?.deliversVerification !== true ||
      typeof host.identity.requestVerification !== 'function' || typeof host.identity.verify !== 'function')) {
    throw new TypeError('Verification lock requires a delivering identity port');
  }
  const deliveries = new Map();
  const clock = state => Math.max(now(), state?.lastNow ?? 0);
  async function callHost(fn) {
    const deadlineAt = Date.now() + deadlineMs, scope = operationScope({ signal, deadlineAt });
    try { return await untilCancelled(Promise.resolve().then(() => fn({ signal: scope.signal, deadlineAt })), scope.signal); }
    finally { scope.dispose(); }
  }
  const body = async (request, keys) => {
    const bytes = await readBody(request);
    const value = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
    if (!object(value, keys)) throw new TypeError('Invalid host command');
    return value;
  };
  const emit = (id, result) => { for (const event of result.events) publish(id, event); return result; };
  function initialIdentity(id, ownerToken, newSession = false) {
    if (!host.identity) return null;
    const identity = createIdentity({ ...host.identity.configuration?.({ sessionId: id, ownerToken }),
      verificationRequired: newSession && host.policy?.verificationRequired === true });
    identity.manualPaused = storage.get(id).paused;
    return identity;
  }
  function initialize(id, ownerToken, { newSession = false } = {}) {
    if (!host) return;
    const state = storage.hostState(id);
    if (state) {
      // A lock from an earlier host policy must not strand a conversation
      // when verification is disabled, including demo-to-live adoption.
      if (state.identity?.verificationRequired === true && host.policy?.verificationRequired !== true) {
        identityTransition(id, ownerToken, { type: 'policy', origin: 'host', verificationRequired: false });
      }
      return;
    }
    // New/reset inherit the owner's guard, including a deliberate pause.
    if (ownerToken && storage.ownerCreditState(ownerToken)?.paused && !storage.get(id).paused) {
      publish(id, storage.pause(id, true, { ownerToken }));
    }
    emit(id, storage.transitionHost(id, () => {
      // Older conversations retain their admission policy when adopted by B1.
      const identity = initialIdentity(id, ownerToken, newSession);
      const handover = createHandover({ sessionId: id });
      return { state: { identity, handover }, events: [
        ...(identity ? [{ type: 'identity.state', data: identityView(identity, clock(identity)) }] : []),
        { type: 'handover.state', data: handoverView(handover) },
      ] };
    }, ownerToken ? { ownerToken } : {}));
  }
  function identityTransition(id, ownerToken, event) {
    return emit(id, storage.transitionHost(id, state => {
      const result = reduceIdentity(state.identity, { ...event, now: clock(state.identity) });
      return { ...result, state: { ...state, identity: result.state } };
    }, { ownerToken }));
  }
  function syncPause(id, ownerToken) {
    if (!host) return;
    initialize(id, ownerToken);
    const state = storage.hostState(id)?.identity;
    if (state && state.manualPaused !== storage.get(id).paused) {
      identityTransition(id, ownerToken, { type: 'pause', origin: 'manual', paused: storage.get(id).paused });
    }
    const paused = storage.get(id).paused, guard = storage.ownerCreditState(ownerToken);
    if (host.wallet && ownerToken && (guard ? guard.paused !== paused : paused)) emit(id, storage.transitionCredits(id, ownerToken,
      { type: 'pause', paused, now: now() }, host.credits));
  }
  function identityResult(id, extra = {}, ownerToken) {
    const state = storage.hostState(id)?.identity ?? initialIdentity(id, ownerToken);
    state.manualPaused = storage.get(id).paused;
    return { identity: identityView(state, clock(state)), ...extra };
  }
  function creditResult(id, ownerToken) {
    const balance = budgetCreditView(budget, id, host.wallet(ownerToken));
    const guard = storage.ownerCreditState(ownerToken);
    const state = guard ? guard.sessionId === id ? guard : rebindCredits(guard, id) : createCredits({ sessionId: id, ...host.credits });
    // Project live balances, expiry and pause without persisting read results.
    const current = reduceCredits(state, { type: 'balance', balance, now: clock(state) }).state;
    const projected = reduceCredits(current, { type: 'pause', paused: storage.get(id).paused, now: clock(current) }).state;
    return { balance, limitSlot: creditsView(projected, clock(projected)) };
  }
  function startCredits(id, ownerToken) {
    const balance = budgetCreditView(budget, id, host.wallet(ownerToken));
    emit(id, storage.transitionCredits(id, ownerToken, { type: 'balance', balance, now: now() }, host.credits));
    const result = emit(id, storage.transitionCredits(id, ownerToken, { type: 'start', now: now() }, host.credits));
    const paused = storage.get(id).paused;
    const current = result.state.paused === paused ? result : emit(id, storage.transitionCredits(id, ownerToken, { type: 'pause', paused, now: now() }));
    return { balance, limitSlot: creditsView(current.state, Math.max(now(), current.state.lastNow)) };
  }
  const library = ownerToken => assertLibraryPort(host.library(ownerToken, {
    create: options => createConversation(ownerToken, options),
    erase: id => eraseConversation(id, ownerToken), snapshot, publish,
  }));
  const handoverPort = ownerToken => assertHandoverPort(host.handover(ownerToken));
  function handoverTransition(id, ownerToken, event) {
    return emit(id, storage.transitionHost(id, state => {
      const result = reduceHandover(state.handover, event);
      return { ...result, state: { ...state, handover: result.state } };
    }, { ownerToken }));
  }
  async function deliver(id, ownerToken, type) {
    // Recheck even when joining an existing delivery. The host also retains its key.
    const session = storage.authorize(id, ownerToken);
    if (deliveries.has(id)) { await deliveries.get(id); storage.authorize(id, ownerToken); return; }
    if (type === 'retry' && storage.hostState(id).handover.revision === null) return;
    const port = handoverPort(ownerToken);
    if (type === 'request' && port.offer && (await callHost(options => port.offer({ sessionId: id, session }, options)))?.available !== true) return;
    storage.authorize(id, ownerToken);
    if (deliveries.has(id)) { await deliveries.get(id); storage.authorize(id, ownerToken); return; }
    const result = handoverTransition(id, ownerToken, { type,
      revision: type === 'retry' ? storage.hostState(id).handover.revision : inputRevision(storage.get(id)) });
    if (!result.delivery) return;
    const flight = (async () => {
      let response;
      try { response = await callHost(options => port.deliver(result.delivery, options)); }
      catch { response = { status: 'failed' }; }
      if (signal?.aborted) return; // preparing is recovered on restart with the same key
      storage.authorize(id, ownerToken);
      const valid = response?.status === 'sent' && typeof response.receiptId === 'string' && response.receiptId.length > 0 && response.receiptId.length <= 512;
      handoverTransition(id, ownerToken, { type: 'result', ...result.delivery,
        status: valid ? 'sent' : 'failed', ...(valid ? { receiptId: response.receiptId } : {}) });
    })().finally(() => { if (deliveries.get(id) === flight) deliveries.delete(id); });
    deliveries.set(id, flight); await flight;
  }
  async function handle(request) {
    const url = new URL(request.url);
    const sessionMatch = new RegExp(`^/api/sessions/(${idPattern})/(identity(?:/(?:request|resend|change|confirm|unlock))?|handover(?:/retry)?|credits|demo/outbox)$`, 'u').exec(url.pathname);
    const libraryMatch = new RegExp(`^/api/library(?:/(${idPattern})(?:/(rename|delete|reset))?)?$`, 'u').exec(url.pathname);
    if (!sessionMatch && !libraryMatch) return null;
    if (!host) return json({ error: 'host-unavailable' }, 503);
    try {
      const ownerToken = ownership.token(request);
      if (libraryMatch) {
        if (!ownerToken) return json({ error: 'owner-required' }, 401);
        const [, id, action] = libraryMatch;
        // Never consult an owner port or a dedup cache for a foreign ID.
        if (id) storage.authorize(id, ownerToken);
        if (!host.library) return json({ error: 'library-unavailable' }, 503);
        const port = library(ownerToken);
        if (!id && request.method === 'GET') {
          const page = await port.list({ search: url.searchParams.get('search') ?? '',
            offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20 });
          for (const item of page.items) storage.authorize(item.id, ownerToken);
          return json(page);
        }
        if (!id && request.method === 'POST') {
          const options = await body(request, ['title', 'locale', 'processingPreset', 'settings']);
          const entry = await port.new(options); storage.authorize(entry.id, ownerToken);
          return json({ ...entry, session: await snapshot(entry.id) }, 201);
        }
        if (id && !action && request.method === 'GET') {
          const entry = await port.open(id); storage.authorize(id, ownerToken);
          return json({ ...entry, session: await snapshot(id) });
        }
        if (action === 'rename' && request.method === 'POST') {
          const options = await body(request, ['title']);
          if (typeof options.title !== 'string' || options.title.length > 200) throw new TypeError('Invalid title');
          const result = await port.rename(id, options.title); storage.authorize(id, ownerToken); return json(result);
        }
        if ((action === 'delete' || action === 'reset') && request.method === 'POST') {
          await body(request, []);
          const result = await port[action](id);
          if (!storage.get(id).tombstone) throw new Error('Host erasure unconfirmed');
          if (action === 'delete') return json({ ...result, providerDeletion: 'not-confirmed' });
          storage.authorize(result.id, ownerToken);
          return json({ ...result, session: await snapshot(result.id), providerDeletion: 'not-confirmed' }, 201);
        }
        return json({ error: 'method-not-allowed' }, 405);
      }
      const [, id, action] = sessionMatch;
      storage.authorize(id, ownerToken);
      if (action === 'demo/outbox') {
        if (host.demo !== true || typeof host.outbox !== 'function') return json({ error: 'not-found' }, 404);
        if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
        const messages = await host.outbox({ sessionId: id, ownerToken }); storage.authorize(id, ownerToken);
        return json({ label: 'Demo only: fake mail outbox', messages });
      }
      // GETs must stay read-only even for conversations created before B1.
      if (action === 'identity' && request.method === 'GET') {
        if (!host.identity) return json({ error: 'identity-unavailable' }, 503);
        return json(identityResult(id, {}, ownerToken));
      }
      if (action === 'credits') {
        if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
        if (!host.wallet) return json({ error: 'credits-unavailable' }, 503);
        return json(creditResult(id, ownerToken));
      }
      initialize(id, ownerToken);
      if (action.startsWith('identity')) {
        if (!host.identity) return json({ error: 'identity-unavailable' }, 503);
        syncPause(id, ownerToken);
        if (request.method !== 'POST' || action === 'identity') return json({ error: 'method-not-allowed' }, 405);
        const command = action.slice('identity/'.length);
        const options = await body(request, ['request', 'change'].includes(command) ? ['address'] : command === 'confirm' ? ['token'] : []);
        if (command === 'confirm' && (typeof options.token !== 'string' || !options.token || options.token.length > 2048)) throw new TypeError('Invalid verification token');
        if (command === 'confirm' || command === 'unlock') {
          let state = storage.hostState(id).identity;
          if (state.status === 'verified') return json(identityResult(id));
          if (command === 'confirm') {
            // transitionHost reserves under BEGIN IMMEDIATE before any await.
            const attempt = identityTransition(id, ownerToken, { type: 'confirmation-attempt' });
            if (attempt.confirmationBlocked) return json(identityResult(id, { error: 'confirmation-rate-limit' }), 429);
            if (!attempt.confirmationAllowed) return json(identityResult(id));
            state = attempt.state.identity;
          }
          let evidence;
          try {
            evidence = await callHost(callOptions => host.identity.verify({ sessionId: id, ownerToken, address: state.address,
              revision: state.verificationRevision, ...(command === 'confirm' ? { token: options.token } : {}) }, callOptions));
          } catch (error) {
            if (signal?.aborted) return json({ error: 'server-stopping' }, 503);
            throw error;
          }
          if (signal?.aborted) return json({ error: 'server-stopping' }, 503);
          storage.authorize(id, ownerToken); syncPause(id, ownerToken);
          const result = identityTransition(id, ownerToken, { type: 'verification', verified: evidence?.verified === true,
            address: evidence?.address, revision: evidence?.revision });
          if (result.events.some(e => e.type === 'identity.unlocked')) unlocked(id);
          return json(identityResult(id));
        }
        let result = identityTransition(id, ownerToken, { type: command === 'request' ? 'request-verification' : command === 'change' ? 'change-address' : 'resend', address: options.address });
        // Change invalidates old links immediately, then requests under the same cooldown.
        if (command === 'change') result = identityTransition(id, ownerToken, { type: 'resend' });
        const blocked = result.resendBlocked;
        const effect = result.events.find(e => e.type === 'verification.requested');
        if (effect) {
          let delivery;
          try { delivery = await callHost(callOptions => host.identity.requestVerification({ sessionId: id, ownerToken, ...effect.data }, callOptions)); }
          catch { delivery = { status: 'failed' }; }
          if (signal?.aborted) return json({ error: 'server-stopping' }, 503);
          storage.authorize(id, ownerToken);
          identityTransition(id, ownerToken, { type: 'delivery', revision: effect.data.revision, address: effect.data.address,
            status: delivery?.status === 'sent' ? 'sent' : 'failed' });
        }
        return json(identityResult(id, blocked ? { error: 'resend-rate-limit' } : {}), blocked ? 429 : 200);
      }
      if (!host.handover) return json({ error: 'handover-unavailable' }, 503);
      if (action === 'handover' && request.method === 'GET') {
        const offer = await callHost(options => handoverPort(ownerToken).offer?.({ sessionId: id, session: storage.get(id) }, options));
        storage.authorize(id, ownerToken); return json({ handover: handoverView(storage.hostState(id).handover), offer: offer ?? null });
      }
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
      await body(request, []); await deliver(id, ownerToken, action.endsWith('/retry') ? 'retry' : 'request');
      return json({ handover: handoverView(storage.hostState(id).handover) });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof LibraryPortError && error.code === 'not-found') return json({ error: 'session-not-found' }, 404);
      if (error instanceof LibraryPortError) return json({ error: error.code }, 409);
      throw error;
    }
  }
  return { handle, initialize, syncPause,
    startCredits(id, ownerToken) { if (host?.wallet) return startCredits(id, ownerToken); },
    resume() {
      if (!host) return;
      for (const id of storage.list()) {
        if (storage.get(id).tombstone) continue;
        initialize(id);
        if (storage.hostState(id).handover.status === 'preparing') handoverTransition(id, undefined, { type: 'recover' });
      }
    },
    async idle() { await Promise.allSettled(deliveries.values()); },
  };
}
