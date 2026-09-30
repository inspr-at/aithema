import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger, budgetMessage, createOutboundGate, encodeMessage, requestSha256 } from '../runtime/budget/index.js';
import { sha256Hex, validate } from '../contracts/validate.js';
import { authority as journalAuthority, bytes, code, now, record, session, sid, turn } from './fixtures/journal/helpers.mjs';

const authority = (overrides = {}) => journalAuthority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'], ...overrides });
const admission = (n = 1, lane = 'spec') => ({ attempt_id: `${sid}:1:${lane}:${n}`, sid, worker_generation: 1,
  auth_epoch: 1, lane, max_micro: 100, currency: 'EUR' });
const request = Buffer.from(' { "fixture" : "🧪 bounded request" }\n');

function host(t, caps = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-budget-gate-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now });
  ledger.registerSession({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
    session_cap_micro: 1000, principal_day_cap_micro: 1000, tenant_day_cap_micro: 1000, evidence: true, ...caps });
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now });
  t.after(() => { ledger.close(); journal.close(); });
  return { path, journal, ledger, client };
}

/** Transparent test adapter, with explicit fault injection and no transport. */
const adapter = (ledger, overrides = {}) => Object.fromEntries(['admit', 'claim', 'settle', 'recover', 'listOpen', 'isCurrent']
  .map((method) => [method, overrides[method] ?? ledger[method].bind(ledger)]));
const recover = (ledger, hold, auth = authority()) => ledger.recover(encodeMessage('recover_request', {
  hold_id: hold, worker_generation: auth.gen, auth_epoch: auth.auth_epoch }), auth).body;
const eventData = (journal, kind, auth = authority()) => journal.recordsAfter(0, auth).filter((row) => row.document.kind === kind).map((row) => row.document.data);

it('outbound gate journals hold before claim/open, sends exact digested bytes once, then journals settlement', async (t) => {
  const { journal, client, ledger } = host(t);
  const held = await client.admit(admission());
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: async ({ bytes: original, claim_id, request_sha256 }) => {
    opened++;
    assert.deepEqual(original, request);
    assert.equal(request_sha256, sha256Hex(request.toString('utf8')));
    assert.equal(ledger.listOpen({}, authority()).body.holds[0].claimed, true);
    assert.equal(eventData(journal, 'budget.hold')[0].hold_id, held.hold_id);
    assert.equal(eventData(journal, 'budget.claim')[0].claim_id, claim_id);
    return { output: 'fixture result', actual_micro: 21 };
  } });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, 'fixture result');
  assert.equal(result.discarded, false);
  assert.equal(result.settlement.charged_micro, 21);
  assert.equal(opened, 1);
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('hold_closed'));
  assert.equal(opened, 1);
  const records = journal.recordsAfter(0, authority());
  assert.deepEqual(records.map((row) => row.document.kind), ['budget.hold', 'budget.claim', 'budget.settle']);
  assert.ok(records.every((row) => validate(row.document.contract, row.document).ok));
});

it('gate refuses concurrent duplicate dispatch, allowing exactly one provider opening', async (t) => {
  const { client, ledger } = host(t);
  const held = await client.admit(admission());
  let opened = 0;
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  const dispatch = createOutboundGate({ budget: client, open: async () => {
    opened++;
    await ready;
    return { output: 'fixture', actual_micro: 10 };
  } });
  const first = dispatch({ hold_id: held.hold_id, request_bytes: request });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('already_claimed'));
  finish();
  await first;
  assert.equal(opened, 1);
  assert.equal(recover(ledger, held.hold_id).charged_micro, 10);
});

