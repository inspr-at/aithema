import { createHash, randomBytes } from 'node:crypto';
import { LibraryPortError, createFakeHandoverHost, handoverKey } from '@inspr/aithema-core';
import { SQLiteBudgetLedger } from '@inspr/aithema-server';
import { createVisitorCredits, EMAIL_NOTICE_VERSION } from './visitor-credits.js';
import { createConfirmationStore } from './confirmation-store.js';
import { privacyDocumentConfigured as hasPrivacyDocument } from '@inspr/aithema-server';
import { canonicalEmail } from './email-address.js';
import { createClientIpResolver } from './client-ip.js';

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
 * fake email and handover receipts are intentionally in memory.
 * demo:true is development only and explicitly exempts its fake-outbox identity
 * flow from the privacy gate. Non-demo hosts need a notice even with delivery. */
export function createDemoHost({ storage, demo = true, demoBypass = false, verificationRequired = false, now = () => Date.now(), identityPolicy,
  durationMs, ownerGuard = true, privacyDocumentConfigured, mailPlugin, clientIpHeader, visitorMicroPerMinute = () => 0 } = {}) {
  const clientIpBucket = createClientIpResolver({ header: clientIpHeader });
  if (!demo && mailPlugin && mailPlugin.id !== 'smtp') throw new TypeError('Production mail requires SMTP; mock transports are unavailable');
  const deliveryEnabled = demo || mailPlugin?.deliversVerification === true;
  const mail = [], wallets = new Map(), sink = createFakeHandoverHost(), erasures = new Map(), resets = new Map();
  const costs = new SQLiteBudgetLedger(storage);
  const visitorCredits = createVisitorCredits({ storage, now, deliveryEnabled, demo, privacyDocumentConfigured });
  const confirmation = createConfirmationStore({ storage, visitorCredits, now });
  storage.db.exec(`CREATE TABLE IF NOT EXISTS owner_wallet_reservations (
    attempt_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
    max_micro INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS wallet_owner ON owner_wallet_reservations(owner_hash);
    CREATE INDEX IF NOT EXISTS wallet_session ON owner_wallet_reservations(CASE WHEN json_valid(fingerprint) THEN json_extract(fingerprint,'$[0]') END);`);
  const walletForHash = ownerHash => {
    if (!wallets.has(ownerHash)) {
      visitorCredits.visitor(ownerHash);
      // admitCredits awaits the owner port before writing its ledger row.
      // That durable owner-only reservation is still a hold in either view.
      const unjournalledMicro = () => storage.db.prepare(`SELECT COALESCE(SUM(w.max_micro),0) n FROM owner_wallet_reservations w
        LEFT JOIN budget_attempts b ON b.attempt_id=w.attempt_id WHERE w.owner_hash=? AND w.released=0 AND b.attempt_id IS NULL`).get(ownerHash).n;
      const readBalance = () => {
        const { limitMicro } = visitorCredits.policy(ownerHash);
        const breakdown = costs.breakdown(undefined, { ownerHash, visitorCredits: true });
        // A wallet reservation and its ledger row are one operation, including after restart.
        breakdown.reservedMicro += unjournalledMicro();
        return { limitMicro, ...breakdown,
          committedMicro: breakdown.reservedMicro + breakdown.confirmedSpendMicro + breakdown.uncertainSpendMicro };
      };
      // Reuse extendVoice's BEGIN IMMEDIATE: no async gap between policy and its ledger update.
      const balance = () => storage.db.isTransaction ? readBalance() : storage.transaction(readBalance);
      // maxVisitorMicro is safely ignored only while visitor price equals upstream price.
      const canAdmit = request => {
        if (!integer(request?.maxMicro)) return false;
        const current = balance();
        return current.limitMicro > 0 && request.maxMicro <= current.limitMicro - current.committedMicro;
      };
      const displayBalance = () => {
        const { limitMicro } = visitorCredits.policy(ownerHash);
        const breakdown = costs.displayBreakdown(undefined, { ownerHash, now: now() });
        breakdown.pendingHoldMicro += unjournalledMicro();
        return { limitMicro, ...breakdown, committedMicro: breakdown.confirmedSpendMicro + breakdown.uncertainSpendMicro };
      };
      wallets.set(ownerHash, { balance, displayBalance, canAdmit,
        canAdmitWithoutReconcilingHold(request) {
          if (!integer(request?.maxMicro)) return false;
          const current = balance();
          return current.limitMicro > 0 && request.maxMicro <= current.limitMicro - current.committedMicro +
            costs.reconcilingVoiceHold(undefined, { ownerHash });
        },
        async admit(request) {
          if (typeof request?.attemptId !== 'string' || !request.attemptId || !integer(request.maxMicro) || !integer(request.maxVisitorMicro ?? 0)) throw new TypeError('Invalid wallet request');
          const fingerprint = JSON.stringify([request.sessionId, request.lane, request.maxMicro, request.maxVisitorMicro ?? 0, request.requestSha256, request.bindingSha256]);
          return storage.transaction(() => {
            // Only authenticated visitor actions touch inactivity, not recovery/accounting.
            const previous = storage.db.prepare('SELECT * FROM owner_wallet_reservations WHERE attempt_id=?').get(request.attemptId);
            if (previous) {
              if (previous.owner_hash !== ownerHash || previous.fingerprint !== fingerprint) return { ok: false, reason: 'attempt-conflict' };
              if (previous.released && !storage.db.prepare('SELECT 1 FROM budget_attempts WHERE attempt_id=?').get(request.attemptId)) {
                if (!canAdmit(request)) return { ok: false, reason: 'host-limit' };
                storage.db.prepare('UPDATE owner_wallet_reservations SET released=0 WHERE attempt_id=?').run(request.attemptId);
              }
              return { ok: true };
            }
            if (!canAdmit(request)) return { ok: false, reason: 'host-limit' };
            storage.db.prepare('INSERT INTO owner_wallet_reservations(attempt_id,owner_hash,fingerprint,max_micro) VALUES (?,?,?,?)')
              .run(request.attemptId, ownerHash, fingerprint, request.maxMicro);
            return { ok: true };
          });
        },
        async release({ attemptId }) {
          storage.db.prepare('UPDATE owner_wallet_reservations SET released=1 WHERE attempt_id=? AND owner_hash=?').run(attemptId, ownerHash);
        },
      });
    }
    return wallets.get(ownerHash);
  };
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
    return structuredClone(mail.filter(message => message.sessionId === sessionId).map(({ ownerHash, createdAt, ...message }) => message));
  };
  const identity = {
    clientIpBucket,
    deliversVerification: deliveryEnabled,
    asynchronousDelivery: mailPlugin?.deliversVerification === true,
    canonicalizeAddress: canonicalEmail,
    configuration() { return { demoBypass, ...(identityPolicy ? { policy: identityPolicy } : {}) }; },
    project({ session }, state) { return visitorCredits.projectIdentity(session.ownerHash, state); },
    persist({ session }, state) { const result = visitorCredits.persistIdentity(session.ownerHash, state); purgeMail(); return result; },
    async requestVerification({ sessionId, ownerToken, address, revision, expiresAt }, options) {
      const { clientIpBucket: ipBucket, ...deliveryOptions } = options ?? {};
      address = canonicalEmail(address);
      const session = storage.authorize(sessionId, ownerToken);
      if (mailPlugin?.deliversVerification) {
        // OPS policy can change on a running host. Skip tokens and every mail
        // cap reservation while disabled; the async HTTP response stays private.
        if (!visitorCredits.settings().confirmationEnabled) return { status: 'failed' };
        const locale = session.locale === 'de' ? 'de' : 'en';
        const reserved = confirmation.reserve({ ownerHash: session.ownerHash, sessionId, address, revision, expiresAt, locale, ipBucket });
        if (reserved.status === 'rate-limited') return reserved;
        try {
          const result = await mailPlugin.requestVerification({ sessionId, address, revision, ...reserved, locale,
            confirmedAllowanceMicro: visitorCredits.creditTiers(session.ownerHash).allowancesMicro.emailConfirmed,
            privacyDocumentConfigured: hasPrivacyDocument({ privacyDocumentConfigured }) }, deliveryOptions);
          confirmation.delivered(reserved.token, result?.status);
          return { status: result?.status === 'sent' ? 'sent' : 'failed' };
        } catch {
          confirmation.delivered(reserved.token, 'failed');
          return { status: 'failed' };
        }
      }
      if (!demo) return { status: 'failed' };
      const token = randomBytes(32).toString('base64url');
      visitorCredits.createToken({ ownerHash: session.ownerHash, sessionId, address, revision, expiresAt, token });
      for (let i = mail.length - 1; i >= 0; i--) if (mail[i].ownerHash === session.ownerHash) mail.splice(i, 1);
      mail.push({ sessionId, ownerHash: session.ownerHash, address, revision, expiresAt, token, verified: false, createdAt: now() });
      return { status: 'sent' };
    },
    async verify({ sessionId, ownerToken, address, revision, token }) {
      const session = storage.authorize(sessionId, ownerToken);
      if (mailPlugin?.deliversVerification) {
        const visitor = visitorCredits.visitor(session.ownerHash);
        if (visitor.address !== address || visitor.addressRevision !== revision) return { verified: false };
        const verified = token === undefined ? visitorCredits.verifyToken({ ownerHash: session.ownerHash, address, revision })
          : confirmation.redeem(token, { precounted: true, ownerHash: session.ownerHash, address, revision }).state === 'confirmed';
        return { verified, address, revision };
      }
      if (!demo) return { verified: false };
      const verified = visitorCredits.verifyToken({ ownerHash: session.ownerHash, address, revision, token });
      if (verified && token !== undefined) for (const message of mail) if (message.ownerHash === session.ownerHash && message.revision === revision) {
        message.verified = true; message.token = null;
      }
      return { verified, address, revision };
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
  const host = { label: 'Demo only: local host ports', demo, now, identity, library, privacyDocumentConfigured,
    policy: { verificationRequired: demo && verificationRequired },
    credits: { ownerGuard, ...(durationMs ? { durationMs } : {}) },
    visitorCredits, confirmation,
    emailNotice: { version: EMAIL_NOTICE_VERSION, optional: true, purpose: 'visitor-credit', inactivityDays: 90,
      marketingConsent: false, deliveryEnabled,
      text: { en: 'Saving an email is optional. It changes your visitor credit tier without resetting spend. We delete the address after 90 days without activity. Saving does not subscribe you to marketing.',
        de: 'Das Speichern einer E-Mail-Adresse ist freiwillig. Es ändert dein Besucherguthaben, ohne Ausgaben zurückzusetzen. Wir löschen die Adresse nach 90 Tagen ohne Aktivität. Das Speichern ist keine Anmeldung für Werbung.' } },
    visitor: ownerToken => visitorCredits.visitor(hash(ownerToken)),
    creditTiers: ownerToken => visitorCredits.creditTiers(hash(ownerToken)),
    visitorMicroPerMinute,
    claimEmailAsk: ownerToken => visitorCredits.claimEmailAsk(hash(ownerToken)),
    emailAskAfter: ownerToken => visitorCredits.emailAskAfter(hash(ownerToken)),
    lowEmailAsk: ownerToken => visitorCredits.lowEmailAsk(hash(ownerToken)),
    claimLowEmailAsk: ownerToken => visitorCredits.claimLowEmailAsk(hash(ownerToken)),
    rearmLowEmailAsk: ownerToken => visitorCredits.rearmLowEmailAsk(hash(ownerToken)),
    touchVisitor: session => visitorCredits.touch(session.ownerHash),
    saveEmail(ownerToken, input) { const result = visitorCredits.saveEmail(hash(ownerToken), input); purgeMail(); return result; },
    deleteEmail(ownerToken) { const result = visitorCredits.deleteEmail(hash(ownerToken)); purgeMail(); return result; },
    eraseVisitor(ownerToken) { visitorCredits.eraseVisitor(hash(ownerToken)); purgeMail(); },
    retainVisitors(options) { const result = visitorCredits.retain(options); purgeMail(); return result; },
    outbox,
    async retired({ sessionId }) {
      await host.erased({ sessionId });
      storage.transaction(() => {
        // The demo chooses to discard consent history with its session.
        for (const table of ['processing_consent_events', 'processing_consents']) {
          if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            storage.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
          }
        }
      });
    },
    async erased({ sessionId }) {
      sink.erased(sessionId);
      storage.transaction(() => {
        storage.db.prepare('DELETE FROM visitor_mail_deliveries WHERE token_hash IN (SELECT token_hash FROM visitor_confirmation_tokens WHERE session_id=?)').run(sessionId);
        storage.db.prepare('DELETE FROM visitor_confirmation_tokens WHERE session_id=?').run(sessionId);
        storage.db.prepare("DELETE FROM owner_wallet_reservations WHERE CASE WHEN json_valid(fingerprint) THEN json_extract(fingerprint,'$[0]') END=?").run(sessionId);
      });
      for (let i = mail.length - 1; i >= 0; i--) if (mail[i].sessionId === sessionId) mail.splice(i, 1);
    },
    wallet: ownerToken => walletForHash(hash(ownerToken)),
    walletForSession: session => walletForHash(session.ownerHash),
    recoverWallets() {
      // Startup's exclusive writer knows these admissions never reached a provider ledger.
      storage.db.prepare(`UPDATE owner_wallet_reservations SET released=1 WHERE released=0
        AND NOT EXISTS (SELECT 1 FROM budget_attempts b WHERE b.attempt_id=owner_wallet_reservations.attempt_id)`).run();
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
  function purgeMail() {
    for (let i = mail.length - 1; i >= 0; i--) {
      const message = mail[i], row = storage.db.prepare('SELECT address,address_revision FROM visitor_identities WHERE owner_hash=?').get(message.ownerHash);
      if (!row || row.address !== message.address || row.address_revision !== message.revision || now() - message.createdAt >= 24 * 60 * 60_000) mail.splice(i, 1);
    }
  }
  return host;
}
