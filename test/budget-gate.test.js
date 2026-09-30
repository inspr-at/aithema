import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal } from '../runtime/journal/index.js';
import { BudgetClient, SqliteBudgetLedger, budgetMessage, createOutboundGate, encodeMessage, requestSha256 } from '../runtime/budget/index.js';
import { sha256Hex, validate } from '../contracts/validate.js';
import { authority as journalAuthority, bytes, code, now, record, session, sid, time, turn } from './fixtures/journal/helpers.mjs';

const authority = (overrides = {}) => journalAuthority({ capabilities: ['aithema.ledger', 'aithema.journal.read', 'aithema.journal.write'], ...overrides });
const admission = (n = 1, lane = 'spec') => ({ attempt_id: `${sid}:1:${lane}:${n}`, sid, worker_generation: 1,
  auth_epoch: 1, lane, max_micro: 100, currency: 'EUR' });
const request = Buffer.from(' { "fixture" : "🧪 bounded request" }\n');

function host(t, caps = {}, clock = now) {
  const path = join(mkdtempSync(join(tmpdir(), 'aithema-budget-gate-')), 'host.sqlite');
  const journal = new SqliteJournal(path, { now: clock });
  journal.createSession(bytes(session()));
  const ledger = new SqliteBudgetLedger(path, { now: clock });
  ledger.registerSession({ sid, issuer: 'fixture-issuer', principal: 'fixture-person', currency: 'EUR',
    session_cap_micro: 1000, principal_day_cap_micro: 1000, tenant_day_cap_micro: 1000, evidence: true, ...caps });
  const client = new BudgetClient({ port: ledger, journal, authority: authority(), now: clock });
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
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.discarded, true);
  assert.equal(result.output, null);
  assert.match(result.settlement_error.message, /lost settlement response/);
  assert.equal(result.settlement.charged_micro, 9);
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
  assert.equal(eventData(journal, 'budget.hold').length, 1);
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

it('(f) sibling cap denials allow an admitted claim and the same client resumes when settlement frees usage', async (t) => {
  const { client, journal } = host(t, { session_cap_micro: 100 });
  const held = await client.admit({ ...admission(), max_micro: 80 });
  await assert.rejects(client.admit({ ...admission(2), max_micro: 50 }), code('budget_denied', 402));
  assert.equal(client.paidState, 'BUDGET_DENIED');
  for (const lane of ['reaction', 'spec', 'design', 'stt', 'tts']) {
    await assert.rejects(client.admit(admission(4, lane)), code('budget_denied', 402));
  }
  assert.equal(client.textCaptureAllowed, true);
  assert.equal(journal.append(bytes(turn()), authority()).document.kind, 'turn');
  const committed = await client.claim({ hold_id: held.hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 });
  await client.settle({ claim_id: committed.claim_id, outcome: 'settled', actual_micro: 10 });
  // Denied attempts retain their verdict; scheduling resumes with a new attempt.
  await assert.rejects(client.admit({ ...admission(2), max_micro: 50 }), code('budget_denied', 402));
  assert.equal((await client.admit({ ...admission(3), max_micro: 50 })).remaining_micro, 40);
  assert.equal(client.paidState, 'ACTIVE');
});

it('replay after a sibling denial stays denied unless the post-ack check still shows the hold', async (t) => {
  const { ledger, journal } = host(t, { session_cap_micro: 100 });
  let closeOnAck = false;
  const client = new BudgetClient({ port: ledger, journal: {
    append: (original, auth) => {
      const stored = journal.append(original, auth);
      if (closeOnAck) recover(ledger, stored.document.data.hold_id, auth);
      return stored;
    },
    recordsAfter: journal.recordsAfter.bind(journal),
  }, authority: authority(), now });
  const original = { ...admission(), max_micro: 80 };
  const held = await client.admit(original);
  await assert.rejects(client.admit({ ...admission(2), max_micro: 50 }), code('budget_denied', 402));
  assert.equal(client.paidState, 'BUDGET_DENIED');
  closeOnAck = true;
  const replay = await client.admit(original);
  assert.deepEqual(replay, { hold_id: held.hold_id, closed_reason: 'void', charged_micro: 0 });
  assert.equal(client.paidState, 'BUDGET_DENIED');
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: () => { opened++; } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('hold_closed'));
  assert.equal(opened, 0);
  assert.equal(client.paidState, 'BUDGET_DENIED');
  closeOnAck = false;
  assert.equal(typeof (await client.admit({ ...admission(3), max_micro: 50 })).hold_id, 'string');
  assert.equal(client.paidState, 'ACTIVE');
});

