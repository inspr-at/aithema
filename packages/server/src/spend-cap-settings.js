const amount = n => Number.isSafeInteger(n) && n >= 0;
const maximumMicro = Number.MAX_SAFE_INTEGER;
const usd = micro => `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;

// Parse signed decimal USD exactly so out-of-range requests can be audited and
// rejected or clamped without floating-point rounding. Other USD configuration stays strict.
function requestedMicro(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^-?\d+(?:\.\d{1,6})?$/u.test(value)) throw new TypeError('Invalid provider cap USD');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return value.startsWith('-') ? -micro : micro;
}

/** Account policy is separate from visitor allowances and their revision/audit. */
export function createSpendCapSettings({ storage, account, configuredCapMicro, totals }) {
  const db = storage.db;
  storage.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS spend_cap_settings (
      account TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1),
      cap_micro INTEGER CHECK(cap_micro>=0 AND cap_micro<=9007199254740991), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS spend_cap_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
      at TEXT NOT NULL, revision INTEGER NOT NULL, requested_usd TEXT NOT NULL,
      old_json TEXT NOT NULL, new_json TEXT NOT NULL, clamp_json TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS spend_cap_audit_account ON spend_cap_audit(account,id);
      CREATE TRIGGER IF NOT EXISTS spend_cap_audit_no_update BEFORE UPDATE ON spend_cap_audit
      BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS spend_cap_audit_no_delete BEFORE DELETE ON spend_cap_audit
      BEGIN SELECT RAISE(ABORT,'append only'); END;`);
    if (!db.prepare('PRAGMA table_info(spend_cap_audit)').all().some(column => column.name === 'details_json')) {
      db.exec("ALTER TABLE spend_cap_audit ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
    }
    // NULL preserves the deployment configuration until an operator first saves.
    db.prepare('INSERT OR IGNORE INTO spend_cap_settings(account,revision,cap_micro) VALUES (?,1,NULL)').run(account);
  });
  const row = () => {
    const value = db.prepare('SELECT * FROM spend_cap_settings WHERE account=?').get(account);
    if (!value || !amount(value.revision) || !value.revision || value.cap_micro !== null && !amount(value.cap_micro)) {
      throw new Error('Provider cap settings unavailable');
    }
    return value;
  };
  const settings = () => {
    const current = row(), spend = totals();
    const minimum = BigInt(spend.spentMicro) + BigInt(spend.reservedMicro) + BigInt(spend.uncertainMicro);
    if (minimum > BigInt(maximumMicro)) throw new Error('Provider liabilities exceed safe accounting range');
    return { schemaVersion: 1, revision: current.revision, storedCapMicro: current.cap_micro,
      configuredCapMicro, capMicro: current.cap_micro ?? configuredCapMicro,
      minimumMicro: Number(minimum), maximumMicro, updatedAt: current.updated_at };
  };
  const largeLimit = [BigInt(configuredCapMicro) * 10n, BigInt(configuredCapMicro) + 1_000_000_000n]
    .reduce((a, b) => a > b ? a : b);
  const changeSettings = (input, { actor, source } = {}, reset = false) => {
    if (source !== 'ops-cli' || typeof actor !== 'string' || !/^ops-cli:[^\x00-\x1f\x7f-\x9f]+$/u.test(actor) || actor.length > 200) {
      throw new TypeError('Provider cap changes require the OPS CLI');
    }
    const allowed = reset ? ['baseRevision'] : ['baseRevision', 'capUsd', 'allowLarge'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key)) || !amount(input.baseRevision) || !input.baseRevision ||
      !reset && input.allowLarge !== undefined && typeof input.allowLarge !== 'boolean') {
      throw new TypeError('Invalid provider cap settings');
    }
    const requestedUsd = reset ? usd(BigInt(configuredCapMicro)) : input.capUsd;
    const requested = requestedMicro(requestedUsd), allowLarge = input.allowLarge === true;
    const result = storage.transaction(() => {
      const before = settings();
      if (input.baseRevision !== before.revision) throw Object.assign(new Error('stale-provider-cap-settings'), { status: 409, current: before });
      const reason = !reset && requested < BigInt(before.minimumMicro) ? 'committed-spend'
        : !reset && requested > largeLimit && !allowLarge ? 'large-cap' : null;
      const message = reason === 'committed-spend' ? 'cap cannot go below spend already committed; current cap unchanged'
        : reason === 'large-cap' ? `cap exceeds the typo limit of $${usd(largeLimit)}; use --allow-large to override; current cap unchanged` : null;
      const clamp = !reason && requested > BigInt(maximumMicro) ? { reason: 'maximum', minimumMicro: before.minimumMicro, maximumMicro } : null;
      const at = new Date(storage.now()).toISOString();
      if (!reason) {
        if (!amount(before.revision + 1)) throw new Error('Provider cap revision overflow');
        const capMicro = reset ? null : clamp ? maximumMicro : Number(requested);
        db.prepare('UPDATE spend_cap_settings SET cap_micro=?,revision=revision+1,updated_at=? WHERE account=?').run(capMicro, at, account);
      }
      const after = reason ? before : settings();
      const details = { operation: reset ? 'reset' : 'set', outcome: reason ? 'refused' : 'saved', allowLarge, reason };
      db.prepare(`INSERT INTO spend_cap_audit(account,actor,source,at,revision,requested_usd,old_json,new_json,clamp_json,details_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(account, actor, source, at, after.revision, requestedUsd,
        JSON.stringify(before), JSON.stringify(after), JSON.stringify(clamp), JSON.stringify(details));
      return { after, message };
    });
    // Throw only after COMMIT so an audited refusal survives the HTTP error.
    if (result.message) throw Object.assign(new Error(result.message), { status: 422, current: result.after });
    return result.after;
  };
  return {
    capMicro: () => row().cap_micro ?? configuredCapMicro,
    settings,
    saveSettings: (input, identity) => changeSettings(input, identity),
    resetSettings: (input, identity) => changeSettings(input, identity, true),
    audit({ after = 0, limit = 100 } = {}) {
      if (!amount(after) || !amount(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid provider cap audit page');
      return db.prepare('SELECT * FROM spend_cap_audit WHERE account=? AND id>? ORDER BY id LIMIT ?').all(account, after, limit)
        .map(value => ({ id: value.id, actor: value.actor, source: value.source, at: value.at, revision: value.revision,
          requestedUsd: value.requested_usd, oldValues: JSON.parse(value.old_json), newValues: JSON.parse(value.new_json), clamp: JSON.parse(value.clamp_json),
          operation: 'set', outcome: 'saved', allowLarge: false, reason: null, ...JSON.parse(value.details_json) }));
    },
  };
}
