import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteJournal } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger, budgetMessage, encodeMessage, createOutboundGate, requestSha256 } from '../runtime/budget/index.js';
import { canonicalJson, validate } from '../contracts/validate.js';
import { authority as baseAuthority, bytes, now, record, session, sid } from './fixtures/journal/helpers.mjs';

const lanes = ['reaction', 'spec', 'design', 'stt', 'tts'];
const authority = (overrides = {}) => baseAuthority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'], ...overrides });
const registration = (overrides = {}) => ({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
  session_cap_micro: 0, principal_day_cap_micro: 0, tenant_day_cap_micro: 0, evidence: true,
  operator_local_lanes: lanes, ...overrides });
const admission = (n = 1, overrides = {}) => {
  const body = { sid, worker_generation: 1, auth_epoch: 1, lane: 'spec', max_micro: 0, currency: 'EUR', lane_kind: 'operator_local', ...overrides };
  return { ...body, attempt_id: `${sid}:${body.worker_generation}:${body.lane}:${n}` };
};
const claimRequest = (hold_id, overrides = {}) => ({ hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1, ...overrides });
const recovery = (hold_id, overrides = {}) => ({ hold_id, worker_generation: 1, auth_epoch: 1, ...overrides });
function host(t, policy = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-zero-budget-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now });
  ledger.registerSession(registration(policy));
  const db = new DatabaseSync(path);
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now });
  t.after(() => { db.close(); ledger.close(); journal.close(); });
  return { path, journal, ledger, db, client };
}
const documents = (journal, kind) => journal.recordsAfter(0, authority()).filter((row) => row.document.kind === kind).map((row) => row.document);
const charged = (db) => db.prepare('SELECT COALESCE(SUM(charged_or_reserved_micro),0) AS n FROM budget_usage').get().n;

it('(a) zero is structurally valid only with the explicit operator-local reservation kind', () => {
  for (const kind of [undefined, 'remote', null, false, 'local', 'operator_local\n']) {
    const body = admission();
    if (kind === undefined) delete body.lane_kind; else body.lane_kind = kind;
    assert.throws(() => budgetMessage('admit_request', body), { status: 400 });
    const { sid: ignoredSid, worker_generation, auth_epoch, ...data } = body;
    assert.equal(validate('aithema.journal.record', record('budget.hold', { hold_id: randomUUID(), ...data })).ok, false);
  }
  for (const max_micro of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => budgetMessage('admit_request', admission(1, { max_micro })), { status: 400 });
  }
  assert.ok(budgetMessage('admit_request', admission()));
  for (const lane_kind of ['remote', 'operator_local']) assert.ok(budgetMessage('admit_request', admission(1, { max_micro: 1, lane_kind })));
});

it('(a) unknown zero settlement/recovery require operator-local evidence; remote positives stay valid', () => {
  const hold_id = randomUUID(), claim_id = randomUUID();
  for (const lane_kind of [undefined, 'remote', 'operator_local']) {
    const kind = lane_kind === undefined ? {} : { lane_kind };
    const recovered = { contract: 'aithema.budget.message', major: 1, minor: 0, min_reader: 0, type: 'recover_response',
      body: { hold_id, closed_reason: 'unknown', charged_micro: 0, ...kind } };
    const settled = record('budget.settle', { hold_id, claim_id, outcome: 'unknown', charged_micro: 0, ...kind });
    assert.equal(validate(recovered.contract, recovered).ok, lane_kind === 'operator_local');
    assert.equal(validate(settled.contract, settled).ok, lane_kind === 'operator_local');
    recovered.body.charged_micro = 1; settled.data.charged_micro = 1;
    assert.equal(validate(recovered.contract, recovered).ok, true);
    assert.equal(validate(settled.contract, settled).ok, true);
  }
  assert.equal(validate('aithema.journal.record', record('budget.settle', {
    hold_id, outcome: 'unknown', charged_micro: 0, lane_kind: 'operator_local' })).ok, false, 'unknown still needs its claim');
  assert.equal(validate('aithema.journal.record', record('budget.settle', {
    hold_id, claim_id, outcome: 'void', charged_micro: 0, lane_kind: 'operator_local' })).ok, false, 'void stays unclaimed');
});

