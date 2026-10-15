import { access, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// mkdir is atomic across Node workers. Never steal an old lock: a slow download
// still owns it. A terminated installer leaves a visible, actionable timeout.
export async function installOnce({ executable, lockPath, install, timeoutMs = 300_000, pollMs = 100 }) {
  const ready = () => access(executable, constants.X_OK).then(() => true, () => false);
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try { await mkdir(lockPath); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for browser install lock: ${lockPath}`);
      await delay(pollMs); continue;
    }
    try {
      if (!await ready()) await install();
      await access(executable, constants.X_OK);
      return;
    } finally { await rm(lockPath, { recursive: true }); }
  }
}
