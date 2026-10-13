import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { IDENTITY_POLICY } from '@inspr/aithema-core';

const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenShape = value => typeof value === 'string' && value.length <= 2048;
const requestId = token => tokenShape(token) ? token.split('.')[0] : '';

/** Private host SQLite state. A request id is an attempt selector, never proof.
 * Only SHA-256 of the complete random bearer token is persisted. */
export function createConfirmationStore({ storage, visitorCredits, now }) {
  const db = storage.db, atomic = fn => db.isTransaction ? fn() : storage.transaction(fn);
  atomic(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS visitor_mail_key (id INTEGER PRIMARY KEY CHECK(id=1), key BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS visitor_mail_deliveries (
        request_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, visitor_ref TEXT NOT NULL REFERENCES visitor_identities(visitor_ref) ON DELETE CASCADE,
        address_key TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')), locale TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_mail_address_limit ON visitor_mail_deliveries(address_key,created_at);
      CREATE INDEX IF NOT EXISTS visitor_mail_visitor_limit ON visitor_mail_deliveries(visitor_ref,created_at);
      CREATE INDEX IF NOT EXISTS visitor_mail_retention ON visitor_mail_deliveries(created_at);`);
    if (!db.prepare('SELECT 1 FROM visitor_mail_key WHERE id=1').get()) db.prepare('INSERT INTO visitor_mail_key VALUES (1,?)').run(randomBytes(32));
  });
  // Host-private random key is independent of SMTP credentials, stable across restarts.
  const key = db.prepare('SELECT key FROM visitor_mail_key WHERE id=1').get().key;
  const hmac = value => createHmac('sha256', key).update(value).digest('hex');
  const rowFor = token => db.prepare(`SELECT t.*,v.owner_hash,v.address,v.address_revision current_revision,v.identity_json,d.status delivery_status,d.locale
    FROM visitor_confirmation_tokens t JOIN visitor_identities v ON v.visitor_ref=t.visitor_ref
    JOIN visitor_mail_deliveries d ON d.token_hash=t.token_hash WHERE d.request_id=?`).get(requestId(token));
  function stateFor(row, token) {
    if (!row || row.address_revision !== row.current_revision || !row.address || row.delivery_status !== 'sent') return 'invalid';
    const matches = tokenShape(token) && hash(token) === row.token_hash;
    if (!matches) return 'invalid';
    if (row.redeemed_at !== null) return 'alreadyUsed';
    if (now() >= row.expires_at) return 'expired';
    if ((JSON.parse(row.identity_json).confirmationAttempts ?? 0) >= IDENTITY_POLICY.maxConfirmationAttempts) return 'tooManyAttempts';
    return 'valid';
  }
  const audit = (event, row, outcome) => visitorCredits.auditEvent(event, { visitorRef: row.visitor_ref, ...(outcome ? { outcome } : {}) });
  function redeem(token, { precounted = false, ownerHash, address, revision } = {}) {
    return atomic(() => {
      const row = rowFor(token), state = stateFor(row, token);
      if (!row || row.address_revision !== row.current_revision || !row.address || row.delivery_status !== 'sent') return { state: 'invalid' };
      if (ownerHash !== undefined && (row.owner_hash !== ownerHash || row.address !== address || row.address_revision !== revision)) return { state: 'invalid' };
      if (['alreadyUsed', 'expired'].includes(state)) return { state, locale: row.locale };
      const identity = JSON.parse(row.identity_json), attempts = identity.confirmationAttempts ?? 0;
      if (attempts >= IDENTITY_POLICY.maxConfirmationAttempts && !(precounted && attempts === IDENTITY_POLICY.maxConfirmationAttempts)) return { state: 'tooManyAttempts', locale: row.locale };
      if (!precounted) identity.confirmationAttempts = attempts + 1;
      // Persist the attempt and redemption in the same BEGIN IMMEDIATE as evidence.
      if (state === 'invalid') {
        visitorCredits.persistIdentity(row.owner_hash, identity); audit('confirmation.attempt', row, 'invalid');
        return { state: 'invalid', locale: row.locale };
      }
      if (!visitorCredits.verifyToken({ ownerHash: row.owner_hash, address: row.address, revision: row.address_revision, token })) return { state: 'invalid', locale: row.locale };
      visitorCredits.persistIdentity(row.owner_hash, { ...identity, status: 'verified', expiresAt: null, expired: false, lastNow: now() });
      audit('confirmation.redeemed', row, 'confirmed');
      return { state: 'confirmed', locale: row.locale };
    });
  }
  return {
    inspect(token) { const row = rowFor(token); return { state: stateFor(row, token), ...(row ? { locale: row.locale } : {}) }; },
    redeem,
    reserve({ ownerHash, sessionId, address, revision, expiresAt, locale }) {
      return atomic(() => {
        const row = db.prepare('SELECT * FROM visitor_identities WHERE owner_hash=?').get(ownerHash);
        if (!row || row.address !== address || row.address_revision !== revision) throw Object.assign(new Error('stale-verification'), { code: 'stale-verification' });
        const at = now(), addressKey = hmac(`address\0${address.trim().normalize('NFKC').toLowerCase()}`);
        const last = db.prepare('SELECT MAX(created_at) at FROM visitor_mail_deliveries WHERE visitor_ref=?').get(row.visitor_ref).at;
        const count = db.prepare('SELECT COUNT(*) n FROM visitor_mail_deliveries WHERE address_key=? AND created_at>?').get(addressKey, at - DAY).n;
        if (last !== null && at - last < IDENTITY_POLICY.resendCooldownMs || count >= 3) return { status: 'rate-limited' };
        const id = randomUUID(), token = `${id}.${randomBytes(32).toString('base64url')}`;
        // Never let a custom host policy issue links beyond the agreed TTL.
        expiresAt = Math.min(expiresAt, at + IDENTITY_POLICY.verificationTtlMs);
        visitorCredits.createToken({ ownerHash, sessionId, address, revision, expiresAt, token });
        db.prepare('INSERT INTO visitor_mail_deliveries VALUES (?,?,?,?,?,?,?)').run(id, hash(token), row.visitor_ref, addressKey, at, 'sending', locale);
        audit('confirmation.delivery-requested', row);
        return { status: 'reserved', token, expiresAt };
      });
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