it('gate rejects caller-supplied claims, invalid bytes, malformed or reused fresh claim ids', async () => {
  const claimId = randomUUID();
  let opened = 0;
  const budget = { authority: authority(), claim: async () => ({ claim_id: claimId }),
    isCurrent: async () => true, settle: async () => ({ closed_reason: 'settled', charged_micro: 1 }),
    listOpen() {}, recover() {} };
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
  const methods = ['claim', 'settle', 'isCurrent', 'listOpen', 'recover'];
  const complete = Object.fromEntries(methods.map((name) => [name, () => {}]));
  for (const method of methods) {
    const incomplete = { ...complete };
    delete incomplete[method];
    assert.throws(() => createOutboundGate({ budget: incomplete, open: () => {} }), /requires a BudgetClient/);
  }
  assert.throws(() => createOutboundGate({ budget: complete }), /requires a provider-opening function/);
  assert.throws(() => new BudgetClient({ port: {}, journal: {}, authority: authority() }), TypeError);
  const port = Object.fromEntries(['admit', 'claim', 'settle', 'recover', 'listOpen', 'isCurrent'].map((name) => [name, () => {}]));
  assert.throws(() => new BudgetClient({ port, journal: {}, authority: authority() }), TypeError);
});

it('every client admission consults the ledger even after a cap denial', async (t) => {
  const { ledger, journal } = host(t, { session_cap_micro: 0 });
  let admissions = 0;
  const client = new BudgetClient({ port: adapter(ledger, { admit: (original, auth) => {
    admissions++;
    return ledger.admit(original, auth);
  } }), journal, authority: authority(), now });
  for (const lane of ['reaction', 'spec', 'design', 'stt', 'tts']) {
    await assert.rejects(client.admit(admission(1, lane)), code('budget_denied', 402));
  }
  assert.equal(admissions, 5);
});

for (const phase of ['admission response', 'journal acknowledgement']) {
  it(`admission returns the recorded closure when recovery races its ${phase}`, async (t) => {
    const { ledger, journal } = host(t);
    let closed;
    const port = adapter(ledger, { admit: (original, auth) => {
      const response = ledger.admit(original, auth);
      if (phase === 'admission response') closed = recover(ledger, response.body.hold_id, auth);
      return response;
    } });
    const journalPort = { append: (original, auth) => {
      const stored = journal.append(original, auth);
      if (phase === 'journal acknowledgement') closed = recover(ledger, stored.document.data.hold_id, auth);
      return stored;
    }, recordsAfter: journal.recordsAfter.bind(journal) };
    const client = new BudgetClient({ port, journal: journalPort, authority: authority(), now });
    const result = await client.admit(admission());
    assert.deepEqual(result, closed);
    assert.equal(result.closed_reason, 'void');
    assert.deepEqual(await client.listOpen(), { sid, state: 'open', holds: [], next_cursor: null });
    assert.equal(eventData(journal, 'budget.hold').length, 1);
    let opened = 0;
    const dispatch = createOutboundGate({ budget: client, open: () => { opened++; } });
    await assert.rejects(dispatch({ hold_id: result.hold_id, request_bytes: request }), code('hold_closed'));
    assert.equal(opened, 0);
  });
}

it('exact hold journal retries keep one event and original timestamp across time and client restart', async (t) => {
  let timestamp = time;
  const clock = () => timestamp;
  const { ledger, journal, client } = host(t, {}, clock);
  const held = await client.admit(admission());
  const original = journal.recordsAfter(0, authority())[0];
  timestamp += 1000;
  assert.deepEqual(await client.admit(admission()), held);
  timestamp += 1000;
  const restarted = new BudgetClient({ port: ledger, journal, authority: authority(), now: clock });
  assert.deepEqual(await restarted.admit(admission()), held);
  const records = journal.recordsAfter(0, authority());
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], original);
  assert.equal(validate(original.document.contract, original.document).ok, true);
});