it('(b) delegated local labels cannot override remote host policy or a different registered lane', async (t) => {
  const { ledger, client, db } = host(t, { operator_local_lanes: ['reaction'] });
  await assert.rejects(client.admit(admission()), { status: 400 });
  assert.throws(() => ledger.admit(encodeMessage('admit_request', admission(1, { max_micro: 1 })), authority()), { status: 400 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 0);
  assert.throws(() => ledger.registerSession(registration()), { status: 409 });
  for (const operator_local_lanes of [['spec', 'spec'], ['unknown'], 'spec', null]) {
    assert.throws(() => ledger.registerSession(registration({ operator_local_lanes })), { status: 400 });
  }
});

for (const lane of lanes) {
  for (const unknown of [false, true]) {
    it(`(b,c) ${lane} admits, acknowledges, claims, dispatches and settles ${unknown ? 'unknown' : 'actual'} at zero`, async (t) => {
      const { client, journal, db } = host(t);
      const body = admission(1, { lane });
      const held = await client.admit(body);
      assert.equal(held.remaining_micro, 0);
      assert.deepEqual(await client.admit(body), held);
      assert.equal(documents(journal, 'budget.hold').length, 1);
      assert.equal(documents(journal, 'budget.hold')[0].minor, 1);
      const request = Buffer.from('fixture exact bytes');
      let calls = 0;
      const dispatch = createOutboundGate({ budget: client, open: ({ bytes, claim_id, request_sha256 }) => {
        calls++;
        assert.deepEqual(bytes, request);
        assert.equal(request_sha256, requestSha256(request));
        assert.equal(db.prepare('SELECT state FROM budget_claims WHERE claim_id = ?').get(claim_id).state, 'claimed');
        assert.equal(documents(journal, 'budget.hold')[0].data.lane_kind, 'operator_local');
        if (unknown) throw new Error('fixture local inference outcome lost');
        return { output: 'fixture result', actual_micro: 0 };
      } });
      if (unknown) await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), /fixture local inference outcome lost/);
      else assert.equal((await dispatch({ hold_id: held.hold_id, request_bytes: request })).output, 'fixture result');
      assert.equal(calls, 1);
      await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), { code: 'hold_closed' });
      assert.equal(calls, 1);
      assert.equal(charged(db), 0);
      const result = await client.recover(recovery(held.hold_id));
      assert.deepEqual(result, { hold_id: held.hold_id, closed_reason: unknown ? 'unknown' : 'settled', charged_micro: 0, lane_kind: 'operator_local' });
      assert.deepEqual(await client.recover(recovery(held.hold_id)), result);
      assert.deepEqual((await client.listOpen()).holds, []);
      const settlement = documents(journal, 'budget.settle').at(-1);
      assert.equal(settlement.data.charged_micro, 0);
      assert.equal(settlement.minor, 1);
      assert.equal(validate(settlement.contract, settlement).ok, true);
      assert.deepEqual(client.auditErrors, []);
    });
  }
}

it('(b) even a zero hold requires an acknowledged, exactly matching local hold record before claim', (t) => {
  const { ledger, journal } = host(t);
  const body = admission();
  const held = ledger.admit(encodeMessage('admit_request', body), authority()).body;
  const claim = () => ledger.claim(encodeMessage('claim_request', claimRequest(held.hold_id)), authority());
  assert.throws(claim, /acknowledged matching/);
  journal.append(bytes(record('budget.hold', { hold_id: held.hold_id, attempt_id: body.attempt_id,
    lane: 'spec', max_micro: 1, currency: 'EUR' })), authority());
  assert.throws(claim, /acknowledged matching/);
  journal.append(bytes(record('budget.hold', { hold_id: held.hold_id, attempt_id: body.attempt_id,
    lane: 'spec', max_micro: 0, currency: 'EUR', lane_kind: 'operator_local' })), authority());
  assert.ok(claim().body.claim_id);
  assert.deepEqual(claim().body, { error: 'already_claimed' });
});

