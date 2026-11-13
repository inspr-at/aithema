import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../src/index.js';
import { createMockReasoning, inputRevision } from '@inspr/aithema-core';
import { mockConsent, ownedRequest, testToken } from '../../../test/helpers.js';
import { purposePolicy } from '../../../test/safeguards-corpus.js';

// One subscriber represents one continuously focused tab. No visibility events,
// timers, polling or live providers participate in this server fixture.
for (const variant of ['normal', 'failed-second', 'held-second', 'reconnect']) {
  test(`AIT-504 five persisted typed answers: ${variant}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const now = () => Date.now(), storage = new SQLiteStorage(':memory:', { now });
    const mock = createMockReasoning(), entered = [], gates = [], arrivals = [];
    const plugin = { ...mock, async structured(request, options) {
      const result = await mock.structured(request, options);
      const index = entered.length, gate = Promise.withResolvers();
      gates.push(gate); entered.push(request);
      arrivals.splice(0).forEach(resolve => resolve());
      await gate.promise;
      if (variant === 'failed-second' && index === 1) throw new Error('synthetic assessment failure');
      return result;
    } };
    const runtime = createPluginRuntime({ storage, reasoning: mock, consent: mockConsent, now });
    const admit = runtime.admit;
    runtime.admit = async args => ({ ...await admit(args), plugin });
    const handlers = createHandlers({ storage, pluginRuntime: runtime, purposePolicy, log() {} });
    const session = storage.create({ demo: true, ownerToken: testToken });
    let reader, reading, cursor = 0;
    const events = [], waiters = [];
    const waitEvent = predicate => events.some(predicate) ? Promise.resolve() : new Promise(resolve => waiters.push({ predicate, resolve }));
    const connect = async () => {
      const response = await handlers.handle(ownedRequest(`http://local/api/sessions/${session.id}/events?after=${cursor}`));
      assert.equal(response.status, 200);
      reader = response.body.getReader();
      reading = (async () => {
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) return;
          buffer += new TextDecoder().decode(value);
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').find(line => line.startsWith('data:'));
            if (!data) continue;
            const event = JSON.parse(data.slice(5)); events.push(event);
            if (event.seq) { assert.equal(event.seq, cursor + 1, 'durable SSE has no gap or duplicate'); cursor = event.seq; }
            for (const waiter of [...waiters]) if (waiter.predicate(event)) {
              waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve();
            }
          }
        }
      })();
    };
    const disconnect = async () => { await reader.cancel(); await reading; };
    t.after(async () => { gates.forEach(g => g.resolve()); await handlers.close(); if (reader) await disconnect(); storage.close(); });
    const enteredCount = async count => { while (entered.length < count) await new Promise(resolve => arrivals.push(resolve)); };
    const snapshot = async () => (await handlers.handle(ownedRequest(`http://local/api/sessions/${session.id}`))).json();
    const records = [];
    await connect();
    for (let answer = 1; answer <= 5; answer++) {
      if (variant === 'reconnect' && answer === 3) await disconnect();
      const response = await handlers.handle(ownedRequest(`http://local/api/sessions/${session.id}/turns`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `Our project needs workflow step ${answer}.`, clientEventId: `answer-${answer}` }),
      }));
      assert.equal(response.status, 200);
      const revision = inputRevision(storage.get(session.id));
      if (variant === 'reconnect' && answer === 3) await connect();
      await waitEvent(e => e.type === 'lane.status' && e.data.inputRevision === revision && e.data.running.includes('understanding'));
      const held = variant === 'held-second' && answer >= 2;
      if (!held || answer === 2) await enteredCount(answer);
      const pending = await snapshot();
      assert.ok(pending.operations.running.includes('understanding'), 'current revision has authoritative running status');
      if (!held) {
        gates[answer - 1].resolve(); await handlers.idle();
      }
      const current = await snapshot();
      const seq = current.seq;
      await waitEvent(e => e.seq === seq);
      records.push({ answer, inputRevision: current.operations.inputRevision,
        understandingRevision: current.understanding.inputRevision, running: current.operations.running,
        failed: current.operations.failures, seq: cursor,
        status: events.filter(e => e.type === 'lane.status' && e.data.inputRevision === revision).at(-1)?.data });
      if (variant === 'failed-second' && answer === 2) {
        assert.equal(current.operations.failures[0]?.lane, 'understanding');
        const attempts = entered.length;
        await disconnect(); await connect(); await handlers.idle();
        assert.equal(entered.length, attempts, 'reconnect never repeats a failed same-revision assessment');
      } else if (!held) {
        assert.equal(current.understanding.inputRevision, revision);
        assert.match(current.understanding.summary, new RegExp(`workflow step ${answer}`));
      } else assert.ok(current.operations.running.includes('understanding'));
    }
    if (variant === 'held-second') {
      gates[1].resolve(); await enteredCount(3); gates[2].resolve(); await handlers.idle();
      assert.equal(entered.length, 3, 'superseded input coalesces to the newest revision');
    }
    const final = await snapshot();
    assert.equal(final.understanding.inputRevision, final.operations.inputRevision);
    assert.match(final.understanding.summary, /workflow step 5/);
    assert.deepEqual(final.operations.failures, []);
    await waitEvent(e => e.seq === final.seq);
    assert.ok(events.some(e => e.type === 'understanding.updated' && e.data.inputRevision === final.operations.inputRevision));
    console.log(`AIT-504 ${variant} ${JSON.stringify(records)}`);
  });
}