it('over-maximum provider cost closes the sent claim unknown and withholds output', async (t) => {
  const { ledger, client } = host(t);
  const held = await client.admit(admission());
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: async () => {
    opened++;
    return { output: 'unusable over-bound fixture', actual_micro: 1000 };
  } });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.discarded, true);
  assert.equal(result.output, null);
  assert.equal(result.settlement_error.status, 400);
  assert.deepEqual(result.settlement, { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
  assert.deepEqual(await client.listOpen(), { sid, state: 'open', holds: [], next_cursor: null });
  assert.deepEqual(recover(ledger, held.hold_id), result.settlement);
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), code('hold_closed'));
  assert.equal(opened, 1);
});

for (const outcome of ['return', 'throw']) {
  it(`token expiry refresh during provider ${outcome} finishes with the current token for the same claim owner`, async (t) => {
    let timestamp = time;
    const clock = () => timestamp;
    const { ledger, journal } = host(t, {}, clock);
    const seen = [];
    const client = new BudgetClient({ port: adapter(ledger, { settle: (original, auth) => {
      seen.push(auth);
      return ledger.settle(original, auth);
    } }), journal, authority: authority({ exp: Math.floor(time / 1000) + 1 }), now: clock });
    const held = await client.admit(admission());
    const refreshed = authority({ exp: Math.floor(time / 1000) + 900 });
    const failure = new Error('fixture provider lost response after refresh');
    const dispatch = createOutboundGate({ budget: client, open: async () => {
      timestamp += 2000;
      client.setAuthority(refreshed);
      if (outcome === 'throw') throw failure;
      return { output: 'refreshed fixture', actual_micro: 5 };
    } });
    if (outcome === 'throw') {
      await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) => error === failure);
      assert.equal(recover(ledger, held.hold_id).charged_micro, 100);
    } else {
      const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
      assert.equal(result.output, 'refreshed fixture');
      assert.equal(result.discarded, false);
      assert.equal(result.settlement.charged_micro, 5);
    }
    assert.deepEqual(seen, [refreshed]);
    assert.equal((await client.listOpen()).holds.length, 0);
  });
}

it('failed actual settlement attempts unknown settlement and never returns the provider output', async (t) => {
  const { ledger, journal } = host(t);
  const attempts = [];
  const failure = new Error('fixture settlement failed before commit');
  const client = new BudgetClient({ port: adapter(ledger, { settle: (original, auth) => {
    const body = JSON.parse(original).body;
    attempts.push(body.outcome);
    if (body.outcome === 'settled') throw failure;
    return ledger.settle(original, auth);
  } }), journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'withheld fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.deepEqual(attempts, ['settled', 'unknown']);
  assert.equal(result.output, null);
  assert.equal(result.discarded, true);
  assert.equal(result.settlement_error, failure);
  assert.deepEqual(recover(ledger, held.hold_id), result.settlement);
  assert.equal(result.settlement.charged_micro, 100);
});

it('when both post-send settlements fail AggregateError retains the provider result and claim for recovery', async (t) => {
  const { ledger, journal } = host(t);
  const failures = [new Error('fixture actual settlement unavailable'), new Error('fixture unknown settlement unavailable')];
  let calls = 0;
  const client = new BudgetClient({ port: adapter(ledger, { settle: () => { throw failures[calls++]; } }),
    journal, authority: authority(), now });
  const held = await client.admit(admission());
  const providerResult = { output: 'completed fixture', actual_micro: 5 };
  let opened = 0;
  const dispatch = createOutboundGate({ budget: client, open: async () => { opened++; return providerResult; } });
  await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    assert.equal(error.provider_result, providerResult);
    assert.equal(error.hold_id, held.hold_id);
    assert.ok(error.claim_id);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(opened, 1);
  assert.equal((await client.listOpen()).holds[0].claimed, true);
  assert.equal(recover(ledger, held.hold_id).charged_micro, 100);
});

it('expiry refresh after an actual settlement failure is used by the unknown fallback', async (t) => {
  let timestamp = time;
  const clock = () => timestamp;
  const { ledger, journal } = host(t, {}, clock);
  const originalAuth = authority({ exp: Math.floor(time / 1000) + 1 });
  const refreshed = authority();
  const seen = [];
  const client = new BudgetClient({ port: adapter(ledger, { settle: (original, auth) => {
    seen.push(auth);
    if (seen.length === 1) {
      timestamp += 2000;
      client.setAuthority(refreshed);
      return ledger.settle(original, auth); // expired before transaction admission
    }
    return ledger.settle(original, auth);
  } }), journal, authority: originalAuth, now: clock });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'withheld fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.deepEqual(seen, [originalAuth, refreshed]);
  assert.equal(result.settlement_error.status, 401);
  assert.equal(result.output, null);
  assert.equal(result.settlement.charged_micro, 100);
});

it('expiry refresh after settlement uses the current claim owner for the final output check', async (t) => {
  let timestamp = time;
  const clock = () => timestamp;
  const { ledger, journal } = host(t, {}, clock);
  const client = new BudgetClient({ port: adapter(ledger, { settle: (original, auth) => {
    const result = ledger.settle(original, auth);
    timestamp += 2000;
    client.setAuthority(authority());
    return result;
  } }), journal, authority: authority({ exp: Math.floor(time / 1000) + 1 }), now: clock });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'current fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, 'current fixture');
  assert.equal(result.discarded, false);
  assert.equal(result.settlement.charged_micro, 5);
});

for (const outcome of ['return', 'throw']) {
  it(`epoch change with updated client authority during provider ${outcome} still settles as the captured claim owner`, async (t) => {
    const { ledger, journal, client } = host(t);
    const held = await client.admit(admission());
    const failure = new Error('fixture revoked provider completion');
    const dispatch = createOutboundGate({ budget: client, open: async () => {
      journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
      client.setAuthority(authority({ auth_epoch: 2 }));
      if (outcome === 'throw') throw failure;
      return { output: 'revoked fixture', actual_micro: 5 };
    } });
    if (outcome === 'throw') {
      await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) => error === failure);
    } else {
      const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
      assert.equal(result.discarded, true);
      assert.equal(result.output, null);
    }
    assert.deepEqual(recover(ledger, held.hold_id, authority({ auth_epoch: 2 })),
      { hold_id: held.hold_id, closed_reason: 'unknown', charged_micro: 100 });
  });
}

