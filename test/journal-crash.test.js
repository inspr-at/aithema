import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import { JournalClient, JournalError, SqliteJournal, reopenDesign } from '../runtime/journal/index.js';
import { authority, bytes, code, item, now, pendingOp, record, session, snapshot, source, turn } from './fixtures/journal/helpers.mjs';

// §3.4 ledger-only rows (admit→claim, claim→send/mid-request, settlement loss,
// and recovery/dispatch charging) are AIT-P04. This file asserts their journal
// boundary only: late output after takeover/revocation cannot write. No ledger
// implementation, budget assertions, providers or network are used here.

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aithema-journal-crash-'));
  const path = join(dir, 'host.sqlite');
  let journal = new SqliteJournal(path, { now });
  journal.createSession(bytes(session()));
  t.after(() => journal.close());
  return { dir, path, get journal() { return journal; },
    restart() { journal.close(); journal = new SqliteJournal(path, { now }); return journal; },
    client(port = journal, grant = authority(), clock = now) { return new JournalClient({ port, authority: grant, now: clock }); },
  };
}

it('(d) crash after turn journaled, before reaction → replay turn and run controlled reaction', async (t) => {
  const f = fixture(t);
  f.journal.append(bytes(turn()), authority());
  f.restart();
  const client = f.client();
  const resumed = await client.resume();
  let runs = 0;
  for (const entry of resumed.replay.filter((r) => r.document.kind === 'turn')) {
    runs++;
    await client.append(bytes(record('reaction', { turn_seq: entry.document.seq, text: 'Fixture response',
      delivered_prefix: 'Fixture response', certainty: 'delivered', complete: true },
    { writer: { kind: 'worker', generation: client.authority.gen } })));
  }
  assert.equal(runs, 1);
  assert.equal(f.journal.recordsAfter(0, client.authority).filter((r) => r.document.kind === 'reaction').length, 1);
});

for (const browserSurvived of [true, false]) {
  it(`(d) mid-reaction crash → ${browserSurvived ? 'browser playback ack retains heard prefix' : 'browser loss records uncertain prefix'}`, async (t) => {
    const f = fixture(t);
    f.journal.append(bytes(turn()), authority());
    f.restart();
    const client = f.client();
    await client.resume();
    const ack = record('reaction', { turn_seq: 1, text: 'Fixture answer with unheard tail',
      delivered_prefix: browserSurvived ? 'Fixture answer' : '',
      certainty: browserSurvived ? 'delivered' : 'uncertain', complete: false },
    { writer: browserSurvived ? { kind: 'browser' } : { kind: 'worker', generation: 2 } });
    const grant = authority({ gen: 2, writer_kind: browserSurvived ? 'browser' : 'worker' });
    const saved = f.journal.append(bytes(ack), grant);
    assert.equal(f.journal.append(bytes(ack), grant).document.seq, saved.document.seq);
    f.restart();
    const replay = await f.client(f.journal, authority({ gen: 2 })).resume();
    const reaction = replay.replay.find((r) => r.document.kind === 'reaction').document;
    assert.equal(reaction.data.complete, false);
    assert.equal(reaction.data.certainty, browserSurvived ? 'delivered' : 'uncertain');
    assert.equal(reaction.data.delivered_prefix, browserSurvived ? 'Fixture answer' : '');
  });
}

it('(d) spec pass finished but snapshot uncommitted → re-run from the last consumed_seq', async (t) => {
  const f = fixture(t);
  f.journal.append(bytes(turn()), authority());
  f.journal.append(bytes(snapshot({ consumed_seq: 1 })), authority());
  f.journal.append(bytes(turn()), authority());
  const volatilePass = snapshot({ working_rev: 2, expected_prev_rev: 1, consumed_seq: 3 });
  // Crash before append; this computed snapshot is intentionally never persisted.
  f.restart();
  const client = f.client();
  const resumed = await client.resume();
  assert.equal(resumed.snapshot.consumed_seq, 1);
  assert.equal(resumed.snapshot.working_rev, 1);
  assert.deepEqual(resumed.replay.map((r) => r.document.seq), [3]);
  await client.append(bytes({ ...volatilePass, worker_generation: client.authority.gen }));
  assert.equal(f.journal.cursor(client.authority).working_rev, 2);
});

