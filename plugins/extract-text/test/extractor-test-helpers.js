import { test as nodeTest } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { activeExtractorProcessCount, extractorNetworkAttemptCount } from '../../../packages/core/src/extractor-process.js';

// Capture real timers before tests mock the extractor's clock. A missing child
// event must still fail with a useful message rather than wait forever.
const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
export const CONFORMANCE_TIMEOUT_MS = 10_000;
export function test(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  return nodeTest(name, { timeout: 60_000, ...options }, fn);
}
export async function waitFor(operation, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = schedule(() => reject(new Error(`Timed out after 30s waiting for ${label}`)), 30_000);
    })]);
  } finally { cancel(timer); }
}

// Keep this observer in the permitted extractor test tree. The shared fixture
// polls every millisecond; spawn, started and close events provide all we need.
export function observeParsers(t) {
  const original = childProcess.fork, children = [], events = new EventEmitter();
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = original(...args);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const started = new Promise(resolve => {
      const onMessage = message => { if (message?.type === 'started') finish(true); };
      const onClose = () => finish(false);
      const finish = value => {
        child.removeListener('message', onMessage); child.removeListener('close', onClose); resolve(value);
      };
      child.on('message', onMessage); child.once('close', onClose);
    });
    const record = { child, args, closed, started };
    children.push(record); events.emit('spawned', record);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await waitFor(Promise.all(children.map(record => record.closed)), 'extractor child cleanup');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  const spawned = ({ signal } = {}) => once(events, 'spawned', { signal }).then(([record]) => record);
  return { children, spawned,
    workCount: () => children.length, activeCount: activeExtractorProcessCount,
    requestCount: extractorNetworkAttemptCount,
    waitForWork: async (before, { signal } = {}) => {
      if (signal?.aborted) return;
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const record = children[before] ?? await waitFor(spawned({ signal: cancellation.signal }), 'extractor spawn');
        if (cancellation.signal.aborted) return;
        await waitFor(Promise.race([record.started, once(cancellation.signal, 'abort')]), 'extractor started or close');
      } catch (error) {
        if (!signal?.aborted || error.name !== 'AbortError') throw error;
      } finally {
        signal?.removeEventListener('abort', abort); cancellation.abort();
      }
    },
    killedCount: () => children.filter(({ child }) => child.signalCode === 'SIGKILL').length };
}
