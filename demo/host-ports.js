import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { LibraryPortError, createFakeHandoverHost, handoverKey } from '@inspr/aithema-core';

const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validTitle = title => typeof title === 'string' && title.length <= 200;

/** Demo only. Real hosts own reservation settlement and crash recovery. */
export function createDemoWallet({ limitMicro = 10_000_000, spent = () => 0 } = {}) {
  if (!integer(limitMicro)) throw new TypeError('Invalid demo wallet');
  const attempts = new Map();
  const balance = () => ({ limitMicro, committedMicro: spent() + [...attempts.values()].reduce((n, a) => n + (a.released ? 0 : a.maxMicro), 0) });
  const canAdmit = request => integer(request?.maxMicro) && request.maxMicro <= limitMicro - balance().committedMicro;
  return { balance, canAdmit,
    async admit(request) {
      if (typeof request?.attemptId !== 'string' || !request.attemptId || !integer(request.maxMicro) || !integer(request.maxVisitorMicro ?? 0)) throw new TypeError('Invalid wallet request');
      const fingerprint = JSON.stringify([request.sessionId, request.lane, request.maxMicro, request.maxVisitorMicro ?? 0, request.requestSha256, request.bindingSha256]);
      const previous = attempts.get(request.attemptId);
      if (previous) return previous.fingerprint === fingerprint ? { ok: true } : { ok: false, reason: 'attempt-conflict' };
      if (!canAdmit(request)) return { ok: false, reason: 'host-limit' };
      attempts.set(request.attemptId, { fingerprint, maxMicro: request.maxMicro, released: false });
      return { ok: true };
    },
    async release({ attemptId }) { const attempt = attempts.get(attemptId); if (attempt) attempt.released = true; },
  };
}

/** Labelled local host. Library content lives in the demo SQLite journal;
 * fake email and handover receipts are intentionally in memory. */
