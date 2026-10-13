import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IDENTITY_POLICY } from '@inspr/aithema-core';
import { formatCredits } from '../packages/ui/src/display.js';
import { canonicalEmail } from './email-address.js';

const DAY = 86_400_000;
const windows = { hour: 3_600_000, day: DAY };
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenShape = value => typeof value === 'string' && value.length <= 2048;
const requestId = token => tokenShape(token) ? token.split('.')[0] : '';
const memoryKeys = new WeakMap();

function hostKey(db, previousKey) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  // In-memory databases are explicit ephemeral fixtures/demo hosts only.
  if (!file) {
    if (!memoryKeys.has(db)) memoryKeys.set(db, previousKey ?? randomBytes(32));
    return memoryKeys.get(db);
  }
  const path = join(dirname(file), 'confirmation-hmac.key');
  let fd, temporary;
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const candidatePath = `${path}.${randomUUID()}.tmp`;
      fd = openSync(candidatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = candidatePath;
      const candidate = previousKey ?? randomBytes(32);
      if (candidate.length !== 32) throw new Error('Invalid migrated host secret');
      writeFileSync(fd, candidate); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      // Publish only complete, durable bytes. A competing creator wins without
      // being overwritten; all hosts then read the same persistent secret.
      try { linkSync(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      unlinkSync(temporary); temporary = undefined;
      fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('Invalid host secret');
    const invalidLength = () => Object.assign(new Error(
      'Confirmation host secret unavailable: confirmation-hmac.key has an invalid length (expected 32 bytes). ' +
      'Restore the original key from a backup; do not delete or regenerate it, which would reset mail quotas and invalidate CSRF proofs.'
    ), { code: 'CONFIRMATION_KEY_LENGTH' });
    if (info.size !== 32) throw invalidLength();
    if ((info.mode & 0o777) !== 0o600) throw new Error('Invalid host secret');
    const key = readFileSync(fd);
    if (key.length !== 32) throw invalidLength();
    return key;
  } catch (error) {
    if (error.code === 'CONFIRMATION_KEY_LENGTH') throw error;
    throw new Error('Confirmation host secret unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* A crash may leave an unpublished temporary file. */ } }
  }
}

/** Private host SQLite state. A request id is an attempt selector, never proof.
 * Only SHA-256 of the complete random bearer token is persisted. */
export function createConfirmationStore({ storage, visitorCredits, now }) {
  const db = storage.db, atomic = fn => db.isTransaction ? fn() : storage.transaction(fn);
  const previousKey = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visitor_mail_key'").get()
    ? db.prepare('SELECT key FROM visitor_mail_key WHERE id=1').get()?.key : undefined;
  // Created once beside the database, independently of credentials/public data.
  const key = hostKey(db, previousKey);
  const hmac = value => createHmac('sha256', key).update(value).digest('hex');
  // Abuse accounting conservatively merges local-part case variants while
  // delivery and identity evidence preserve the recipient's local-part case.
  const addressKey = address => hmac(`address\0${canonicalEmail(address).toLowerCase()}`);
  // Read compatibility for legacy slots whose original recipient is no longer
  // stored. Keep the original hash recipe for those legacy comparisons.
  const legacyAddressKey = address => hmac(`address\0${address.trim().normalize('NFKC').toLowerCase()}`);
  const legacySlotKey = digest => hmac(`legacy-address\0${digest}`);
  atomic(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS visitor_mail_abuse (address_key TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_mail_abuse_limit ON visitor_mail_abuse(address_key,created_at);
      CREATE INDEX IF NOT EXISTS visitor_mail_abuse_retention ON visitor_mail_abuse(created_at);
      CREATE TABLE IF NOT EXISTS visitor_mail_deliveries (
        request_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, visitor_ref TEXT NOT NULL REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')), locale TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_mail_visitor_limit ON visitor_mail_deliveries(visitor_ref,created_at);
      CREATE INDEX IF NOT EXISTS visitor_mail_retention ON visitor_mail_deliveries(created_at);`);
    // Upgrade draft C1 records once, preserving consumed slots and the secret.
    if (db.prepare('PRAGMA table_info(visitor_mail_deliveries)').all().some(column => column.name === 'address_key')) {
      for (const row of db.prepare(`SELECT d.address_key,d.created_at,v.address FROM visitor_mail_deliveries d
        JOIN visitor_identities v ON v.visitor_ref=d.visitor_ref`).all()) {
        let digest = legacySlotKey(row.address_key);
        try {
          // A visitor may have changed addresses since the delivery. Re-key
          // only when the remaining address proves which recipient was used.
          if (row.address && legacyAddressKey(row.address) === row.address_key) digest = addressKey(canonicalEmail(row.address));
        } catch { /* Preserve the consumed legacy slot. */ }
        db.prepare('INSERT INTO visitor_mail_abuse VALUES (?,?)').run(digest, row.created_at);
      }
      db.exec('DROP INDEX IF EXISTS visitor_mail_address_limit; ALTER TABLE visitor_mail_deliveries DROP COLUMN address_key;');
    }
    // Bootstrap once from C1's surviving reservations, including failed sends
    // and erased visitors. Only aggregate counts and timestamps cross over.
    const hasGlobalSlots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_mail_slots'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS host_mail_slots (
      created_at INTEGER PRIMARY KEY, count INTEGER NOT NULL CHECK(count>0));
      CREATE TABLE IF NOT EXISTS host_mail_cap_alerts (
      window TEXT PRIMARY KEY CHECK(window IN ('hour','day')), last_at INTEGER NOT NULL);`);
    if (!hasGlobalSlots) db.prepare(`INSERT INTO host_mail_slots
      SELECT created_at,COUNT(*) FROM visitor_mail_abuse WHERE created_at>? GROUP BY created_at`).run(now() - DAY);
    db.exec('DROP TABLE IF EXISTS visitor_mail_key;');
  });
  function mailCap(at = now()) {
    const policy = visitorCredits.settings();
    const counts = db.prepare(`SELECT COALESCE(SUM(CASE WHEN created_at>? THEN count ELSE 0 END),0) hour,
      COALESCE(SUM(count),0) day FROM host_mail_slots WHERE created_at>?`).get(at - windows.hour, at - DAY);
    return { revision: policy.revision, ...Object.fromEntries(Object.keys(windows).map(window => [window,
      { limit: policy.mailCap[window], count: counts[window], remaining: Math.max(0, policy.mailCap[window] - counts[window]) }])) };
  }
  function reserveGlobal(at, alerts) {
    const cap = mailCap(at); let suppressed = false;
    for (const [window, duration] of Object.entries(windows)) {
      const { count, limit } = cap[window];
      // Keep the durable claim when a slot frees: another suppression within
      // this rolling alert window must not log or audit a second time.
      if (count < limit) continue;
      suppressed = true;
      const previous = db.prepare('SELECT last_at FROM host_mail_cap_alerts WHERE window=?').get(window);
      if (!previous || at - previous.last_at >= duration) {
        db.prepare(`INSERT INTO host_mail_cap_alerts VALUES (?,?)
          ON CONFLICT(window) DO UPDATE SET last_at=excluded.last_at`).run(window, at);
        visitorCredits.auditMailCap({ window, count });
        alerts.push({ event: 'mail-cap', window, count });
      }
    }
    if (suppressed) return false;
    // This claim, the C1 checks and token creation share BEGIN IMMEDIATE. No
    // await or delivery can precede the durable slot; failures consume it.
    db.prepare(`INSERT INTO host_mail_slots VALUES (?,1)
      ON CONFLICT(created_at) DO UPDATE SET count=count+1`).run(at);
    return true;
  }
  const rowFor = token => db.prepare(`SELECT t.*,v.owner_hash,v.address,v.address_revision current_revision,v.identity_json,v.confirmed_at,d.status delivery_status,d.locale
    FROM visitor_confirmation_tokens t JOIN visitor_identities v ON v.visitor_ref=t.visitor_ref
    JOIN visitor_mail_deliveries d ON d.token_hash=t.token_hash WHERE d.request_id=?`).get(requestId(token));
  function stateFor(row, token) {
    if (!row || row.address_revision !== row.current_revision || !row.address || row.delivery_status !== 'sent') return 'invalid';
    const digest = /^[a-f0-9]{64}$/u.test(row.token_hash) ? Buffer.from(row.token_hash, 'hex') : null;
    const matches = tokenShape(token) && digest?.length === 32 && timingSafeEqual(Buffer.from(hash(token), 'hex'), digest);
    if (!matches) return 'invalid';
    if (row.redeemed_at !== null) return 'alreadyUsed';
    if (now() >= row.expires_at) return 'expired';
    if ((JSON.parse(row.identity_json).confirmationAttempts ?? 0) >= IDENTITY_POLICY.maxConfirmationAttempts) return 'tooManyAttempts';
    return 'valid';
  }
  function retryAt(row) {
    const at = now();
    const last = db.prepare('SELECT MAX(created_at) at FROM visitor_mail_deliveries WHERE visitor_ref=?').get(row.visitor_ref).at;
    const slots = db.prepare('SELECT created_at FROM visitor_mail_abuse WHERE address_key IN (?,?) AND created_at>? ORDER BY created_at DESC')
      .all(addressKey(row.address), legacySlotKey(legacyAddressKey(row.address)), at - DAY);
    return Math.max(at, last === null ? at : last + IDENTITY_POLICY.resendCooldownMs, slots.length >= 3 ? slots[2].created_at + DAY : at);
  }
  function describe(row, state, token) {
    const result = { state, ...(row ? { locale: row.locale } : {}) };
    // A request id or a failed proof must never reveal address, tier or shared quota.
    if (!row || stateFor(row, token) === 'invalid') return result;
    if (['valid', 'confirmed', 'alreadyUsed'].includes(state)) result.address = row.address;
    if (['valid', 'confirmed'].includes(state)) result.tier = formatCredits(visitorCredits.creditTiers(row.owner_hash).allowancesMicro.emailConfirmed, row.locale);
    if (state === 'alreadyUsed') result.addressConfirmed = row.confirmed_at !== null && JSON.parse(row.identity_json).status === 'verified';
    if (state === 'tooManyAttempts') result.retryAt = retryAt(row);
    return result;
  }
  const audit = (event, row, outcome) => visitorCredits.auditEvent(event, { visitorRef: row.visitor_ref, ...(outcome ? { outcome } : {}) });
  function redeem(token, { precounted = false, ownerHash, address, revision } = {}) {
    return atomic(() => {
      const row = rowFor(token), state = stateFor(row, token);
      if (!row || row.address_revision !== row.current_revision || !row.address || row.delivery_status !== 'sent') return { state: 'invalid' };
      if (ownerHash !== undefined && (row.owner_hash !== ownerHash || row.address !== address || row.address_revision !== revision)) return { state: 'invalid' };
      if (['alreadyUsed', 'expired'].includes(state)) return describe(row, state, token);
      const identity = JSON.parse(row.identity_json), attempts = identity.confirmationAttempts ?? 0;
      if (attempts >= IDENTITY_POLICY.maxConfirmationAttempts && !(precounted && attempts === IDENTITY_POLICY.maxConfirmationAttempts)) return describe(row, 'tooManyAttempts', token);
      if (!precounted) identity.confirmationAttempts = attempts + 1;
      // Persist the attempt and redemption in the same BEGIN IMMEDIATE as evidence.
      if (state === 'invalid') {
        visitorCredits.persistIdentity(row.owner_hash, identity); audit('confirmation.attempt', row, 'invalid');
        return { state: 'invalid', locale: row.locale };
      }
      if (!visitorCredits.verifyToken({ ownerHash: row.owner_hash, address: row.address, revision: row.address_revision, token })) return { state: 'invalid', locale: row.locale };
      visitorCredits.persistIdentity(row.owner_hash, { ...identity, status: 'verified', expiresAt: null, expired: false, lastNow: now() });
      audit('confirmation.redeemed', row, 'confirmed');
      return describe(row, 'confirmed', token);
    });
  }
  return {
    mailCap() { return atomic(() => mailCap()); },
    inspect(token) { const row = rowFor(token); return describe(row, stateFor(row, token), token); },
    redeem,
    reserve({ ownerHash, sessionId, address, revision, expiresAt, locale }) {
      const alerts = [];
      const result = atomic(() => {
        const row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
        if (!row || row.address !== address || row.address_revision !== revision) throw Object.assign(new Error('stale-verification'), { code: 'stale-verification' });
        const at = now(), digest = addressKey(address);
        const last = db.prepare('SELECT MAX(created_at) at FROM visitor_mail_deliveries WHERE visitor_ref=?').get(row.visitor_ref).at;
        const count = db.prepare('SELECT COUNT(*) n FROM visitor_mail_abuse WHERE address_key IN (?,?) AND created_at>?')
          .get(digest, legacySlotKey(legacyAddressKey(address)), at - DAY).n;
        if (last !== null && at - last < IDENTITY_POLICY.resendCooldownMs || count >= 3) return { status: 'rate-limited' };
        if (!reserveGlobal(at, alerts)) return { status: 'rate-limited' };
        const id = randomUUID(), token = `${id}.${randomBytes(32).toString('base64url')}`;
        // Never let a custom host policy issue links beyond the agreed TTL.
        expiresAt = Math.min(expiresAt, at + IDENTITY_POLICY.verificationTtlMs);
        visitorCredits.createToken({ ownerHash, sessionId, address, revision, expiresAt, token });
        db.prepare('INSERT INTO visitor_mail_abuse VALUES (?,?)').run(digest, at);
        db.prepare('INSERT INTO visitor_mail_deliveries VALUES (?,?,?,?,?,?)').run(id, hash(token), row.visitor_ref, at, 'sending', locale);
        audit('confirmation.delivery-requested', row);
        return { status: 'reserved', token, expiresAt };
      });
      for (const alert of alerts) console.warn(JSON.stringify(alert));
      return result;
    },
    delivered(token, status) {
      atomic(() => {
        const row = db.prepare('SELECT visitor_ref FROM visitor_mail_deliveries WHERE request_id=?').get(requestId(token));
        if (!row) return; // Erasure during a send must not recreate metadata.
        db.prepare('UPDATE visitor_mail_deliveries SET status=? WHERE request_id=?').run(status === 'sent' ? 'sent' : 'failed', requestId(token));
        audit('confirmation.delivery', row, status === 'sent' ? 'sent' : 'failed');
      });
    },
    csrf(cookie, token) { return hmac(`csrf\0${cookie}\0${hash(token)}`); },
    checkCsrf(cookie, token, proof) {
      if (!/^[a-f0-9]{48}$/u.test(cookie ?? '') || !/^[a-f0-9]{64}$/u.test(proof ?? '') || !tokenShape(token)) return false;
      return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(this.csrf(cookie, token), 'hex'));
    },
  };
}