for (const change of ['takeover', 'revocation']) {
  it(`takeover/revocation boundary: ${change} before claim opens nothing`, async (t) => {
    const { client, journal, ledger } = host(t);
    const held = await client.admit(admission());
    if (change === 'takeover') journal.takeover(authority());
    else journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
    let opened = 0;
    const dispatch = createOutboundGate({ budget: client, open: () => { opened++; } });
    await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code(change === 'takeover' ? 'fenced_generation' : 'revoked'));
    assert.equal(opened, 0);
    const current = authority(change === 'takeover' ? { gen: 2 } : { auth_epoch: 2 });
    assert.equal(recover(ledger, held.hold_id, current).closed_reason, 'void');
  });

  it(`committed claim with ${change} while its response is in flight sends, charges maximum, discards output`, async (t) => {
    const { ledger, journal } = host(t);
    const port = adapter(ledger, { claim: async (original, auth) => {
      const committed = ledger.claim(original, auth);
      if (change === 'takeover') journal.takeover(auth);
      else journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), { ...auth, writer_kind: 'host' });
      return committed;
    } });
    const client = new BudgetClient({ port, journal, authority: authority(), now });
    const held = await client.admit(admission());
    let opened = 0;
    const dispatch = createOutboundGate({ budget: client, open: async () => {
      opened++;
      return { output: 'stale fixture output', actual_micro: 1 };
    } });
    const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
    assert.equal(opened, 1);
    assert.equal(result.output, null);
    assert.equal(result.discarded, true);
    assert.deepEqual(result.settlement, { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
    assert.equal(client.auditErrors.length, 2, 'both fenced journal writes are reported, but do not undo the committed claim');
    const current = authority(change === 'takeover' ? { gen: 2 } : { auth_epoch: 2 });
    assert.deepEqual(eventData(journal, 'budget.claim', current), []);
    assert.deepEqual(recover(ledger, held.hold_id, current), result.settlement);
  });
}

it('takeover during provider completion uses the captured claim owner even if client authority was updated', async (t) => {
  const { journal, client } = host(t);
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => {
    journal.takeover(authority());
    client.setAuthority(authority({ gen: 2 }));
    return { output: 'late fixture', actual_micro: 5 };
  } });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, null);
  assert.equal(result.settlement.charged_micro, 100);
});

