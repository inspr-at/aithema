// Executable host-owned integration. Every module dependency is a public export.
import { createHash } from 'node:crypto';
import { admitCredits } from '@inspr/aithema-core';
import { SQLiteStorage, SQLiteBudgetLedger, createHandlers, createOperatorSessions,
  createSQLiteOperatorStore, createPluginRuntime } from '@inspr/aithema-server';

export const tierNames = ['anonymous', 'emailGiven', 'emailConfirmed'];
export const ceilingMicro = 1_000_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function validateAllowances(value) {
  if (!exact(value, tierNames) || tierNames.some(tier => !integer(value[tier]) || value[tier] > ceilingMicro) ||
      value.anonymous > value.emailGiven || value.emailGiven > value.emailConfirmed) throw new TypeError('Invalid allowances');
  return value;
}

export function createVisitorTierHost({ path = ':memory:', operatorProvider, publicOrigin = 'https://host.example.test',
  now = Date.now, canConfirm = false, privacyDocumentConfigured = () => false } = {}) {
  const storage = new SQLiteStorage(path), db = storage.db;
  const budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: ceilingMicro, visitorCapMicro: ceilingMicro, now });
  // No module table is read or written directly. Host migrations own this schema.
  storage.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS host_tier_settings (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_tier_audit (revision INTEGER PRIMARY KEY, at TEXT NOT NULL,
        actor_json TEXT NOT NULL, old_json TEXT NOT NULL, new_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS host_tier_audit_no_update BEFORE UPDATE ON host_tier_audit
        BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS host_tier_audit_no_delete BEFORE DELETE ON host_tier_audit
        BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TABLE IF NOT EXISTS host_visitor_tiers (owner_hash TEXT PRIMARY KEY, tier TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_tier_holds (attempt_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL, max_micro INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS host_tier_holds_owner ON host_tier_holds(owner_hash);`);
    db.prepare('INSERT OR IGNORE INTO host_tier_settings VALUES (1,?)').run(JSON.stringify({ revision: 1,
      allowancesMicro: { anonymous: 10_000_000, emailGiven: 15_000_000, emailConfirmed: 20_000_000 } }));
  });
  const atomic = fn => db.isTransaction ? fn() : storage.transaction(fn);
  function settings() {
    const record = JSON.parse(db.prepare('SELECT record FROM host_tier_settings WHERE id=1').get().record);
    if (!integer(record.revision) || !record.revision) throw new TypeError('Invalid stored revision');
    validateAllowances(record.allowancesMicro); return record;
  }
  const currentTier = ownerHash => {
    const tier = db.prepare('SELECT tier FROM host_visitor_tiers WHERE owner_hash=?').get(ownerHash)?.tier ?? 'anonymous';
    if (!tierNames.includes(tier)) throw new TypeError('Invalid stored tier');
    return tier === 'emailConfirmed' && !canConfirm ? 'emailGiven' : tier;
  };
  const limit = ownerHash => settings().allowancesMicro[currentTier(ownerHash)];
  function creditTiers(ownerToken) {
    const { allowancesMicro } = settings(), current = currentTier(hash(ownerToken));
    const candidate = current === 'anonymous' ? 'emailGiven' : current === 'emailGiven' && canConfirm ? 'emailConfirmed' : null;
    const next = candidate && allowancesMicro[candidate] > allowancesMicro[current] ? candidate : null;
    return { current, next, delta: next ? allowancesMicro[next] - allowancesMicro[current] : 0, canConfirm, allowancesMicro };
  }
  function walletForHash(ownerHash) {
    function readBalance() {
      const costs = budget.breakdown(undefined, { ownerHash });
      // Between wallet admission and ledger insertion, the durable host hold is
      // authoritative. Once journalled, use the ledger's maxima/settled costs.
      for (const hold of db.prepare('SELECT * FROM host_tier_holds WHERE owner_hash=? AND released=0').all(ownerHash)) {
        if (!budget.get(hold.attempt_id)) costs.reservedMicro += hold.max_micro;
      }
      return { limitMicro: limit(ownerHash), ...costs,
        committedMicro: costs.reservedMicro + costs.confirmedSpendMicro + costs.uncertainSpendMicro };
    }
    const balance = () => atomic(readBalance);
    const canAdmit = request => {
      const current = balance();
      // A zero-extra extension creates no new owner exposure, even after a policy cut.
      return integer(request?.maxMicro) && (request.maxMicro === 0 ||
        current.limitMicro > 0 && request.maxMicro <= current.limitMicro - current.committedMicro);
    };
    return { balance, canAdmit,
      admit(request) {
        if (typeof request?.attemptId !== 'string' || !request.attemptId || !integer(request.maxMicro) ||
          !integer(request.maxVisitorMicro ?? 0)) throw new TypeError('Invalid owner admission');
        const fingerprint = JSON.stringify([request.sessionId, request.lane, request.maxMicro,
          request.maxVisitorMicro ?? 0, request.requestSha256, request.bindingSha256]);
        return storage.transaction(() => {
          const previous = db.prepare('SELECT * FROM host_tier_holds WHERE attempt_id=?').get(request.attemptId);
          if (previous) {
            if (previous.owner_hash !== ownerHash || previous.fingerprint !== fingerprint) return { ok: false, reason: 'attempt-conflict' };
            if (!previous.released || budget.get(request.attemptId)) return { ok: true };
          }
          if (storage.get(request.sessionId).ownerHash !== ownerHash) throw new TypeError('Wrong owner');
          if (!canAdmit(request)) return { ok: false, reason: 'host-limit' };
          db.prepare(`INSERT INTO host_tier_holds VALUES (?,?,?,?,0)
            ON CONFLICT(attempt_id) DO UPDATE SET released=0`).run(request.attemptId, ownerHash, fingerprint, request.maxMicro);
          return { ok: true };
        });
      },
      release({ attemptId }) { db.prepare('UPDATE host_tier_holds SET released=1 WHERE attempt_id=? AND owner_hash=?').run(attemptId, ownerHash); },
    };
  }
  function eraseOwner(ownerHash) {
    storage.transaction(() => {
      db.prepare('DELETE FROM host_tier_holds WHERE owner_hash=?').run(ownerHash);
      db.prepare('DELETE FROM host_visitor_tiers WHERE owner_hash=?').run(ownerHash);
    });
  }
  const host = {
    // Privileged eraseSession has no owner token; the tombstone retains its hash.
    erased: ({ sessionId }) => eraseOwner(storage.get(sessionId).ownerHash),
    retired: ({ ownerHash }) => eraseOwner(ownerHash),
    eraseVisitorForOwnerHash: eraseOwner,
    wallet: ownerToken => walletForHash(hash(ownerToken)),
    walletForSession: session => walletForHash(session.ownerHash), creditTiers, credits: { ownerGuard: true }, privacyDocumentConfigured };
  const consent = { coverage: () => ({ covered: false }) }; // offline fixture never authorizes a provider
  const pluginRuntime = createPluginRuntime({ storage, budget, consent });
  const handlers = createHandlers({ storage, host, pluginRuntime, consent });
  const operatorSessions = createOperatorSessions({ provider: operatorProvider,
    store: operatorProvider && createSQLiteOperatorStore(db), publicOrigin, now });
  const json = (value, status = 200) => Response.json(value, { status,
    headers: { 'cache-control': 'no-store', vary: 'Cookie', 'x-content-type-options': 'nosniff' } });
  const audit = () => db.prepare('SELECT * FROM host_tier_audit ORDER BY revision DESC LIMIT 100').all().map(row => ({
    revision: row.revision, at: row.at, actor: JSON.parse(row.actor_json),
    oldValues: JSON.parse(row.old_json), newValues: JSON.parse(row.new_json) }));
  function save(input, operator) {
    return storage.transaction(() => {
      const before = settings();
      if (before.revision !== input.baseRevision) throw Object.assign(new Error('stale-settings'), { status: 409, current: before });
      if (!integer(before.revision + 1)) throw new TypeError('Revision overflow');
      const after = { revision: before.revision + 1, allowancesMicro: input.allowancesMicro };
      const actor = { namespace: operatorProvider.sessionNamespace, subject: operator.subject, name: operator.name };
      db.prepare('UPDATE host_tier_settings SET record=? WHERE id=1').run(JSON.stringify(after));
      db.prepare('INSERT INTO host_tier_audit VALUES (?,?,?,?,?)').run(after.revision, new Date(now()).toISOString(),
        JSON.stringify(actor), JSON.stringify(before), JSON.stringify(after));
      return after;
    });
  }
  async function admin(request) {
    const path = new URL(request.url).pathname;
    if (!['/host/admin/tiers', '/host/admin/tier-audit'].includes(path)) return null;
    if (!operatorSessions?.session(request)) return json({ error: 'operator-session' }, 401);
    if (request.method === 'GET') {
      try { return json(path.endsWith('tier-audit') ? audit() : settings()); }
      catch { return json({ error: 'settings-unavailable' }, 503); }
    }
    if (request.method !== 'POST' || path.endsWith('tier-audit')) return json({ error: 'method-not-allowed' }, 405);
    if (request.headers.get('origin') !== publicOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'cross-origin' }, 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'content-type' }, 415);
    try {
      let bytes = 0; const chunks = [];
      if (request.body) for await (const chunk of request.body) {
        bytes += chunk.byteLength;
        if (bytes > 16_384) return json({ error: 'body-too-large' }, 413);
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!exact(input, ['baseRevision', 'allowancesMicro']) || !integer(input.baseRevision) || !input.baseRevision) return json({ error: 'invalid-settings' }, 400);
        validateAllowances(input.allowancesMicro);
      } catch { return json({ error: 'invalid-settings' }, 400); }
      // Recheck after asynchronous input: revocation/expiry must win before save.
      const operator = operatorSessions.session(request);
      if (!operator) return json({ error: 'operator-session' }, 401);
      return json(save(input, operator));
    } catch (error) {
      if (error.status === 409) return json({ error: 'stale-settings', current: error.current }, 409);
      return json({ error: 'settings-unavailable' }, 503);
    }
  }
  return { storage, budget, host, settings, operatorSessions, handlers,
    // Trusted identity evidence callback, deliberately absent from HTTP routes.
    // The fixture records only a tier; a real host owns address/confirmation evidence.
    recordTrustedTier(ownerToken, tier) {
      if (!tierNames.includes(tier) || tier === 'emailConfirmed' && !canConfirm) throw new TypeError('Unqualified tier');
      db.prepare('INSERT OR REPLACE INTO host_visitor_tiers VALUES (?,?)').run(hash(ownerToken), tier);
    },
    admit(ownerToken, request) { return admitCredits(budget, request, host.wallet(ownerToken)); },
    async handle(request) { return await operatorSessions?.handle(request) ?? await admin(request) ?? handlers.handle(request); },
    async close() { await handlers.close(); storage.close(); },
  };
}
