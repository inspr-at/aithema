import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextEngine, ControlledRenderer } from '../runtime/engine/index.js';
import { SqliteJournal, JournalClient } from '../runtime/journal/index.js';
import { SqliteBudgetLedger, BudgetClient } from '../runtime/budget/index.js';
import { isLoopbackHost, isOperatorLocalLane } from '../runtime/budget/local.js';
import { isLoopbackHost as settingsLoopbackHost, resolveSettings } from '../runtime/settings/resolver.js';
import { validate } from '../contracts/validate.js';
import { FakeClock, authorizationFor, defaultOutput } from './engine-helpers.test.js';
import { authority, bytes, session, sid, snapshot, turn } from './fixtures/journal/helpers.mjs';

const lanes = ['reaction', 'spec', 'design'];
const settingsDocument = () => JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/settings.local-zero.json', import.meta.url))).doc;
function fixture(t, { settings = settingsDocument(), maxMicro = { reaction: 0, spec: 0, design: 0 },
  priceUsage = () => 0, checkpoint, operatorLocalLanes = lanes } = {}) {
  const clock = new FakeClock();
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-zero-engine-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now: clock.wallNow });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now: clock.wallNow });
  ledger.registerSession({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
    session_cap_micro: 0, principal_day_cap_micro: 0, tenant_day_cap_micro: 0, evidence: true, operator_local_lanes: operatorLocalLanes });
  const auth = authority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'] });
  const client = new JournalClient({ port: journal, authority: auth, now: clock.wallNow });
  const budget = new BudgetClient({ port: ledger, journal, authority: auth, now: clock.wallNow });
  const db = new DatabaseSync(path);
  let calls = 0;
  const assertClaimed = () => {
    calls++;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_claims WHERE state = 'claimed'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_holds WHERE state = 'admitted' AND lane_kind = 'operator_local' AND max_micro = 0").get().n, 1);
  };
  const reasoning = { async *streamChat(request) {
    assertClaimed();
    const lane = request.system.startsWith('Return only JSON {say') ? 'reaction' : 'spec';
    request.onUsage({ input_tokens: 1, output_tokens: 1 });
    yield JSON.stringify(defaultOutput(lane, JSON.parse(request.messages[0].content)));
  }, understand() { throw new Error('Structured path required'); } };
  const renderer = new ControlledRenderer({ clock, plan: () => { assertClaimed(); return { duration_ms: 0, fail: false }; } });
  const options = { journal: client, journalPort: journal, budget, authorization: authorizationFor(auth), reasoning,
    maxMicro, priceUsage, clock, settings, checkpoint, renderer, designWaitMs: 0 };
  let engine;
  t.after(() => { engine?.close(); db.close(); ledger.close(); journal.close(); });
  engine = new TextEngine(options);
  return { engine, options, journal, db, budget, auth, clock, renderer, get calls() { return calls; },
    records: (kind) => journal.recordsAfter(0, client.authority).filter((row) => row.document.kind === kind).map((row) => row.document),
    personTurn: () => journal.append(bytes(turn()), auth).document.seq };
}

for (const lane of lanes) {
  for (const maximum of [0, 100]) {
    it(`(c) zero local provider_max dispatches ${lane} through a hold and claim (constructor maximum ${maximum})`, async (t) => {
      const f = fixture(t, { maxMicro: Object.fromEntries(lanes.map((name) => [name, maximum])) });
      const seq = f.personTurn(); await f.engine.start();
      if (lane === 'design') {
        f.journal.append(bytes(snapshot()), f.auth); await f.engine.transcript();
        f.engine.design.intent({ intent_id: 'fixture-zero', working_rev: 1 }); await f.clock.advance(0);
        assert.equal(f.renderer.calls.length, 1);
        assert.equal(f.engine.design.state.intents[0].state, 'rendered');
      } else if (lane === 'reaction') await f.engine.react(seq); else await f.engine.passSpec();
      assert.equal(f.calls, 1);
      assert.equal(f.records('budget.hold').length, 1);
      assert.equal(f.records('budget.hold')[0].data.max_micro, 0);
      assert.equal(f.records('budget.claim').length, 1);
      const settlement = f.records('budget.settle')[0];
      assert.equal(settlement.data.outcome, 'settled');
      assert.equal(settlement.data.charged_micro, 0);
      assert.equal(validate(settlement.contract, settlement).ok, true);
      assert.deepEqual(f.budget.auditErrors, []);
    });
  }
}