export function createDemoHost({ storage, demo = true, demoBypass = false, verificationRequired = false, now = () => Date.now(), identityPolicy,
  walletLimitMicro = 10_000_000, durationMs } = {}) {
  const mail = [], wallets = new Map(), sink = createFakeHandoverHost(), erasures = new Map(), resets = new Map();
  const authorize = (id, ownerToken) => {
    try { return storage.authorize(id, ownerToken); } catch { throw new LibraryPortError('not-found'); }
  };
  const metadata = session => {
    const createdAt = session.library?.createdAt ?? Date.parse(JSON.parse(storage.db.prepare('SELECT event FROM events WHERE session_id=? AND seq=1').get(session.id).event).at);
    return { id: session.id, title: session.library?.title ?? '', revision: session.library?.revision ?? 0,
      createdAt: session.library?.createdAt ?? createdAt, updatedAt: session.library?.updatedAt ?? createdAt };
  };
  const outbox = ({ sessionId, ownerToken }) => {
    storage.authorize(sessionId, ownerToken);
    return structuredClone(mail.filter(message => message.sessionId === sessionId));
  };
  const identity = {
    deliversVerification: demo,
    configuration() { return { demoBypass, ...(identityPolicy ? { policy: identityPolicy } : {}) }; },
    async requestVerification({ sessionId, ownerToken, address, revision, expiresAt }) {
      storage.authorize(sessionId, ownerToken);
      if (!demo) return { status: 'failed' };
      mail.push({ sessionId, address, revision, expiresAt, token: randomUUID(), verified: false });
      return { status: 'sent' };
    },
    async verify({ sessionId, ownerToken, address, revision, token }) {
      storage.authorize(sessionId, ownerToken);
      const message = mail.findLast(item => item.sessionId === sessionId && item.address === address && item.revision === revision);
      if (!demo || !message || now() >= message.expiresAt) return { verified: false };
      if (token !== undefined) {
        if (message.verified || typeof token !== 'string') return { verified: false };
        // Hash fixed-size digests so unequal token lengths do not short-circuit.
        const matches = timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(message.token).digest());
        if (!matches) return { verified: false };
        message.verified = true; message.token = null;
      }
      return { verified: message.verified, address: message.address, revision: message.revision };
    },
  };
  function library(ownerToken, hooks = {}) {
    const create = hooks.create ?? (options => storage.create({ ...options, ownerToken, demo }));
    const erase = hooks.erase ?? (id => { storage.erase(id, { ownerToken }); return { id, erased: true }; });
    const port = {
      async list({ search = '', offset = 0, limit = 20 } = {}) {
        if (typeof search !== 'string' || search.length > 200 || !integer(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid library page');
        const query = search.trim().toLowerCase();
        const entries = storage.ownedIds(ownerToken).filter(id => !erasures.has(id)).map(id => metadata(authorize(id, ownerToken)))
          .filter(entry => entry.title.toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        return { items: entries.slice(offset, offset + limit), total: entries.length, offset, limit };
      },
      async open(id) {
        const session = authorize(id, ownerToken);
        if (erasures.has(id)) throw new LibraryPortError('erasing');
        const { ownerHash, ...publicSession } = session;
        return { ...metadata(session), session: publicSession };
      },
      async rename(id, title) {
        const session = authorize(id, ownerToken);
        if (erasures.has(id)) throw new LibraryPortError('erasing');
        if (!validTitle(title)) throw new TypeError('Invalid title');
        const previous = metadata(session);
        if (previous.title === title.trim()) return previous;
        const next = { ...previous, title: title.trim(), revision: previous.revision + 1, updatedAt: now() };
        const event = storage.append(id, 'library.state', next); hooks.publish?.(id, event);
        return next;
      },
      async new({ title = '', ...options } = {}) {
        if (!validTitle(title)) throw new TypeError('Invalid title');
        const session = await create(options);
        if (title.trim()) await port.rename(session.id, title);
        return port.open(session.id);
      },
      async delete(id) {
        authorize(id, ownerToken); // ownership always precedes single-flight lookup
        if (erasures.has(id)) return erasures.get(id);
        const pending = Promise.resolve().then(async () => {
          const receipt = await erase(id);
          if (receipt?.erased !== true || !storage.get(id).tombstone) throw new LibraryPortError('erasure-unconfirmed');
          await host.erased({ sessionId: id, ownerToken });
          return { id, erased: true };
        }).finally(() => erasures.delete(id));
        erasures.set(id, pending); return pending;
      },
      async reset(id) {
        const session = authorize(id, ownerToken);
        if (resets.has(id)) return structuredClone(await resets.get(id));
        const pending = Promise.resolve().then(async () => {
          await port.delete(id);
          return port.new({ locale: session.locale, processingPreset: session.processingPreset });
        }).finally(() => resets.delete(id));
        resets.set(id, pending); return structuredClone(await pending);
      },
    };
    return port;
  }
  const host = { label: 'Demo only: local host ports', demo, now, identity, library,
    policy: { verificationRequired: demo && verificationRequired },
    ...(durationMs ? { credits: { durationMs } } : {}),
    outbox,
    async erased({ sessionId }) {
      for (let i = mail.length - 1; i >= 0; i--) if (mail[i].sessionId === sessionId) mail.splice(i, 1);
    },
    wallet(ownerToken) {
      const ownerHash = hash(ownerToken);
      if (!wallets.has(ownerHash)) wallets.set(ownerHash, createDemoWallet({ limitMicro: walletLimitMicro, spent: () => storage.db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN b.state='settled' THEN b.settled_micro ELSE b.max_micro END),0) AS n
        FROM budget_attempts b JOIN sessions s ON s.id=b.session_id WHERE json_extract(s.snapshot,'$.ownerHash')=?`).get(ownerHash).n }));
      return wallets.get(ownerHash);
    },
    handover(ownerToken) { return {
      async offer({ sessionId }) { storage.authorize(sessionId, ownerToken); return { available: demo, label: 'Demo only: fake handover sink' }; },
      async deliver(request, options) {
        storage.authorize(request.sessionId, ownerToken);
        if (!demo || request.idempotencyKey !== handoverKey(request.sessionId, request.revision)) throw new TypeError('Demo handover unavailable');
        return sink.port.deliver(request, options);
      },
    }; },
    // Independent local fixture controls for the destructive conformance kits.
    sink, wasErased: id => Boolean(storage.get(id).tombstone),
  };
  return host;
}