it('takeover between output check and settlement is caught by the ledger transaction', async (t) => {
  const { ledger, journal } = host(t);
  const port = adapter(ledger, { settle: (original, auth) => {
    journal.takeover(auth);
    return ledger.settle(original, auth);
  } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'late fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, null);
  assert.equal(result.settlement.closed_reason, 'unknown');
  assert.equal(result.settlement.charged_micro, 100);
});

it('takeover after settlement committed but before its response discards late output and preserves recorded settlement', async (t) => {
  const { journal, ledger } = host(t);
  const port = adapter(ledger, { settle: (original, auth) => {
    const response = ledger.settle(original, auth);
    journal.takeover(auth);
    return response;
  } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'late fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, null);
  assert.equal(result.discarded, true);
  assert.equal(result.settlement.charged_micro, 5, 'settlement was already durable before takeover');
  assert.deepEqual(recover(ledger, held.hold_id, authority({ gen: 2 })), result.settlement);
});

it('provider exception is charged unknown and the consumed claim cannot be resent', async (t) => {
  const { client, ledger } = host(t);
  const held = await client.admit(admission());
  const failure = new Error('fixture provider connection lost');
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: () => { opened++; throw failure; } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) => error === failure);
  assert.deepEqual(recover(ledger, held.hold_id), { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('hold_closed'));
  assert.equal(opened, 1);
});

it('lost claim response never opens a provider and recovers the committed claim unknown', async (t) => {
  const { ledger, journal } = host(t);
  const port = adapter(ledger, { claim: (original, auth) => {
    ledger.claim(original, auth);
    throw new Error('fixture lost claim response');
  } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: () => { opened++; } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), /lost claim response/);
  assert.equal(opened, 0);
  assert.equal(recover(ledger, held.hold_id).charged_micro, 100);
});

it('lost settlement response preserves recorded settlement, with no automatic provider resend', async (t) => {
  const { ledger, journal } = host(t);
  const port = adapter(ledger, { settle: (original, auth) => {
    ledger.settle(original, auth);
    throw new Error('fixture lost settlement response');
  } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: async () => { opened++; return { output: 'fixture', actual_micro: 9 }; } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), /lost settlement response/);
  assert.deepEqual(await client.recover({ hold_id: held.hold_id, worker_generation: 1, auth_epoch: 1 }),
    { hold_id: held.hold_id, closed_reason: 'settled', charged_micro: 9 });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('hold_closed'));
  assert.equal(opened, 1);
});

it('provider and settlement failures report both errors, leaving recovery authoritative', async (t) => {
  const { ledger, journal } = host(t);
  const port = adapter(ledger, { settle: () => { throw new Error('fixture ledger unavailable'); } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: () => { throw new Error('fixture provider unavailable'); } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) =>
    error instanceof AggregateError && error.errors.length === 2);
  assert.equal(recover(ledger, held.hold_id).charged_micro, 100);
});

it('unavailable post-send authority discards output and conservatively settles at maximum', async (t) => {
  const { ledger, journal } = host(t);
  const port = adapter(ledger, { isCurrent: () => { throw new Error('fixture authority unavailable'); } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'unverified fixture', actual_micro: 1 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, null);
  assert.equal(result.settlement.charged_micro, 100);
  assert.match(result.authority_error.message, /authority unavailable/);
});

it('in-flight mutable request buffers are snapshotted before claim, preserving the claimed digest', async (t) => {
  const { ledger, journal } = host(t);
  let acknowledge;
  const paused = new Promise((resolve) => { acknowledge = resolve; });
  const port = adapter(ledger, { claim: async (original, auth) => {
    const result = ledger.claim(original, auth);
    await paused;
    return result;
  } });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const original = Buffer.from(request);
  const dispatch = createOutboundGate({ budget: client, open: async ({ bytes: sent, request_sha256 }) => {
    assert.deepEqual(sent, request);
    assert.equal(request_sha256, requestSha256(request));
    return { output: 'fixture', actual_micro: 1 };
  } });
  const pending = dispatch({ hold_id: held.hold_id, request_bytes: original });
  original.fill(0);
  acknowledge();
  await pending;
  assert.notEqual(requestSha256(original), requestSha256(request));
  assert.notEqual(requestSha256('{"a":1}'), requestSha256('{ "a": 1 }'));
});

it('write-ahead hold outage returns no spend authority, and ledger enumeration still recovers it', async (t) => {
  const { ledger } = host(t);
  const client = new BudgetClient({ port: ledger, journal: { append: () => { throw new Error('fixture hold journal unavailable'); } },
    authority: authority(), now });
  await assert.rejects(client.admit(admission()), /hold journal unavailable/);
  const hold = ledger.listOpen({}, authority()).body.holds[0];
  assert.equal(hold.claimed, false);
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: () => { opened++; } });
  await assert.rejects(dispatch({ hold_id: hold.hold_id, request_bytes: request }), /acknowledged matching/);
  assert.equal(opened, 0);
  assert.equal(recover(ledger, hold.hold_id).closed_reason, 'void');
});

it('lost write-ahead journal acknowledgement stops the client; exact admission retry retains its hold', async (t) => {
  const { ledger, journal } = host(t);
  let lose = true;
  const client = new BudgetClient({ port: ledger, journal: { append: (original, auth) => {
    const response = journal.append(original, auth);
    if (lose) { lose = false; throw new Error('fixture lost hold ack'); }
    return response;
  } }, authority: authority(), now });
  await assert.rejects(client.admit(admission()), /lost hold ack/);
  const prior = ledger.listOpen({}, authority()).body.holds[0].hold_id;
  assert.equal((await client.admit(admission())).hold_id, prior);
  assert.equal(ledger.listOpen({}, authority()).body.holds.length, 1);
});

it('invalid critical journal acknowledgement fails closed before provider dispatch', async (t) => {
  const { ledger, journal } = host(t);
  const client = new BudgetClient({ port: ledger, journal: { append: (original, auth) => {
    const stored = journal.append(original, auth);
    return { ...stored, document: { ...stored.document, seq: 0 } };
  } }, authority: authority(), now });
  await assert.rejects(client.admit(admission()), /valid seq/);
  assert.equal(ledger.listOpen({}, authority()).body.holds[0].claimed, false);
});

it('(e) provider retry requires new attempt/hold/claim and accounts for both attempts', async (t) => {
  const { client, ledger } = host(t);
  let opened = 0;
  const claims = [];
  const dispatch = createOutboundGate({ budget: client, open: async ({ claim_id }) => {
    claims.push(claim_id);
    if (++opened === 1) throw new Error('fixture transient provider failure');
    return { output: 'fixture retry', actual_micro: 10 };
  } });
  const first = await client.admit(admission(1));
  await assert.rejects(dispatch({ hold_id: first.hold_id, request_bytes: request }), /transient/);
  const retry = await client.admit(admission(2));
  const result = await dispatch({ hold_id: retry.hold_id, request_bytes: request });
  assert.equal(result.output, 'fixture retry');
  assert.notEqual(first.hold_id, retry.hold_id);
  assert.notEqual(claims[0], claims[1]);
  assert.equal(recover(ledger, first.hold_id).charged_micro + recover(ledger, retry.hold_id).charged_micro, 110);
});

it('(f) a cap denial stops every paid client lane while allowing text capture', async (t) => {
  const { client, journal } = host(t, { session_cap_micro: 0 });
  await assert.rejects(client.admit(admission()), code('budget_denied', 402));
  assert.equal(client.paidState, 'BUDGET_DENIED');
  for (const lane of ['reaction', 'spec', 'design', 'stt', 'tts']) {
    await assert.rejects(client.admit(admission(2, lane)), code('budget_denied', 402));
  }
  await assert.rejects(client.claim({ hold_id: randomUUID(), request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 }), code('budget_denied', 402));
  assert.equal(client.textCaptureAllowed, true);
  assert.equal(journal.append(bytes(turn()), authority()).document.seq, 1);
});

it('gate rejects caller-supplied claims, invalid bytes, malformed or reused fresh claim ids', async () => {
  const claimId = randomUUID();
  let opened = 0;
  const budget = { authority: authority(), claim: async () => ({ claim_id: claimId }),
    isCurrent: async () => true, settle: async () => ({ closed_reason: 'settled', charged_micro: 1 }) };
  const dispatch = createOutboundGate({ budget, open: async () => { opened++; return { output: 'fixture', actual_micro: 1 }; } });
  await assert.rejects(dispatch({ hold_id: randomUUID(), request_bytes: request, claim_id: claimId }), { status: 400 });
  await assert.rejects(dispatch({ hold_id: randomUUID(), request_bytes: {} }), { status: 400 });
  await dispatch({ hold_id: randomUUID(), request_bytes: request });
  await assert.rejects(dispatch({ hold_id: randomUUID(), request_bytes: request }), code('already_claimed'));
  assert.equal(opened, 1);
  for (const value of [null, '', 'fake-claim']) {
    const invalid = createOutboundGate({ budget: { ...budget, claim: async () => ({ claim_id: value }) }, open: () => { opened++; } });
    await assert.rejects(invalid({ hold_id: randomUUID(), request_bytes: request }), { status: 502 });
  }
  assert.equal(opened, 1);
});

it('client validates all incoming messages and rejects foreign, repeated or invalid enumeration', async (t) => {
  const { ledger, journal } = host(t);
  for (const response of [null, { body: { hold_id: randomUUID() } }, budgetMessage('claim_response', { claim_id: randomUUID() }),
    { ...budgetMessage('admit_response', { hold_id: randomUUID(), remaining_micro: 0 }), body: { hold_id: randomUUID(), remaining_micro: 0, unknown: true } }]) {
    const client = new BudgetClient({ port: adapter(ledger, { admit: () => response }), journal, authority: authority(), now });
    await assert.rejects(client.admit(admission()), { status: 400 });
  }
  for (const method of ['claim', 'recover', 'settle']) {
    const client = new BudgetClient({ port: adapter(ledger, { [method]: () => null }), journal, authority: authority(), now });
    const body = method === 'claim' ? { hold_id: randomUUID(), request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 }
      : method === 'recover' ? { hold_id: randomUUID(), worker_generation: 1, auth_epoch: 1 }
        : { claim_id: randomUUID(), outcome: 'unknown' };
    await assert.rejects(client[method](body), { status: 400 });
  }
  const client = new BudgetClient({ port: adapter(ledger, { listOpen: () => budgetMessage('holds_list', {
    sid, state: 'open', holds: [], next_cursor: 'same-cursor' }) }), journal, authority: authority(), now });
  await assert.rejects(client.recoverOpen(), /cursor did not advance/);
  assert.throws(() => client.setAuthority(authority({ sid: randomUUID() })), { status: 403 });
  const copy = client.authority;
  copy.gen = 999;
  assert.equal(client.authority.gen, 1);
});

it('missing/malformed final provider cost settles unknown and never publishes output', async (t) => {
  const { ledger, client } = host(t);
  let n = 0;
  for (const result of [null, { output: 'fixture' }, { output: 'fixture', actual_micro: -1 }, { output: 'fixture', actual_micro: NaN }]) {
    const held = await client.admit(admission(++n));
    const dispatch = createOutboundGate({ budget: client, open: async () => result });
    await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), { status: 502 });
    assert.equal(recover(ledger, held.hold_id).charged_micro, 100);
  }
});