it('(c) missing final cost on a zero-cost local pass settles unknown at zero', async (t) => {
  const f = fixture(t, { priceUsage: () => { throw new Error('fixture usage unknown'); } });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), (error) => error.reason === 'operation_failed' && /fixture usage unknown/.test(error.cause?.message));
  const settlement = f.records('budget.settle')[0];
  assert.equal(f.calls, 1);
  assert.equal(settlement.data.outcome, 'unknown'); assert.equal(settlement.data.charged_micro, 0);
  assert.equal(validate(settlement.contract, settlement).ok, true);
  assert.deepEqual(f.budget.auditErrors, []);
});

it('(c) local settings still require the host to register the zero-cost lane', async (t) => {
  const f = fixture(t, { operatorLocalLanes: [] });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), (error) => error.status === 400 && /not registered by the host/.test(error.cause?.message));
  assert.equal(f.calls, 0);
  assert.equal(f.records('budget.hold').length, 0);
});

it('(c) operator API lanes cannot use zero maxima, even on a loopback endpoint', async (t) => {
  const settings = settingsDocument();
  settings.provider_templates.find((template) => template.id === 'synthetic-local').deployment = 'api';
  const f = fixture(t, { settings, maxMicro: { reaction: 100, spec: 100, design: 100 } });
  assert.throws(() => new TextEngine({ ...f.options, maxMicro: { reaction: 0, spec: 0, design: 0 } }), { reason: 'invalid_configuration' });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), { reason: 'invalid_configuration' });
  assert.equal(f.calls, 0); assert.equal(f.records('budget.hold').length, 0);
});

it('(c) a zero constructor maximum requires enabled local settings; cloud presets refuse it', (t) => {
  const f = fixture(t);
  for (const settings of [undefined, { ...settingsDocument(), defaults: { ...settingsDocument().defaults, preset: 'eu-e1' } }]) {
    assert.throws(() => new TextEngine({ ...f.options, settings }), { reason: 'invalid_configuration' });
  }
  const settings = settingsDocument();
  settings.presets['local-l1'].lanes.spec = null;
  assert.throws(() => new TextEngine({ ...f.options, settings }), { reason: 'invalid_configuration' });
  for (const max_micro of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new TextEngine({ ...f.options, maxMicro: { reaction: 0, spec: max_micro, design: 0 } }), { reason: 'invalid_configuration' });
  }
});

it('(c) operator-local qualification is exact about loopback, hosting and enabled state', () => {
  const row = { enabled: true, execution_location: 'operator', template: { deployment: 'self_hosted', endpoint: 'http://127.0.0.1/v1' } };
  for (const host of ['localhost', '[::1]', '127.0.0.2', '127.255.255.255']) {
    assert.equal(isOperatorLocalLane({ ...row, template: { ...row.template, endpoint: `http://${host}/v1` } }), true);
  }
  for (const host of ['127.example.invalid', 'localhost.example.invalid', '192.168.1.10', 'provider.example.invalid']) {
    assert.equal(isOperatorLocalLane({ ...row, template: { ...row.template, endpoint: `https://${host}/v1` } }), false);
  }
  assert.equal(isOperatorLocalLane({ ...row, enabled: false }), false);
  assert.equal(isOperatorLocalLane({ ...row, execution_location: 'cloud' }), false);
  assert.equal(isOperatorLocalLane({ ...row, template: { ...row.template, deployment: 'api' } }), false);
  assert.equal(isOperatorLocalLane({ ...row, template: { ...row.template, endpoint: 'invalid URL' } }), false);
  assert.equal(isOperatorLocalLane(undefined), false);
});

