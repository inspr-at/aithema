import { setTimeout } from 'node:timers';
import { writeSync } from 'node:fs';

export const UNIT_FILE_TIMEOUT_MS = 180_000;

// --test-timeout bounds test execution, but Node 24 can still wait indefinitely
// for a worker's open handles or after hook. Start before the file is imported,
// using a native timer unaffected by the file's later mock timers. unref keeps
// normally cleaned-up workers free to exit immediately.
export function armUnitWatchdog(timeoutMs = UNIT_FILE_TIMEOUT_MS) {
  return setTimeout(() => {
    writeSync(2, `Unit file timed out after ${timeoutMs}ms: ${process.argv[1]}\nActive resources: ${process.getActiveResourcesInfo().join(', ')}\n`);
    process.exit(1);
  }, timeoutMs).unref();
}

// A fresh deadline for each worker, rather than one for the whole suite.
if (process.env.NODE_TEST_CONTEXT === 'child-v8') armUnitWatchdog();