it('settlement fallback finishes the original claim even when revocation has fenced enumeration', async (t) => {
  const { ledger, journal } = host(t);
  const calls = [];
  const client = new BudgetClient({ port: adapter(ledger, { settle: (original, auth) => {
    calls.push(JSON.parse(original).body.outcome);
    if (calls.length === 1) {
      journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'change' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
      throw new Error('fixture revocation before settlement admission');
    }
    return ledger.settle(original, auth);
  } }), journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'revoked fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.deepEqual(calls, ['settled', 'unknown']);
  assert.equal(result.output, null);
  assert.equal(result.settlement.charged_micro, 100);
  assert.deepEqual(recover(ledger, held.hold_id, authority({ auth_epoch: 2 })), result.settlement);
});

it('fallback preserves a settlement committed concurrently after its enumeration', async (t) => {
  const { ledger, journal } = host(t);
  let settlementBody;
  let fail = true;
  let finish = false;
  const client = new BudgetClient({ port: adapter(ledger, {
    settle: (original, auth) => {
      if (fail) {
        fail = false;
        settlementBody = original;
        finish = true;
        throw new Error('fixture failed first settlement');
      }
      return ledger.settle(original, auth);
    },
    listOpen: (query, auth) => {
      const response = ledger.listOpen(query, auth);
      if (finish) { finish = false; ledger.settle(settlementBody, auth); }
      return response;
    },
  }), journal, authority: authority(), now });
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => ({ output: 'withheld fixture', actual_micro: 5 }) });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.output, null);
  assert.equal(result.settlement.closed_reason, 'settled');
  assert.equal(result.settlement.charged_micro, 5);
  assert.deepEqual(recover(ledger, held.hold_id), result.settlement);
});

it('provider completion during suspend settles actual cost while its audit write remains paused', async (t) => {
  const { journal, client } = host(t);
  const held = await client.admit(admission());
  const dispatch = createOutboundGate({ budget: client, open: async () => {
    journal.append(bytes(record('session.control', { action: 'suspend' }, { writer: { kind: 'host' } })), authority({ writer_kind: 'host' }));
    return { output: 'completed fixture', actual_micro: 5 };
  } });
  const result = await dispatch({ hold_id: held.hold_id, request_bytes: request });
  assert.equal(result.settlement.charged_micro, 5);
  assert.equal(result.discarded, false);
  assert.equal(client.auditErrors.length, 1);
  assert.equal(client.auditErrors[0].code, null);
  assert.deepEqual(await client.recover({ hold_id: held.hold_id, worker_generation: 1, auth_epoch: 1 }), result.settlement);
});

