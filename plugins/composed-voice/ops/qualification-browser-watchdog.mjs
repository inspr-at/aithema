import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Call as the browser's OS user, immediately after its detached process group
 * starts. The independent watchdog also survives SIGKILL of the CLI/SSH runner.
 * OPS's ci launcher runs this helper as ci, passing the mba CLI controllerPid. */
export function guardBrowserProcessGroup(pid, { deadlineAt, controllerPid = process.pid } = {}) {
  if (![pid, controllerPid].every(value => Number.isSafeInteger(value) && value > 1) ||
    !Number.isSafeInteger(deadlineAt)) throw new Error('Browser process group and deadline required');
  const watchdog = spawn(process.execPath, [fileURLToPath(import.meta.url), String(pid), String(controllerPid), String(deadlineAt)],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  let failed = false, killed = false;
  watchdog.on('error', () => { failed = true; kill(); });
  watchdog.unref(); watchdog.channel.unref();
  const kill = () => {
    if (killed) return;
    try { process.kill(-pid, 'SIGKILL'); killed = true; }
    catch (error) {
      if (error.code === 'ESRCH') killed = true;
      else throw new Error(`Browser process group kill failed (${error.code ?? 'unknown'})`);
    }
    watchdog.kill('SIGTERM');
  };
  const limitDeadline = async bound => {
    if (!Number.isSafeInteger(bound) || bound > deadlineAt || bound <= Date.now()) throw new Error('Invalid browser duration bound');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Browser duration watchdog unavailable')), 1000);
      const message = value => { if (value?.deadlineAt === bound) finish(); };
      const finish = error => { clearTimeout(timer); watchdog.off('message', message); error ? reject(error) : resolve(); };
      watchdog.on('message', message);
      watchdog.send({ deadlineAt: bound }, error => { if (error) finish(new Error('Browser duration watchdog unavailable')); });
    });
  };
  return { kill, limitDeadline, watchdogArmed: true, get failed() { return failed; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let [pid, controllerPid, deadlineAt] = process.argv.slice(2).map(Number);
  if (![pid, controllerPid, deadlineAt].every(Number.isSafeInteger) || pid <= 1 || controllerPid <= 1) process.exit(2);
  process.on('message', message => {
    if (Number.isSafeInteger(message?.deadlineAt) && message.deadlineAt <= deadlineAt) {
      deadlineAt = message.deadlineAt; process.send?.({ deadlineAt });
    }
  });
  process.channel?.unref();
  const alive = target => {
    try { process.kill(target, 0); return true; }
    catch (error) { return error.code === 'EPERM'; } // Cross-user controller is still alive.
  };
  const timer = setInterval(() => {
    if (!alive(-pid)) { clearInterval(timer); return; }
    if (Date.now() >= deadlineAt || !alive(controllerPid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Group already gone. */ }
      clearInterval(timer);
    }
  }, 100);
}