for (const commit of [true, false]) {
  it(`(c,d) abrupt process exit ${commit ? 'after snapshot append, before acknowledgement' : 'before snapshot append'} recovers correctly`, (t) => {
    const f = fixture(t);
    const submitted = bytes(snapshot());
    const inputPath = join(f.dir, 'submission.json');
    writeFileSync(inputPath, submitted);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/journal/crash.mjs', import.meta.url)),
      f.path, inputPath, commit ? 'commit' : 'before'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 23, child.stderr);
    f.restart();
    const cursor = f.journal.cursor(authority());
    assert.equal(cursor.working_rev, commit ? 1 : 0);
    assert.equal(cursor.last_seq, commit ? 1 : 0);
    const accepted = f.journal.append(submitted, authority());
    assert.equal(accepted.document.seq, 1);
    assert.equal(f.journal.recordsAfter(0, authority()).length, 1);
    assert.deepEqual(accepted.bytes, submitted);
  });
}

it('(c,d) lost journal acknowledgement retries original bytes and receives the existing seq', async (t) => {
  const f = fixture(t);
  let loseAck = true;
  const port = { append: (b, a) => {
    const result = f.journal.append(b, a);
    if (loseAck) { loseAck = false; throw new Error('Fixture acknowledgement lost'); }
    return result;
  } };
  const client = f.client(port);
  const submitted = bytes(turn());
  await assert.rejects(client.append(submitted), /acknowledgement lost/);
  submitted.fill(0); // in-flight/cache ownership is a copy
  const exported = client.exportUnacknowledged().unacknowledged[0];
  assert.equal(f.journal.cursor(authority()).last_seq, 1);
  const retried = await client.flush();
  assert.equal(retried[0].document.seq, 1);
  assert.deepEqual(retried[0].bytes, exported);
  assert.equal(f.journal.cursor(authority()).last_seq, 1);
  assert.equal(client.exportUnacknowledged().unacknowledged.length, 0);
});

it('(c) competing host processes assign unique monotonic seqs, including exact concurrent retries', async (t) => {
  const f = fixture(t);
  const first = bytes(turn());
  const inputs = [first, first, bytes(turn()), bytes(turn())];
  const childPath = fileURLToPath(new URL('./fixtures/journal/crash.mjs', import.meta.url));
  await Promise.all(inputs.map((input, i) => {
    const inputPath = join(f.dir, `concurrent-${i}.json`);
    writeFileSync(inputPath, input);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childPath, f.path, inputPath, 'commit']);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (status) => { try { assert.equal(status, 23, stderr); resolve(); } catch (error) { reject(error); } });
    });
  }));
  f.restart();
  const saved = f.journal.recordsAfter(0, authority());
  assert.deepEqual(saved.map((r) => r.document.seq), [1, 2, 3]);
  assert.equal(saved.filter((r) => r.bytes.equals(first)).length, 1);
  assert.equal(f.journal.cursor(authority()).last_seq, 3);
});

it('(c,d) malformed acknowledgement preserves original event bytes for idempotent recovery', async (t) => {
  const f = fixture(t);
  let malformed = true;
  const port = { append: (b, a) => {
    const accepted = f.journal.append(b, a);
    if (malformed) { malformed = false; return { ...accepted, document: { ...accepted.document, seq: 0 } }; }
    return accepted;
  } };
  const client = f.client(port);
  const submitted = bytes(turn());
  await assert.rejects(client.append(submitted), { status: 502 });
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [submitted]);
  assert.equal((await client.flush())[0].document.seq, 1);
  assert.equal(f.journal.cursor(authority()).last_seq, 1);
});

it('(c) transport cannot mutate the cache bytes used for retry or export', async (t) => {
  const f = fixture(t);
  const client = f.client({ append: (b) => { b.fill(0); throw new Error('Fixture transport failure'); } });
  const input = bytes(turn());
  await assert.rejects(client.append(input), /transport failure/);
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [input]);
});

it('(d) stale worker/late claimed output after takeover is journal-fenced', async (t) => {
  const f = fixture(t);
  const old = f.client();
  const late = bytes(record('reaction', { turn_seq: 1, text: 'Late fixture output', delivered_prefix: '',
    certainty: 'not_delivered', complete: false }));
  f.journal.takeover(authority());
  await assert.rejects(old.append(late), code('fenced_generation'));
  assert.equal(old.exportUnacknowledged().unacknowledged.length, 0, 'terminal refusal is not queued for retry');
  assert.equal(f.journal.cursor(authority()).last_seq, 0);
});