it('(c) settings and zero-cost lanes share one loopback authority at every call site', () => {
  assert.equal(settingsLoopbackHost, isLoopbackHost);
  const resolve = (doc, preferences) => resolveSettings(doc, { now: '2026-09-30T07:00:00Z', preferences }).lanes.spec;
  const withHost = (host) => {
    const doc = settingsDocument();
    doc.provider_templates.find((template) => template.id === 'synthetic-local').endpoint = `https://${host}/v1`;
    if (!doc.policy.egress.allow.includes(host)) doc.policy.egress.allow.push(host);
    doc.presets['local-l1'].egress.allow = [host];
    return doc;
  };
  for (const [expected, hosts] of [
    [true, ['localhost', '[::1]', '127.0.0.1', '127.0.0.2', '127.255.255.255']],
    [false, ['127.example.invalid', 'localhost.example.invalid', '192.168.1.10', 'provider.example.invalid', '[::ffff:7f00:1]']],
  ]) {
    for (const host of hosts) {
      assert.equal(isLoopbackHost(host), expected, host);
      const doc = withHost(host);
      const template = doc.provider_templates.find((entry) => entry.id === 'synthetic-local');
      assert.equal(isOperatorLocalLane({ enabled: true, execution_location: 'operator', template }), expected, host);
      const row = resolve(doc);
      assert.equal(row.enabled, expected, `${host}: ${row.reasons}`);
      assert.equal(isOperatorLocalLane(row), expected, host);
    }
  }
  // An unused remote allowlist entry still disables local-l1, independently
  // of its otherwise valid loopback provider endpoint.
  const extraHost = withHost('127.0.0.2');
  extraHost.policy.egress.allow.push('provider.example.invalid');
  extraHost.presets['local-l1'].egress.allow.push('provider.example.invalid');
  assert.ok(resolve(extraHost).reasons.includes('egress_denied'));

  const proxy = withHost('127.0.0.2');
  proxy.hosting.proxy = 'http://127.0.0.2:8080';
  assert.equal(resolve(proxy).enabled, true, 'operator-local proxy accepts the whole loopback subnet');

  // Isolate endpointAllowed from local-l1's separate allowlist/template gates.
  // An allowlisted private literal must remain denied even on an operator lane.
  const privateEndpoint = withHost('192.168.1.10');
  privateEndpoint.presets['eu-e1'].lanes.spec = privateEndpoint.presets['local-l1'].lanes.spec;
  privateEndpoint.presets['eu-e1'].egress.allow = ['192.168.1.10'];
  assert.ok(resolve(privateEndpoint, { preset: 'eu-e1' }).reasons.includes('egress_denied'));
});

it('(d) interrupted local dispatch resumes by recovering its claim at zero without resending', async (t) => {
  let interrupted = true;
  const f = fixture(t, { checkpoint: (stage) => {
    if (interrupted && stage === 'budget.after_claim') throw new Error('fixture dispatch interrupted');
  } });
  f.personTurn(); await f.engine.start();
  await assert.rejects(f.engine.passSpec(), (error) => /fixture dispatch interrupted/.test(error.cause?.message));
  assert.equal(f.calls, 0);
  assert.equal(f.records('budget.settle')[0].data.outcome, 'unknown');
  f.engine.close();
  interrupted = false;
  const resumed = new TextEngine(f.options);
  t.after(() => resumed.close());
  await resumed.resume({ authorizationFor, replay: false });
  assert.equal(f.calls, 0);
  assert.deepEqual(await f.budget.recoverOpen(), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM budget_claims').get().n, 1);
  assert.equal(f.db.prepare('SELECT SUM(charged_or_reserved_micro) AS n FROM budget_usage').get().n, 0);
});