it('client rejects contract-valid recovery/settlement responses bound to a different hold', async (t) => {
  const { ledger, journal } = host(t);
  const wrongHold = randomUUID();
  const port = adapter(ledger, {
    recover: () => budgetMessage('recover_response', { hold_id: wrongHold, closed_reason: 'void', charged_micro: 0 }),
    settle: () => budgetMessage('recover_response', { hold_id: wrongHold, closed_reason: 'settled', charged_micro: 1 }),
  });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const committed = await client.claim({ hold_id: held.hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 });
  await assert.rejects(client.recover({ hold_id: held.hold_id, worker_generation: 1, auth_epoch: 1 }), { status: 502 });
  await assert.rejects(client.settle({ claim_id: committed.claim_id, outcome: 'settled', actual_micro: 1 }), { status: 502 });
});

it('client rejects reused claim ids and void settlements even when structurally valid', async (t) => {
  const { ledger, journal } = host(t);
  const claimId = randomUUID();
  const port = adapter(ledger, {
    claim: () => budgetMessage('claim_response', { claim_id: claimId }),
    settle: () => budgetMessage('recover_response', { hold_id: randomUUID(), closed_reason: 'void', charged_micro: 0 }),
  });
  const client = new BudgetClient({ port, journal, authority: authority(), now });
  const held = await client.admit(admission());
  const claimBody = { hold_id: held.hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 };
  await client.claim(claimBody);
  await assert.rejects(client.claim(claimBody), { status: 502 });
  await assert.rejects(client.settle({ claim_id: claimId, outcome: 'unknown' }), { status: 502 });
});

it('outbound and client construction fail closed when mandatory boundaries are missing', () => {
  assert.throws(() => createOutboundGate({ budget: {}, open: () => {} }), TypeError);
  assert.throws(() => createOutboundGate({ budget: { claim() {}, settle() {}, isCurrent() {} } }), TypeError);
  assert.throws(() => new BudgetClient({ port: {}, journal: {}, authority: authority() }), TypeError);
  const port = Object.fromEntries(['admit', 'claim', 'settle', 'recover', 'listOpen', 'isCurrent'].map((name) => [name, () => {}]));
  assert.throws(() => new BudgetClient({ port, journal: {}, authority: authority() }), TypeError);
});