for (const [name, make] of [['person turn', turn], ['source body', source]]) {
  it(`(c,d) a fenced never-committed ${name} stays byte-exact in the export bin and is never retried`, async (t) => {
    const f = fixture(t);
    let available = false;
    let calls = 0;
    const client = f.client({ append: (b, a) => {
      calls++;
      if (!available) throw new JournalError(503, 'Fixture host unavailable');
      return f.journal.append(b, a);
    } });
    const submitted = bytes(make());
    const original = Buffer.from(submitted);
    await assert.rejects(client.append(submitted), { status: 503 });
    submitted.fill(0);
    assert.equal(f.journal.cursor(authority()).last_seq, 0, 'initial outage happened before commit');
    f.journal.takeover(authority());
    available = true;
    await assert.rejects(client.flush(), code('fenced_generation'));
    assert.equal(calls, 2);
    const exported = client.exportUnacknowledged();
    assert.deepEqual(exported.unacknowledged, [original]);
    exported.unacknowledged[0].fill(0);
    assert.deepEqual(client.exportUnacknowledged().unacknowledged, [original]);
    assert.deepEqual(await client.flush(), []);
    await assert.rejects(client.append(original), code('fenced_generation'));
    await assert.rejects(client.append(Buffer.concat([original, Buffer.from(' ')])), code('idempotency_conflict'));
    assert.equal(calls, 2, 'neither flush nor explicit re-submission resends a terminally refused event');
    assert.equal(f.journal.cursor(authority()).last_seq, 0);
  });
}

it('(c,d) fenced captured person text moves to export once and leaves the retry queue', async (t) => {
  const f = fixture(t);
  let available = false;
  let calls = 0;
  const client = f.client({ append: (b, a) => {
    calls++;
    if (!available) throw new JournalError(503, 'Fixture host unavailable');
    return f.journal.append(b, a);
  } });
  const pending = Array.from({ length: 5 }, () => bytes(turn()));
  for (const input of pending) await assert.rejects(client.append(input), { status: 503 });
  await assert.rejects(client.append(bytes(turn())), { status: 503 });
  const captured = bytes(turn());
  client.captureTurn(captured);
  await assert.rejects(client.append(Buffer.concat([captured, Buffer.from(' ')])), code('idempotency_conflict'));
  await assert.rejects(client.append(captured), { status: 503 });
  assert.equal(calls, 5, 'captured text cannot bypass the five-turn send bound');
  f.journal.takeover(authority());
  available = true;
  for (let i = 0; i < 6; i++) await assert.rejects(client.flush(), code('fenced_generation'));
  assert.equal(calls, 11);
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [...pending, captured]);
  assert.deepEqual(client.exportUnacknowledged().captured_turns, []);
  assert.deepEqual(await client.flush(), []);
  assert.equal(calls, 11);
  assert.equal(client.state, 'ACTIVE');
  assert.equal(f.journal.cursor(authority()).last_seq, 0);
});

it('(d) late claimed output after epoch withdrawal is revoked, never journaled', async (t) => {
  const f = fixture(t);
  const old = f.client();
  f.journal.append(bytes(record('authz.epoch', { epoch: 2, reason: 'withdrawal' }, { writer: { kind: 'host' } })),
    authority({ writer_kind: 'host' }));
  await assert.rejects(old.append(bytes(turn())), code('revoked'));
  assert.equal(f.journal.cursor(authority({ auth_epoch: 2 })).last_seq, 1);
});

