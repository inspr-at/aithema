import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverEvents } from '../src/session-events.js';

test('idle network time does not split a fast two-event SSE chunk', async t => {
  let now = 0, reads = 0, yields = 0;
  t.mock.method(performance, 'now', () => now);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { yields++; return schedule(...args); });
  const expected = [{ seq: 1 }, { seq: 2 }], received = [];
  const bytes = new TextEncoder().encode(expected.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const reader = { async read() {
    if (reads++) return { done: true };
    // Advance only while awaiting the network; consuming either event is free.
    await Promise.resolve(); now += 32;
    return { done: false, value: bytes };
  } };
  for await (const event of serverEvents(reader)) received.push(event);
  assert.deepEqual(received, expected, 'both events are consumed in order');
  assert.equal(yields, 0, 'idle network time must not schedule a task yield');
});

test('a buffered SSE burst gives pending I/O a turn while its consumer is busy', { timeout: 5000 }, async () => {
  const expected = Array.from({ length: 64 }, (_, seq) => ({ seq })), received = [];
  const bytes = new TextEncoder().encode(expected.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const reader = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }).getReader();
  const io = new Promise(resolve => setImmediate(() => resolve(received.length)));
  for await (const event of serverEvents(reader)) {
    received.push(event);
    // Model synchronous UI work without a wall-clock date or provider call.
    const until = performance.now() + 2;
    while (performance.now() < until) {}
  }
  const atIO = await io;
  assert.ok(atIO > 0 && atIO < expected.length, `pending I/O ran after ${atIO} of ${expected.length} events`);
  assert.deepEqual(received, expected, 'yielding retains every event in order');
});