it('post-ack admission check finds its hold beyond the first ledger page', async (t) => {
  const { ledger, journal } = host(t);
  for (let n = 1; n <= 3; n++) ledger.admit(encodeMessage('admit_request', admission(n)), authority());
  const cursors = [];
  const client = new BudgetClient({ port: adapter(ledger, { listOpen: (query, auth) => {
    cursors.push(query.cursor);
    return ledger.listOpen({ ...query, limit: 2 }, auth);
  } }), journal, authority: authority(), now });
  const held = await client.admit(admission(4));
  assert.ok(held.hold_id);
  assert.equal(Object.hasOwn(held, 'closed_reason'), false);
  assert.equal(cursors.length, 2);
  assert.equal(cursors[0], null);
  assert.ok(cursors[1]);
  assert.equal(ledger.listOpen({}, authority()).body.holds.length, 4);
});

it('admission retry returns the existing claimed recovery rather than fresh spend authority', async (t) => {
  const { ledger, journal, client } = host(t);
  const held = await client.admit(admission());
  const committed = await client.claim({ hold_id: held.hold_id, request_sha256: 'a'.repeat(64), worker_generation: 1, auth_epoch: 1 });
  const closed = recover(ledger, held.hold_id);
  assert.deepEqual(await client.admit(admission()), closed);
  assert.equal(eventData(journal, 'budget.hold').length, 1);
  assert.equal((await client.settle({ claim_id: committed.claim_id, outcome: 'settled', actual_micro: 5 })).charged_micro, 100);
});

for (const fault of ['content', 'projection', 'missing', 'duplicate']) {
  it(`hold retry hydration rejects ${fault} in the existing journal event`, async (t) => {
    let timestamp = time;
    const clock = () => timestamp;
    const { ledger, journal, client } = host(t, {}, clock);
    await client.admit(admission());
    timestamp += 1000;
    const journalPort = { append: journal.append.bind(journal), recordsAfter: (after, auth) => {
      const records = journal.recordsAfter(after, auth);
      if (fault === 'missing') return [];
      if (fault === 'duplicate') return [records[0], records[0]];
      if (fault === 'projection') return [{ ...records[0], document: { ...records[0].document, seq: 0 } }];
      const doc = { ...records[0].document, data: { ...records[0].document.data, max_micro: 99 } };
      const { seq, ...submission } = doc;
      return [{ document: doc, bytes: bytes(submission) }];
    } };
    const restarted = new BudgetClient({ port: ledger, journal: journalPort, authority: authority(), now: clock });
    await assert.rejects(restarted.admit(admission()), fault === 'content' ? code('idempotency_conflict') : /hold event|valid seq/);
    assert.equal((await client.listOpen()).holds[0].claimed, false);
    assert.equal(eventData(journal, 'budget.hold').length, 1);
  });
}

for (const entry of ['admission', 'dispatch fallback', 'drain']) {
  it(`shared enumeration guard rejects a repeated cursor at ${entry}`, async (t) => {
    const { ledger, journal } = host(t);
    let broken = false;
    let pages = 0;
    const client = new BudgetClient({ port: adapter(ledger, {
      listOpen: (query, auth) => {
        if (!broken) return ledger.listOpen(query, auth);
        if (++pages > 3) throw new Error('fixture traversal exceeded its page bound');
        return budgetMessage('holds_list', { sid, state: 'open', holds: [], next_cursor: 'repeated-cursor' });
      },
      settle: () => { throw new Error('fixture failed actual settlement'); },
    }), journal, authority: authority(), now });
    const held = entry === 'dispatch fallback' ? await client.admit(admission()) : null;
    broken = true;
    if (entry === 'admission') await assert.rejects(client.admit(admission()), /cursor did not advance/);
    else if (entry === 'drain') await assert.rejects(client.recoverOpen(), /cursor did not advance/);
    else {
      const providerResult = { output: 'withheld fixture', actual_micro: 5 };
      const dispatch = createOutboundGate({ budget: client, open: async () => providerResult });
      await assert.rejects(dispatch({ hold_id: held.hold_id, request_bytes: request }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[1].message, /cursor did not advance/);
        assert.equal(error.provider_result, providerResult);
        return true;
      });
    }
    assert.equal(pages, 2);
  });
}
