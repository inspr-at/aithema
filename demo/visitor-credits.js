import { createHash, randomUUID } from 'node:crypto';
import { usdMicro } from '@inspr/aithema-server';
import { privacyDocumentConfigured as hasPrivacyDocument } from '@inspr/aithema-server';
import { canonicalEmail } from './email-address.js';
import { validateMailCap, MAIL_CAP_HOUR_CEILING, MAIL_CAP_DAY_CEILING } from './mail-cap-policy.js';

export const VISITOR_CREDIT_CEILING_MICRO = 1_000_000_000;
export const EMAIL_NOTICE_VERSION = 'ait-135-v1';
const DAY = 24 * 60 * 60_000;
const tiers = ['anonymous', 'emailGiven', 'emailConfirmed'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const hash = value => createHash('sha256').update(value).digest('hex');
const identityFields = ['status', 'address', 'verificationRevision', 'expiresAt', 'resendAt', 'expired', 'delivery', 'confirmationAttempts', 'lastNow'];
const clearedIdentity = revision => ({ status: 'guest', address: null, verificationRevision: revision, expiresAt: null,
  resendAt: 0, expired: false, delivery: 'idle', confirmationAttempts: 0, lastNow: 0 });
const fields = state => Object.fromEntries(identityFields.map(key => [key, state[key]]));

/** START-owned policy and evidence. Accounting remains keyed by the existing owner hash. */
export function createVisitorCredits({ storage, now = () => Date.now(), deliveryEnabled = false,
  ceilingMicro = VISITOR_CREDIT_CEILING_MICRO, demo = false, privacyDocumentConfigured } = {}) {
  if (!integer(ceilingMicro) || ceilingMicro < 10_000_000) throw new TypeError('Invalid visitor credit ceiling');
  const db = storage.db;
  const atomic = fn => db.isTransaction ? fn() : storage.transaction(fn);
  const timestamp = () => { const value = now(); if (!integer(value)) throw new TypeError('Invalid host time'); return value; };
  const settings = () => {
    const row = db.prepare('SELECT * FROM visitor_credit_settings WHERE id=1').get();
    if (!row || row.schema_version !== 1) throw new Error('Visitor credit settings unavailable');
    const allowancesMicro = { anonymous: row.anonymous_micro, emailGiven: row.email_given_micro, emailConfirmed: row.email_confirmed_micro };
    if (!tiers.every(tier => integer(allowancesMicro[tier])) || allowancesMicro.anonymous > allowancesMicro.emailGiven ||
      allowancesMicro.emailGiven > allowancesMicro.emailConfirmed) throw new Error('Invalid stored visitor credit settings');
    const mailCap = { hour: row.mail_cap_hour, day: row.mail_cap_day };
    if (!Object.values(mailCap).every(integer)) throw new Error('Invalid stored mail cap');
    const mailIpCap = { hour: row.mail_ip_cap_hour, day: row.mail_ip_cap_day };
    validateMailCap(mailIpCap);
    return { schemaVersion: row.schema_version, revision: row.revision, allowancesMicro, confirmationEnabled: row.confirmation_enabled === 1,
      mailCap, mailIpCap, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const insertAudit = (oldValues, newValues, { actor, source }, at) => db.prepare(`INSERT INTO visitor_credit_audit
    (actor,at,at_ms,source,revision,old_json,new_json) VALUES (?,?,?,?,?,?,?)`)
    .run(actor, new Date(at).toISOString(), at, source, newValues.revision, JSON.stringify(oldValues), JSON.stringify(newValues));
  storage.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS visitor_credit_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
      revision INTEGER NOT NULL CHECK(revision>=1), anonymous_micro INTEGER NOT NULL CHECK(anonymous_micro>=0),
      email_given_micro INTEGER NOT NULL CHECK(email_given_micro>=anonymous_micro),
      email_confirmed_micro INTEGER NOT NULL CHECK(email_confirmed_micro>=email_given_micro AND email_confirmed_micro<=1000000000),
      confirmation_enabled INTEGER NOT NULL CHECK(confirmation_enabled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visitor_credit_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
      source TEXT NOT NULL, revision INTEGER NOT NULL, old_json TEXT NOT NULL, new_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_audit_retention ON visitor_credit_audit(at_ms);
      CREATE TRIGGER IF NOT EXISTS visitor_audit_no_update BEFORE UPDATE ON visitor_credit_audit
      BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS visitor_identities (
      visitor_ref TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, address TEXT, address_revision INTEGER NOT NULL DEFAULT 0,
      saved_at INTEGER, confirmed_at INTEGER, pending_at INTEGER, notice_version TEXT, identity_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_address_retention ON visitor_identities(last_active_at) WHERE address IS NOT NULL;
      CREATE INDEX IF NOT EXISTS visitor_pending_retention ON visitor_identities(pending_at) WHERE pending_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS visitor_confirmation_tokens (
      token_hash TEXT PRIMARY KEY, visitor_ref TEXT NOT NULL REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
      session_id TEXT NOT NULL, address_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, redeemed_at INTEGER);
      CREATE INDEX IF NOT EXISTS visitor_token_session ON visitor_confirmation_tokens(session_id);
      CREATE INDEX IF NOT EXISTS visitor_token_retention ON visitor_confirmation_tokens(created_at);
      CREATE TABLE IF NOT EXISTS visitor_email_asks (
        visitor_ref TEXT PRIMARY KEY REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
        shown_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS visitor_low_email_asks (
        visitor_ref TEXT PRIMARY KEY REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
        shown_at INTEGER NOT NULL, armed INTEGER NOT NULL CHECK(armed IN (0,1)));
      CREATE TABLE IF NOT EXISTS visitor_identity_cleanup (owner_hash TEXT PRIMARY KEY, at TEXT NOT NULL);`);
    const columns = db.prepare('PRAGMA table_info(visitor_credit_settings)').all();
    const existing = db.prepare('SELECT 1 FROM visitor_credit_settings WHERE id=1').get();
    let migratedCap = false, migratedIpCap = false;
    for (const [name, fallback, ceiling] of [['mail_cap_hour', 30], ['mail_cap_day', 200],
      ['mail_ip_cap_hour', 5, MAIL_CAP_HOUR_CEILING], ['mail_ip_cap_day', 20, MAIL_CAP_DAY_CEILING]]) {
      if (!columns.some(column => column.name === name)) {
        db.exec(`ALTER TABLE visitor_credit_settings ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${fallback} CHECK(${name}>=0${ceiling ? ` AND ${name}<=${ceiling}` : ''})`);
        if (name.startsWith('mail_ip_')) migratedIpCap = true;
        else migratedCap = true;
      }
    }
    if (existing && (migratedCap || migratedIpCap)) {
      const before = settings(), at = timestamp();
      if (!integer(before.revision + 1)) throw new TypeError('Credit revision overflow');
      if (migratedCap) delete before.mailCap;
      if (migratedIpCap) delete before.mailIpCap;
      db.prepare('UPDATE visitor_credit_settings SET revision=revision+1,updated_at=? WHERE id=1').run(new Date(at).toISOString());
      insertAudit(before, settings(), { actor: 'system:migration', source: 'migration' }, at);
    }
    if (!db.prepare('SELECT 1 FROM visitor_credit_settings WHERE id=1').get()) {
      const at = timestamp(), iso = new Date(at).toISOString();
      db.prepare(`INSERT INTO visitor_credit_settings
        (id,schema_version,revision,anonymous_micro,email_given_micro,email_confirmed_micro,confirmation_enabled,created_at,updated_at)
        VALUES (1,1,1,10000000,10000000,10000000,0,?,?)`).run(iso, iso);
      insertAudit(null, settings(), { actor: 'system:migration', source: 'migration' }, at);
      // No allowance bootstrap and no changes to owner hashes, ledger rows or wallet holds.
      // Session creation and visitor turns prove activity. Expiry, recovery,
      // assistant replies and identity reducer clocks do not prove a visit.
      const owners = db.prepare(`SELECT json_extract(s.snapshot,'$.ownerHash') owner_hash,MAX(json_extract(e.event,'$.at')) last_at
        FROM sessions s LEFT JOIN events e ON e.session_id=s.id AND (
          json_extract(e.event,'$.type')='session.created' OR
          (json_extract(e.event,'$.type') IN ('turn.final','turn.corrected') AND json_extract(e.event,'$.data.role')='user'))
        WHERE json_extract(s.snapshot,'$.ownerHash') IS NOT NULL GROUP BY owner_hash`).all();
      for (const row of owners) ensure(row.owner_hash);
      // The capability must exist before this constructor runs. Without it,
      // leave legacy addresses in their original erasable store: no new copy,
      // saved/confirmed evidence or deferred backfill into the visitor profile.
      if (demo === true || hasPrivacyDocument({ privacyDocumentConfigured })) {
        for (const row of db.prepare(`SELECT h.record,json_extract(s.snapshot,'$.ownerHash') owner_hash
          FROM host_states h JOIN sessions s ON s.id=h.session_id ORDER BY json_extract(h.record,'$.identity.lastNow')`).all()) {
          const identity = JSON.parse(row.record).identity;
          if (identity?.address) persistIdentity(row.owner_hash, identity, { migration: true });
        }
      }
      for (const row of owners) {
        const lastActive = Math.min(at, Number.isFinite(Date.parse(row.last_at)) ? Date.parse(row.last_at) : 0);
        db.prepare('UPDATE visitor_identities SET last_active_at=? WHERE owner_hash=?').run(lastActive, row.owner_hash);
      }
    }
  });
  function ensure(ownerHash) {
    if (typeof ownerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(ownerHash)) throw new TypeError('Visitor owner required');
    let row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
    if (!row) {
      const at = timestamp();
      db.prepare(`INSERT INTO visitor_identities (visitor_ref,owner_hash,identity_json,created_at,updated_at,last_active_at) VALUES (?,?,?,?,?,?)`)
        .run(randomUUID(), ownerHash, JSON.stringify(clearedIdentity(0)), at, at, at);
      row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
    }
    return row;
  }
  function policy(ownerHash) {
    const current = settings(), row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
    const tier = row?.address && row.confirmed_at !== null && current.confirmationEnabled && deliveryEnabled ? 'emailConfirmed'
      : row?.address && row.saved_at !== null ? 'emailGiven' : 'anonymous';
    return { tier, limitMicro: Math.min(ceilingMicro, current.allowancesMicro[tier]), revision: current.revision };
  }
  function visitor(ownerHash) {
    const row = ensure(ownerHash);
    return { visitorRef: row.visitor_ref, address: row.address, addressRevision: row.address_revision,
      ...policy(ownerHash), noticeVersion: row.notice_version };
  }
  function touch(ownerHash) {
    const row = ensure(ownerHash);
    db.prepare('UPDATE visitor_identities SET last_active_at=MAX(last_active_at,?) WHERE visitor_ref=?').run(timestamp(), row.visitor_ref);
  }
  function projectIdentity(ownerHash, state) {
    const row = db.prepare('SELECT address,identity_json FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
    // Pending cleanup stores only cleared, address-free verification state.
    // The independent address column supplies an in-memory projection.
    const identity = row ? { ...JSON.parse(row.identity_json), address: row.address } : clearedIdentity((state?.verificationRevision ?? 0) + 1);
    return { ...state, ...identity,
      // Session pauses and lock policy stay in the conversation; evidence is visitor-wide.
      lastNow: Math.max(state?.lastNow ?? 0, identity.lastNow ?? 0) };
  }
  function persistIdentity(ownerHash, state, { migration = false } = {}) {
    if (state.address !== null) state = { ...state, address: canonicalEmail(state.address) };
    const row = ensure(ownerHash), at = migration && integer(state.lastNow) ? Math.min(timestamp(), state.lastNow) : timestamp();
    const changed = row.address !== state.address;
    const erased = changed && row.address !== null && !migration;
    if (erased) drainOwnerProjections(ownerHash);
    const confirmed = state.status === 'verified';
    db.prepare(`UPDATE visitor_identities SET address=?,address_revision=?,saved_at=?,confirmed_at=?,pending_at=?,
      identity_json=?,updated_at=? WHERE visitor_ref=?`)
      .run(state.address, state.verificationRevision, confirmed ? row.saved_at ?? at : row.saved_at,
        confirmed ? changed ? at : row.confirmed_at ?? at : null,
        state.status === 'verification-pending' ? state.verificationRevision !== row.address_revision ? at : row.pending_at ?? at : null,
        JSON.stringify(fields(state)), at, row.visitor_ref);
    if (changed) db.prepare('DELETE FROM visitor_confirmation_tokens WHERE visitor_ref=?').run(row.visitor_ref);
    if (confirmed) resolveLowLines(ownerHash, 'confirm');
    return { erased };
  }
  function resolveLowLines(ownerHash, kind) {
    for (const row of db.prepare(`SELECT h.session_id,h.record FROM host_states h JOIN sessions s ON s.id=h.session_id
      WHERE json_extract(s.snapshot,'$.ownerHash')=? AND json_extract(h.record,'$.emailAsk.lowLine.kind')=?
      AND COALESCE(json_extract(h.record,'$.emailAsk.lowLine.resolved'),0)=0`).all(ownerHash, kind)) {
      // saveEmail / identityTransition already own the writer transaction.
      const state = JSON.parse(row.record);
      state.emailAsk = { ...state.emailAsk, revision: (state.emailAsk.revision ?? 0) + 1,
        lowLine: { ...state.emailAsk.lowLine, resolved: true } };
      db.prepare('UPDATE host_states SET record=? WHERE session_id=?').run(JSON.stringify(state), row.session_id);
    }
  }
  const queueCleanup = ownerHash => db.prepare('INSERT OR REPLACE INTO visitor_identity_cleanup VALUES (?,?)').run(ownerHash, new Date(timestamp()).toISOString());
  function clearAddress(ownerHash) {
    const row = ensure(ownerHash), at = timestamp();
    db.prepare(`UPDATE visitor_identities SET address=NULL,address_revision=address_revision+1,saved_at=NULL,confirmed_at=NULL,pending_at=NULL,
      notice_version=NULL,identity_json=?,updated_at=? WHERE visitor_ref=?`)
      .run(JSON.stringify(clearedIdentity(row.address_revision + 1)), at, row.visitor_ref);
    db.prepare('DELETE FROM visitor_confirmation_tokens WHERE visitor_ref=?').run(row.visitor_ref);
    queueCleanup(ownerHash);
  }
  function cleanupProjections(limit) {
    let count = 0;
    for (const row of db.prepare('SELECT * FROM visitor_identity_cleanup LIMIT ?').all(limit)) {
      const result = storage.eraseIdentityProjections(row.owner_hash, { limit: limit - count, at: row.at });
      count += result.count;
      if (result.done) db.prepare('DELETE FROM visitor_identity_cleanup WHERE owner_hash=?').run(row.owner_hash);
      if (count >= limit) break;
    }
    return count;
  }
  function drainOwnerProjections(ownerHash) {
    queueCleanup(ownerHash);
    let done = false;
    while (!done) done = storage.eraseIdentityProjections(ownerHash, { limit: 100, at: new Date(timestamp()).toISOString() }).done;
    db.prepare('DELETE FROM visitor_identity_cleanup WHERE owner_hash=?').run(ownerHash);
  }
  return { settings, policy, visitor, touch, projectIdentity, persistIdentity,
    lowEmailAsk(ownerHash) {
      const row = db.prepare(`SELECT shown_at,armed FROM visitor_low_email_asks a
        JOIN visitor_identities v USING(visitor_ref) WHERE v.owner_hash=?`).get(ownerHash);
      return { after: row ? row.shown_at + DAY : 0, armed: !row || row.armed === 1 };
    },
    // Cooldown and the balance latch are visitor-wide. A high balance only
    // re-arms the latch; it never shortens the rolling 24-hour cooldown.
    rearmLowEmailAsk(ownerHash) {
      return atomic(() => db.prepare(`UPDATE visitor_low_email_asks SET armed=1
        WHERE visitor_ref=(SELECT visitor_ref FROM visitor_identities WHERE owner_hash=?) AND armed=0`).run(ownerHash).changes === 1);
    },
    claimLowEmailAsk(ownerHash) {
      return atomic(() => {
        const row = ensure(ownerHash), at = timestamp();
        return db.prepare(`INSERT INTO visitor_low_email_asks VALUES (?,?,0)
          ON CONFLICT(visitor_ref) DO UPDATE SET shown_at=excluded.shown_at,armed=0
          WHERE visitor_low_email_asks.armed=1 AND visitor_low_email_asks.shown_at<=excluded.shown_at-?`)
          .run(row.visitor_ref, at, DAY).changes === 1;
      });
    },
    emailAskAfter(ownerHash) {
      const row = db.prepare(`SELECT shown_at FROM visitor_email_asks a JOIN visitor_identities v USING(visitor_ref) WHERE v.owner_hash=?`).get(ownerHash);
      return row ? row.shown_at + DAY : 0;
    },
    // One rolling day per visitor, shared by all conversations and tabs. The
    // surrounding host transaction commits this claim with the gate record.
    claimEmailAsk(ownerHash) {
      return atomic(() => {
        const row = ensure(ownerHash), at = timestamp();
        return db.prepare(`INSERT INTO visitor_email_asks VALUES (?,?)
          ON CONFLICT(visitor_ref) DO UPDATE SET shown_at=excluded.shown_at
          WHERE visitor_email_asks.shown_at<=excluded.shown_at-?`).run(row.visitor_ref, at, DAY).changes === 1;
      });
    },
    auditEvent(event, evidence) {
      // Mail evidence is deliberately address/token-free; callers supply only
      // an opaque visitor reference, outcome and event name.
      if (!['confirmation.delivery-requested', 'confirmation.delivery', 'confirmation.attempt', 'confirmation.redeemed'].includes(event) ||
        !object(evidence, ['visitorRef', 'outcome'])) throw new TypeError('Invalid mail audit event');
      const current = settings();
      insertAudit(null, { revision: current.revision, event, ...evidence }, { actor: 'system:mail', source: 'confirmation-mail' }, timestamp());
    },
    auditMailCap({ window, count }) {
      if (!['hour', 'day'].includes(window) || !integer(count)) throw new TypeError('Invalid mail cap audit');
      insertAudit(null, { revision: settings().revision, event: 'mail-cap', window, count },
        { actor: 'system:mail', source: 'confirmation-mail' }, timestamp());
    },
    creditTiers(ownerHash) {
      const { allowancesMicro, confirmationEnabled } = settings(), current = policy(ownerHash).tier;
      const canConfirm = confirmationEnabled && deliveryEnabled;
      const candidate = current === 'anonymous' ? 'emailGiven' : current === 'emailGiven' && canConfirm ? 'emailConfirmed' : null;
      const next = candidate && allowancesMicro[candidate] > allowancesMicro[current] ? candidate : null;
      return { current, next, delta: next ? allowancesMicro[next] - allowancesMicro[current] : 0, canConfirm, allowancesMicro };
    },
    saveSettings(input, { actor = 'system:host', source = 'host' } = {}) {
      if (!object(input, ['baseRevision', 'allowancesUsd', 'confirmationEnabled', 'mailCap', 'mailIpCap']) || !integer(input.baseRevision) || !input.baseRevision ||
        input.allowancesUsd === undefined && input.confirmationEnabled === undefined && input.mailCap === undefined && input.mailIpCap === undefined ||
        typeof actor !== 'string' || !actor || actor.length > (source === 'operator' ? 500 : 200) || typeof source !== 'string' || !source || source.length > 100) throw new TypeError('Invalid credit settings');
      const privileged = source === 'ops-cli' && actor.startsWith('ops-cli:') ||
        source === 'operator' && /^operator:[^\x00-\x1f\x7f-\x9f]{1,120}#[^\x00-\x1f\x7f-\x9f]+$/u.test(actor);
      let allowancesMicro;
      if (input.allowancesUsd !== undefined) {
        if (!object(input.allowancesUsd, tiers) || !tiers.every(tier => Object.hasOwn(input.allowancesUsd, tier))) throw new TypeError('Invalid allowances');
        allowancesMicro = Object.fromEntries(tiers.map(tier => [tier, usdMicro(input.allowancesUsd[tier])]));
        if (tiers.some(tier => allowancesMicro[tier] > ceilingMicro) || allowancesMicro.anonymous > allowancesMicro.emailGiven ||
          allowancesMicro.emailGiven > allowancesMicro.emailConfirmed) throw new TypeError('Invalid allowances');
      }
      if (input.confirmationEnabled !== undefined && (typeof input.confirmationEnabled !== 'boolean' || input.confirmationEnabled && !deliveryEnabled)) {
        throw new TypeError('Confirmation requires qualified delivery');
      }
      if (input.confirmationEnabled !== undefined && demo !== true && !privileged) {
        throw new TypeError('Confirmation policy requires the OPS CLI');
      }
      if (input.mailCap !== undefined) {
        if (!object(input.mailCap, ['hour', 'day'])) {
          throw new TypeError('Invalid mail cap');
        }
        validateMailCap(input.mailCap);
        if (!privileged) throw new TypeError('Mail cap requires the OPS CLI');
      }
      if (input.mailIpCap !== undefined) {
        if (!object(input.mailIpCap, ['hour', 'day'])) throw new TypeError('Invalid IP mail cap');
        validateMailCap(input.mailIpCap);
        if (!privileged) throw new TypeError('IP mail cap requires the OPS CLI');
      }
      return storage.transaction(() => {
        const before = settings();
        if (input.baseRevision !== before.revision) throw Object.assign(new Error('stale-credit-settings'), { status: 409, current: before });
        if (!integer(before.revision + 1)) throw new TypeError('Credit revision overflow');
        const amounts = allowancesMicro ?? before.allowancesMicro, mailCap = input.mailCap ?? before.mailCap,
          mailIpCap = input.mailIpCap ?? before.mailIpCap, at = timestamp();
        db.prepare(`UPDATE visitor_credit_settings SET revision=revision+1,anonymous_micro=?,email_given_micro=?,email_confirmed_micro=?,
          confirmation_enabled=?,mail_cap_hour=?,mail_cap_day=?,mail_ip_cap_hour=?,mail_ip_cap_day=?,updated_at=? WHERE id=1`).run(...tiers.map(tier => amounts[tier]),
          Number(input.confirmationEnabled ?? before.confirmationEnabled), mailCap.hour, mailCap.day, mailIpCap.hour, mailIpCap.day, new Date(at).toISOString());
        const after = settings(); insertAudit(before, after, { actor, source }, at); return after;
      });
    },
    adminAudit({ before } = {}) {
      if (before !== undefined && (!integer(before) || !before)) throw new TypeError('Invalid audit page');
      const rows = db.prepare(`SELECT * FROM visitor_credit_audit
        WHERE id<? AND COALESCE(json_extract(new_json,'$.event'),'') NOT GLOB 'confirmation.*'
        ORDER BY id DESC LIMIT 21`).all(before ?? Number.MAX_SAFE_INTEGER);
      const items = rows.slice(0, 20).map(row => ({ id: row.id, actor: row.actor, at: row.at, source: row.source,
        revision: row.revision, oldValues: JSON.parse(row.old_json), newValues: JSON.parse(row.new_json) }));
      return { items, nextBefore: rows.length > 20 ? items.at(-1).id : null };
    },
    audit({ after = 0, limit = 100 } = {}) {
      if (!integer(after) || !integer(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid audit page');
      return db.prepare('SELECT * FROM visitor_credit_audit WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
        .map(row => ({ id: row.id, actor: row.actor, at: row.at, source: row.source, revision: row.revision,
          oldValues: JSON.parse(row.old_json), newValues: JSON.parse(row.new_json) }));
    },
    saveEmail(ownerHash, input) {
      if (!object(input, ['address', 'noticeVersion']) || input.noticeVersion !== EMAIL_NOTICE_VERSION) throw new TypeError('Invalid saved email or privacy notice');
      input = { ...input, address: canonicalEmail(input.address) };
      const result = storage.transaction(() => {
        const row = ensure(ownerHash), at = timestamp(), changed = row.address !== input.address;
        const identity = changed ? { ...clearedIdentity(row.address_revision + 1), address: input.address } : JSON.parse(row.identity_json);
        if (changed) { db.prepare('DELETE FROM visitor_confirmation_tokens WHERE visitor_ref=?').run(row.visitor_ref); drainOwnerProjections(ownerHash); }
        db.prepare(`UPDATE visitor_identities SET address=?,address_revision=?,saved_at=COALESCE(saved_at,?),confirmed_at=?,
          pending_at=?,notice_version=?,identity_json=?,updated_at=? WHERE visitor_ref=?`)
          .run(input.address, identity.verificationRevision, at, changed ? null : row.confirmed_at, changed ? null : row.pending_at,
            input.noticeVersion, JSON.stringify(identity), at, row.visitor_ref);
        resolveLowLines(ownerHash, 'give');
        return visitor(ownerHash);
      });
      storage.checkpointErasure(); return result;
    },
    deleteEmail(ownerHash) {
      storage.transaction(() => { clearAddress(ownerHash); drainOwnerProjections(ownerHash); });
      storage.checkpointErasure(); return visitor(ownerHash);
    },
    createToken({ ownerHash, sessionId, address, revision, expiresAt, token }) {
      atomic(() => {
        // Validate in the token transaction without creating/restoring identity:
        // a queued effect can outlive address replacement or visitor erasure.
        const row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
        if (!row || row.address !== address || row.address_revision !== revision) {
          throw Object.assign(new Error('stale-verification'), { code: 'stale-verification' });
        }
        const at = timestamp();
        db.prepare('DELETE FROM visitor_confirmation_tokens WHERE visitor_ref=?').run(row.visitor_ref);
        db.prepare('INSERT INTO visitor_confirmation_tokens VALUES (?,?,?,?,?,?,NULL)').run(hash(token), row.visitor_ref, sessionId, revision, expiresAt, at);
      });
    },
    verifyToken({ ownerHash, address, revision, token }) {
      return atomic(() => {
        const row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
        if (!row || row.address !== address || row.address_revision !== revision) return false;
        if (token === undefined) return Boolean(db.prepare(`SELECT 1 FROM visitor_confirmation_tokens WHERE visitor_ref=?
          AND address_revision=? AND redeemed_at IS NOT NULL`).get(row.visitor_ref, revision));
        if (typeof token !== 'string') return false;
        return db.prepare(`UPDATE visitor_confirmation_tokens SET redeemed_at=? WHERE token_hash=? AND visitor_ref=?
          AND address_revision=? AND redeemed_at IS NULL AND expires_at>?`).run(timestamp(), hash(token), row.visitor_ref, revision, timestamp()).changes === 1;
      });
    },
    eraseVisitor(ownerHash) {
      storage.transaction(() => {
        // Explicit erasure drains the bounded projection job before acknowledgement.
        drainOwnerProjections(ownerHash);
        const row = db.prepare('SELECT visitor_ref FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
        if (row) db.prepare("DELETE FROM visitor_credit_audit WHERE source='confirmation-mail' AND json_extract(new_json,'$.visitorRef')=?").run(row.visitor_ref);
        db.prepare('DELETE FROM visitor_identities WHERE owner_hash=?').run(ownerHash);
      });
      storage.checkpointErasure();
    },
    retain({ limit = 100 } = {}) {
      if (!integer(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid retention batch');
      const result = storage.transaction(() => {
        const at = timestamp(); let addresses = 0;
        for (const row of db.prepare('SELECT owner_hash FROM visitor_identities WHERE address IS NOT NULL AND last_active_at<=? LIMIT ?').all(at - 90 * DAY, limit)) {
          clearAddress(row.owner_hash); addresses++;
        }
        const pendingRows = db.prepare('SELECT visitor_ref,owner_hash,address_revision,saved_at FROM visitor_identities WHERE pending_at<=? LIMIT ?').all(at - DAY, limit);
        let pendingTokens = 0;
        for (const row of pendingRows) {
          if (row.saved_at === null) clearAddress(row.owner_hash);
          else {
            // Retain the saved address column without reading or writing it.
            // Expiry removes pending state/tokens; a read can project the saved
            // address, while any later address-bearing write uses the funnel.
            db.prepare('UPDATE visitor_identities SET pending_at=NULL,address_revision=address_revision+1,identity_json=? WHERE visitor_ref=?')
              .run(JSON.stringify(clearedIdentity(row.address_revision + 1)), row.visitor_ref);
            pendingTokens += db.prepare('DELETE FROM visitor_confirmation_tokens WHERE visitor_ref=?').run(row.visitor_ref).changes;
            queueCleanup(row.owner_hash);
          }
        }
        const tokens = pendingTokens + db.prepare('DELETE FROM visitor_confirmation_tokens WHERE token_hash IN (SELECT token_hash FROM visitor_confirmation_tokens WHERE created_at<=? LIMIT ?)').run(at - DAY, limit).changes;
        // Delivery records erase with visitors; abuse records have no visitor
        // relationship and expire independently after the rolling 24h window.
        const deliveries = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visitor_mail_deliveries'").get()
          ? db.prepare('DELETE FROM visitor_mail_deliveries WHERE request_id IN (SELECT request_id FROM visitor_mail_deliveries WHERE created_at<=? LIMIT ?)').run(at - DAY, limit).changes : 0;
        const abuse = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visitor_mail_abuse'").get()
          ? db.prepare('DELETE FROM visitor_mail_abuse WHERE rowid IN (SELECT rowid FROM visitor_mail_abuse WHERE created_at<=? LIMIT ?)').run(at - DAY, limit).changes : 0;
        const mailSlots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_mail_slots'").get()
          ? db.prepare('DELETE FROM host_mail_slots WHERE created_at IN (SELECT created_at FROM host_mail_slots WHERE created_at<=? LIMIT ?)').run(at - DAY, limit).changes : 0;
        let ipRows = 0;
        for (const [table, timestampColumn] of [['host_mail_ip_slots', 'created_at'], ['host_mail_ip_alerts', 'last_at']]) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            ipRows += db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${timestampColumn}<=? LIMIT ?)`).run(at - DAY, limit).changes;
          }
        }
        const audit = db.prepare('DELETE FROM visitor_credit_audit WHERE id IN (SELECT id FROM visitor_credit_audit WHERE at_ms<=? LIMIT ?)').run(at - 180 * DAY, limit).changes;
        return { addresses, pending: pendingRows.length + tokens + deliveries + abuse + mailSlots + ipRows, audit, projections: cleanupProjections(limit) };
      });
      if (result.addresses || result.pending || result.projections) storage.checkpointErasure();
      return result;
    },
  };
}