it('(d) restart preserves local admission bytes, single-use claims and idempotent zero recovery', async (t) => {
  const { ledger, path, client, db } = host(t);
  const body = admission();
  const held = await client.admit(body);
  const claim = await client.claim(claimRequest(held.hold_id));
  const unclaimed = await client.admit(admission(2));
  const before = Buffer.from(db.prepare('SELECT original_bytes FROM budget_holds WHERE hold_id = ?').get(held.hold_id).original_bytes);
  const reopened = new SqliteBudgetLedger(path, { now });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.admit(before, authority()).body, held);
  assert.deepEqual(reopened.claim(encodeMessage('claim_request', claimRequest(held.hold_id)), authority()).body, { error: 'already_claimed' });
  const closed = reopened.recover(encodeMessage('recover_request', recovery(held.hold_id)), authority());
  assert.equal(closed.body.closed_reason, 'unknown');
  assert.equal(closed.body.charged_micro, 0);
  assert.deepEqual(ledger.recover(encodeMessage('recover_request', recovery(held.hold_id)), authority()), closed);
  assert.deepEqual(reopened.settle(encodeMessage('settle_request', { claim_id: claim.claim_id, outcome: 'unknown' }), authority()), closed);
  assert.equal((await client.recover(recovery(unclaimed.hold_id))).closed_reason, 'void');
  assert.deepEqual(await client.recoverOpen(), []);
  assert.deepEqual(Buffer.from(db.prepare('SELECT original_bytes FROM budget_holds WHERE hold_id = ?').get(held.hold_id).original_bytes), before);
});

for (const change of ['takeover', 'revoke']) {
  it(`(d) ${change} still fences new zero claims and recovery; committed zero claims settle unknown`, async (t) => {
    const { journal, ledger, client } = host(t);
    const committed = await client.admit(admission());
    const claimed = await client.claim(claimRequest(committed.hold_id));
    const pending = await client.admit(admission(2));
    if (change === 'takeover') journal.takeover(authority()); else journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
    const error = change === 'takeover' ? 'fenced_generation' : 'revoked';
    assert.deepEqual(ledger.claim(encodeMessage('claim_request', claimRequest(pending.hold_id)), authority()).body, { error });
    assert.deepEqual(ledger.recover(encodeMessage('recover_request', recovery(pending.hold_id)), authority()).body, { error });
    assert.deepEqual(ledger.admit(encodeMessage('admit_request', admission(3)), authority()).body, { error });
    const finished = await client.settle({ claim_id: claimed.claim_id, outcome: 'settled', actual_micro: 0 });
    assert.equal(finished.closed_reason, 'unknown'); assert.equal(finished.charged_micro, 0);
    const updated = change === 'takeover' ? { gen: 2, worker_generation: 2 } : { auth_epoch: 2 };
    assert.equal(ledger.recover(encodeMessage('recover_request', recovery(pending.hold_id,
      change === 'takeover' ? { worker_generation: 2 } : updated)), authority(updated)).body.closed_reason, 'void');
  });
}

it('(c) a nonzero actual cost cannot be settled against a zero local ceiling', async (t) => {
  const { client, db } = host(t);
  const held = await client.admit(admission());
  const claimed = await client.claim(claimRequest(held.hold_id));
  await assert.rejects(client.settle({ claim_id: claimed.claim_id, outcome: 'settled', actual_micro: 1 }), { status: 400 });
  assert.equal(db.prepare('SELECT state FROM budget_claims').get().state, 'claimed');
  assert.equal((await client.settle({ claim_id: claimed.claim_id, outcome: 'unknown' })).charged_micro, 0);
});

it('(e) new additive fixture documents validate without changing the original fixtures', () => {
  for (const name of ['budget.admit-local-zero', 'budget.recover-local-zero', 'record.budget-hold-local-zero', 'record.budget-settle-local-zero', 'settings.local-zero']) {
    const fixture = JSON.parse(readFileSync(new URL(`../contracts/fixtures/valid/${name}.json`, import.meta.url)));
    assert.equal(validate(fixture.contract, fixture.doc).ok, true, name);
    assert.equal(typeof canonicalJson(fixture.doc), 'string');
  }
});