it('(d) unreachable host → bounded journal cache → CAPTURE_ONLY → 10-minute end/export retains bodies', async (t) => {
  const f = fixture(t);
  let clock = now();
  const client = f.client({ append: () => { throw new Error('Fixture host unavailable'); } }, authority(), () => clock);
  const inputs = [bytes(source()), bytes(snapshot({ pending_ops: [pendingOp()] })), ...Array.from({ length: 5 }, () => bytes(turn()))];
  for (const input of inputs) await assert.rejects(client.append(input), /host unavailable/);
  await assert.rejects(client.append(bytes(turn())), { status: 503 });
  assert.equal(client.state, 'CAPTURE_ONLY');
  for (let i = 0; i < 15; i++) client.captureTurn(bytes(turn()));
  assert.throws(() => client.captureTurn(bytes(turn())), { status: 413 });
  const firstExport = client.exportUnacknowledged();
  assert.deepEqual(firstExport.unacknowledged, inputs);
  assert.equal(firstExport.captured_turns.length, 15);
  // Export itself cannot mutate the cache.
  firstExport.unacknowledged[0].fill(0);
  assert.deepEqual(client.exportUnacknowledged().unacknowledged[0], inputs[0]);
  clock += 599_999;
  assert.equal(client.state, 'CAPTURE_ONLY');
  clock += 1;
  assert.equal(client.state, 'ENDED');
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, inputs);
  assert.equal(client.exportUnacknowledged().captured_turns.length, 15);
  await assert.rejects(client.flush(), { status: 409 });
  await assert.rejects(client.append(bytes(turn())), { status: 409 });
  assert.throws(() => client.captureTurn(bytes(turn())), { status: 409 });
});

it('(d) an ENDED client refuses resume before takeover or any journal call', async (t) => {
  const f = fixture(t);
  let clock = now();
  let takeovers = 0;
  let calls = 0;
  const client = f.client({
    append: () => { calls++; throw new JournalError(503, 'Fixture unavailable'); },
    takeover: (a) => { takeovers++; return f.journal.takeover(a); },
  }, authority(), () => clock);
  const submitted = bytes(turn());
  await assert.rejects(client.append(submitted), { status: 503 });
  clock += 600_000;
  assert.equal(client.state, 'ENDED');
  await assert.rejects(client.resume(), { status: 409, code: null,
    message: 'Journal outage ended the session; export available' });
  assert.equal(takeovers, 0);
  assert.equal(calls, 1);
  assert.equal(client.authority.gen, 1);
  assert.equal(f.journal.cursor(authority()).worker_generation, 1);
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [submitted]);
});

for (const retainedBody of [false, true]) {
  it(`(d) terminal refusal clears the outage clock when queues drain${retainedBody ? ', even with export-only bytes' : ''}`, async (t) => {
    const f = fixture(t);
    let clock = now();
    let calls = 0;
    let takeovers = 0;
    const port = {
      append: (b, a) => {
        calls++;
        if (calls === 1) throw new JournalError(503, 'Fixture unavailable');
        if (calls === 2) throw new JournalError(409, 'Fixture refusal', 'fenced_generation');
        return f.journal.append(b, a);
      },
      takeover: (a) => { takeovers++; return f.journal.takeover(a); },
      recordsByIds: (ids, a) => f.journal.recordsByIds(ids, a),
      recordsAfter: (after, a, through) => f.journal.recordsAfter(after, a, through),
    };
    const client = f.client(port, authority(), () => clock);
    const submitted = bytes(retainedBody ? turn() : snapshot());
    await assert.rejects(client.append(submitted), { status: 503 });
    clock += 599_999;
    await assert.rejects(client.flush(), code('fenced_generation'));
    assert.equal(client.state, 'ACTIVE');
    assert.deepEqual(client.exportUnacknowledged().unacknowledged, retainedBody ? [submitted] : []);
    clock += 600_001;
    assert.equal(client.state, 'ACTIVE', 'a drained queue cannot end later because of a stale outage clock');
    const resumed = await client.resume();
    assert.equal(takeovers, 1);
    assert.equal(resumed.cursor.worker_generation, 2);
    assert.deepEqual(client.exportUnacknowledged().unacknowledged, retainedBody ? [submitted] : []);
  });
}

it('(d) separate unacked source/snapshot bounds, duplicate id conflict and text byte cap', async (t) => {
  const f = fixture(t);
  const port = { append: () => { throw new Error('Fixture host unavailable'); } };
  for (const make of [source, snapshot]) {
    const client = f.client(port);
    const input = bytes(make());
    await assert.rejects(client.append(input), /unavailable/);
    await assert.rejects(client.append(Buffer.concat([input, Buffer.from(' ')])), code('idempotency_conflict'));
    await assert.rejects(client.append(bytes(make())), { status: 503 });
    assert.equal(client.state, 'CAPTURE_ONLY');
    const padded = Buffer.concat([bytes(turn()), Buffer.alloc(250 * 1024, 32)]);
    client.captureTurn(padded);
    client.captureTurn(padded); // exact duplicate is not a second buffered turn
    assert.equal(client.exportUnacknowledged().captured_turns.length, 1);
    const large = turn(); large.data.body = 'x'.repeat(8000);
    assert.throws(() => client.captureTurn(bytes(large)), { status: 413 });
    const voice = turn(); voice.data.channel = 'voice';
    assert.throws(() => client.captureTurn(bytes(voice)), { status: 400 });
  }
});

