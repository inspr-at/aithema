import { setTimeout } from 'node:timers';
import { writeSync } from 'node:fs';
import { createHook, executionAsyncId } from 'node:async_hooks';
import { beforeEach, afterEach } from 'node:test';

export const UNIT_FILE_TIMEOUT_MS = 180_000;
const resources = new Map();
const traceHandles = process.env.AITHEMA_UNIT_TRACE_HANDLES === '1';
let currentTest = '<file import>', lastTest = '<none>';

function context() { return `Subtest: ${currentTest}\nLast completed subtest: ${lastTest}\n`; }
function dumpResources() {
  writeSync(2, `Active resources: ${process.getActiveResourcesInfo().join(', ')}\n`);
  for (const [id, entry] of resources) {
    const resource = entry.resource?.deref();
    if (!resource || resource._destroyed || resource.hasRef?.() === false) continue;
    writeSync(2, `Open ${entry.type} ${id}, created in ${entry.test}, delay=${resource._idleTimeout ?? ''}\n${entry.error.stack}\n`);
  }
}

// Observe failures without handling them: Node still fails the test/file. Retain
// the originating subtest without allocating handle stacks by default. Opt-in
// tracing adds creation sites, including timers absent from _getActiveHandles().
if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  beforeEach(t => { currentTest = t.fullName ?? t.name; });
  afterEach(t => { lastTest = t.fullName ?? t.name; currentTest = '<between tests or after hook>'; });
  createHook({
    init(id, type, trigger, resource) {
      if (!['Timeout', 'Immediate', 'MESSAGEPORT', 'TCPWRAP', 'TCPCONNECTWRAP', 'PROCESSWRAP'].includes(type)) return;
      const entry = { test: resources.get(trigger)?.test ?? currentTest };
      if (traceHandles) Object.assign(entry, { type, resource: new WeakRef(resource), error: new Error('Resource created here') });
      resources.set(id, entry);
    },
    destroy(id) { resources.delete(id); },
  }).enable();
  process.on('uncaughtExceptionMonitor', error => {
    const origin = resources.get(executionAsyncId());
    writeSync(2, `Unit uncaught error: ${process.argv[1]}\n${context()}Async origin: ${origin?.test ?? '<unknown>'}\n${error.stack ?? error}\n`);
    if (origin?.error) writeSync(2, `${origin.error.stack}\n`);
  });
}

// Native timer is unaffected by mock timers; unref allows clean workers to exit.
export function armUnitWatchdog(timeoutMs = UNIT_FILE_TIMEOUT_MS) {
  return setTimeout(() => {
    writeSync(2, `Unit file timed out after ${timeoutMs}ms: ${process.argv[1]}\n${context()}`);
    dumpResources();
    process.exit(1);
  }, timeoutMs).unref();
}
if (process.env.NODE_TEST_CONTEXT === 'child-v8') armUnitWatchdog();