// The deployed pre-AIT-88 table, retained independently of the new DDL.
const LEGACY_HOLDS = `CREATE TABLE legacy_budget_holds (
  attempt_id TEXT PRIMARY KEY, hold_id TEXT UNIQUE,
  sid TEXT NOT NULL REFERENCES budget_sessions(sid), worker_generation INTEGER NOT NULL, auth_epoch INTEGER NOT NULL,
  lane TEXT NOT NULL, max_micro INTEGER NOT NULL CHECK(max_micro > 0), currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('admitted','denied','closed')),
  closed_reason TEXT CHECK(closed_reason IN ('void','settled','unknown')), created_at TEXT NOT NULL, closed_at TEXT,
  original_bytes BLOB NOT NULL, verdict_bytes BLOB NOT NULL,
  principal_key TEXT NOT NULL, tenant_key TEXT NOT NULL, budget_day TEXT NOT NULL,
  CHECK((state = 'denied' AND hold_id IS NULL) OR (state != 'denied' AND hold_id IS NOT NULL)),
  CHECK((state = 'closed' AND closed_reason IS NOT NULL AND closed_at IS NOT NULL)
    OR (state != 'closed' AND closed_reason IS NULL AND closed_at IS NULL))
)`;

async function legacyHost(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-legacy-budget-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now }); journal.createSession(bytes(session()));
  let ledger = new SqliteBudgetLedger(path, { now });
  const policy = registration({ operator_local_lanes: [], session_cap_micro: 1000, principal_day_cap_micro: 1000, tenant_day_cap_micro: 1000,
    deployment_period: { deployment_id: 'fixture-deployment', period: 'month', time_zone: 'UTC', ceiling_micro: 1000, notify_at: [0.5] } });
  ledger.registerSession(policy);
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now });
  const bodies = [1, 2, 3].map((n) => { const body = admission(n, { max_micro: 100 }); delete body.lane_kind; return body; });
  const held = [];
  for (const body of bodies) held.push(await client.admit(body));
  const settled = await client.claim(claimRequest(held[0].hold_id));
  await client.settle({ claim_id: settled.claim_id, outcome: 'settled', actual_micro: 25 });
  await client.claim(claimRequest(held[1].hold_id));
  const deniedBody = { ...bodies[0], attempt_id: `${sid}:1:spec:4`, max_micro: 1001 };
  const denied = ledger.admit(encodeMessage('admit_request', deniedBody), authority());
  const db = new DatabaseSync(path);
  db.exec('UPDATE budget_holds SET rowid = rowid * 10');
  const page = ledger.listOpen({ limit: 1 }, authority());
  ledger.close(); ledger = null;
  db.exec('PRAGMA foreign_keys = OFF; DROP VIEW budget_usage');
  db.exec(LEGACY_HOLDS);
  const columns = db.prepare('PRAGMA table_info(legacy_budget_holds)').all().map((column) => column.name).join(',');
  db.exec(`INSERT INTO legacy_budget_holds(rowid,${columns}) SELECT rowid,${columns} FROM budget_holds`);
  db.exec('DROP TABLE budget_holds; ALTER TABLE legacy_budget_holds RENAME TO budget_holds; DROP TABLE budget_session_lanes');
  db.exec(`CREATE INDEX fixture_hold_index ON budget_holds(lane,created_at);
    CREATE TABLE fixture_migration_events(hold_id TEXT);
    CREATE TRIGGER fixture_hold_trigger AFTER UPDATE ON budget_holds BEGIN INSERT INTO fixture_migration_events VALUES(NEW.hold_id); END;
    CREATE VIEW fixture_hold_view AS SELECT hold_id FROM budget_holds`);
  t.after(() => { ledger?.close(); db.close(); journal.close(); });
  return { path, journal, db, policy, held, bodies, page, denied, deniedBody,
    reopen() { ledger = new SqliteBudgetLedger(path, { now }); return ledger; } };
}