it('(d) host recovery flushes buffered bytes and captured text in order; no duplicate effects', async (t) => {
  const f = fixture(t);
  let available = false;
  const port = { append: (b, a) => { if (!available) throw new Error('Fixture unavailable'); return f.journal.append(b, a); } };
  const client = f.client(port);
  const inputs = Array.from({ length: 5 }, () => bytes(turn()));
  for (const b of inputs) await assert.rejects(client.append(b), /unavailable/);
  await assert.rejects(client.append(bytes(turn())), { status: 503 });
  const captured = bytes(turn());
  client.captureTurn(captured);
  available = true;
  const results = await client.flush();
  assert.deepEqual(results.map((r) => r.document.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(results.map((r) => r.bytes), [...inputs, captured]);
  assert.equal(client.state, 'ACTIVE');
  assert.deepEqual(client.exportUnacknowledged().captured_turns, []);
});

it('(d) contract refusals are surfaced immediately; person bytes are export-only and never retried', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const client = f.client({ append: () => { calls++; throw new JournalError(409, 'Fixture conflict', 'idempotency_conflict'); } });
  const submitted = bytes(turn());
  await assert.rejects(client.append(submitted), code('idempotency_conflict'));
  assert.deepEqual(client.exportUnacknowledged().unacknowledged, [submitted]);
  assert.deepEqual(await client.flush(), []);
  assert.equal(calls, 1);
  assert.equal(client.state, 'ACTIVE');
});

it('(e) online backup includes WAL records; restore → resume → citation validation → fixture preview reopen', async (t) => {
  const f = fixture(t);
  const input = JSON.parse(readFileSync(new URL('./fixtures/journal/design-input.json', import.meta.url), 'utf8'));
  f.journal.append(bytes(turn()), authority());
  f.journal.append(bytes(source()), authority());
  const design = f.journal.append(bytes(record('design.input', { ...input,
    screen_ir_sha256: sha256Hex(canonicalJson(input.screen_ir)), tokens_sha256: sha256Hex(canonicalJson(input.tokens)) })), authority());
  f.journal.append(bytes(snapshot({ consumed_seq: 3, spec: {
    items: [item({ citations: [{ record_seq: 1, locator: 'turn:1' }, { record_seq: 2, locator: 'seg:leaf' }], leaves: [1, 2] })],
    questions: [], brief: null, screens: [{ screen_ref: 'fixture-export', design_input_seq: 3 }],
  } })), authority());
  const backupPath = join(f.dir, "backup-'fixture.sqlite");
  await f.journal.backup(backupPath);
  await assert.rejects(f.journal.backup(backupPath), { code: 'EEXIST' });
  // The original host stays open and writable throughout; later records are
  // deliberately outside this completed backup, proving snapshot independence.
  f.journal.append(bytes(turn()), authority());
  const restored = new SqliteJournal(backupPath, { now });
  t.after(() => restored.close());
  assert.equal(restored.cursor(authority()).last_seq, 4);
  assert.equal(f.journal.cursor(authority()).last_seq, 5);
  const client = new JournalClient({ port: restored, authority: authority(), now });
  const resumed = await client.resume();
  assert.equal(resumed.closure.size, 3);
  assert.deepEqual(resumed.closure.get(3).bytes, design.bytes);
  const render = ({ screen_ir_bytes, tokens_bytes, record_bytes }) => {
    assert.deepEqual(record_bytes, design.bytes);
    return Buffer.concat([screen_ir_bytes, tokens_bytes]);
  };
  const reopened = await reopenDesign(resumed.snapshot, resumed.closure, 'fixture-export', render);
  assert.deepEqual(reopened, Buffer.concat([Buffer.from(canonicalJson(input.screen_ir)), Buffer.from(canonicalJson(input.tokens))]));
  assert.equal((await client.append(bytes(turn({ writer: { kind: 'worker', generation: 2 } })))).document.seq, 6);
  assert.equal(f.journal.cursor(authority()).worker_generation, 1, 'restoring does not alter original host generation');
});
