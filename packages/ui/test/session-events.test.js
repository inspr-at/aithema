import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverEvents } from '../src/session-events.js';

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