it('(b,d) existing databases migrate atomically, retaining rowids, bytes, verdicts, claims and deployment bindings', async (t) => {
  const f = await legacyHost(t);
  const before = f.db.prepare('SELECT rowid,* FROM budget_holds ORDER BY rowid').all();
  const claims = f.db.prepare('SELECT * FROM budget_claims ORDER BY claim_id').all();
  const binding = f.db.prepare('SELECT * FROM budget_deployment_holds ORDER BY hold_id').all();
  const journal = f.db.prepare('SELECT * FROM journal_records ORDER BY seq').all();
  const ledger = f.reopen();
  const migrated = f.db.prepare('SELECT rowid,* FROM budget_holds ORDER BY rowid').all();
  assert.deepEqual(migrated.map(({ lane_kind, ...row }) => row), before.map((row) => ({ ...row })));
  assert.ok(migrated.every((row) => row.lane_kind === null));
  assert.deepEqual(f.db.prepare('SELECT * FROM budget_claims ORDER BY claim_id').all(), claims);
  assert.deepEqual(f.db.prepare('SELECT * FROM budget_deployment_holds ORDER BY hold_id').all(), binding);
  assert.deepEqual(f.db.prepare('SELECT * FROM journal_records ORDER BY seq').all(), journal);
  assert.deepEqual(ledger.listOpen({ limit: 1 }, authority()), f.page);
  assert.equal(ledger.listOpen({ cursor: f.page.body.next_cursor }, authority()).body.holds[0].hold_id, f.held[2].hold_id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('fixture_hold_trigger','fixture_hold_index','fixture_hold_view')").get().n, 3);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(ledger.admit(encodeMessage('admit_request', f.deniedBody), authority()), f.denied);
  for (let i = 0; i < f.held.length; i++) assert.deepEqual(ledger.admit(encodeMessage('admit_request', f.bodies[i]), authority()).body, f.held[i]);
  assert.equal(ledger.recover(encodeMessage('recover_request', recovery(f.held[0].hold_id)), authority()).body.charged_micro, 25);
  const unknown = ledger.recover(encodeMessage('recover_request', recovery(f.held[1].hold_id)), authority());
  assert.equal(unknown.body.closed_reason, 'unknown'); assert.equal(unknown.body.charged_micro, 100);
  assert.equal(ledger.recover(encodeMessage('recover_request', recovery(f.held[2].hold_id)), authority()).body.closed_reason, 'void');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM fixture_migration_events').get().n, 2);
  // Existing sessions get one trusted local policy binding on first registration.
  ledger.registerSession({ ...f.policy, operator_local_lanes: ['spec'] });
  const client = new BudgetClient({ port: ledger, journal: f.journal, authority: authority(), now });
  const zero = await client.admit(admission(5));
  const claimed = await client.claim(claimRequest(zero.hold_id));
  assert.equal((await client.settle({ claim_id: claimed.claim_id, outcome: 'unknown' })).charged_micro, 0);
  assert.equal(charged(f.db), 125);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM fixture_hold_view').get().n, 5);
  const second = new SqliteBudgetLedger(f.path, { now }); t.after(() => second.close());
  assert.deepEqual(second.recover(encodeMessage('recover_request', recovery(f.held[1].hold_id)), authority()), unknown);
  // A trigger executes on the migrated ledger connection, proving it restored
  // FK enforcement rather than relying on the independent fixture connection.
  f.db.exec(`CREATE TRIGGER fixture_check_foreign_keys BEFORE INSERT ON budget_holds
    BEGIN INSERT INTO budget_session_lanes VALUES('fixture-missing-session',x'5b5d'); END`);
  assert.throws(() => ledger.admit(encodeMessage('admit_request', admission(6)), authority()), /FOREIGN KEY/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM budget_holds').get().n, 5);
});

it('(b) a failed legacy migration rolls back table replacement and leaves original rows and bytes intact', async (t) => {
  const f = await legacyHost(t);
  const before = f.db.prepare('SELECT rowid,* FROM budget_holds ORDER BY rowid').all();
  const oldSchema = f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_holds'").get().sql;
  f.db.prepare(`INSERT INTO budget_claims(claim_id,hold_id,request_sha256,worker_generation,auth_epoch,state,claimed_at)
    VALUES(?,?,?,?,?,'claimed',?)`).run(randomUUID(), randomUUID(), 'b'.repeat(64), 1, 1, new Date(now()).toISOString());
  assert.throws(() => f.reopen(), /migration found broken foreign keys/);
  assert.equal(f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_holds'").get().sql, oldSchema);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM budget_holds ORDER BY rowid').all(), before);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'budget_holds_local_upgrade'").get(), undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('fixture_hold_trigger','fixture_hold_index','fixture_hold_view')").get().n, 3);
});
