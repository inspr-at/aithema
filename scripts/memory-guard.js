import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// OPS-341 records its SIGTERM after sending it. Only new, exact PID/run matches
// classify a browser exit as infrastructure; unrelated terminations stay errors.
export function memoryGuardEvent({ signal, pid, run, lines }) {
  if (signal !== 'SIGTERM' || !Number.isInteger(pid) || !run) return null;
  return lines.split('\n').find(line => line.includes(`SIGTERM chrome pid ${pid} (${run})`)
    && /\bKILL free=\d+% /u.test(line)) ?? null;
}

export function watchMemoryGuard({ logPath = join(homedir(), 'ci.noindex/mem-guard.log'),
  report = message => { console.error(message); process.exitCode = 1; } } = {}) {
  let offset = 0;
  try { offset = statSync(logPath).size; } catch { /* Not an OPS worker. */ }
  return (child, run) => {
    child.once('exit', (_code, signal) => {
      if (signal !== 'SIGTERM' || !run) return;
      let attempts = 0;
      const check = () => {
        let fd, lines = '';
        try {
          fd = openSync(logPath, 'r');
          const size = fstatSync(fd).size;
          const start = Math.max(size < offset ? 0 : offset, size - 128 * 1024);
          const bytes = Buffer.alloc(size - start);
          readSync(fd, bytes, 0, bytes.length, start);
          lines = bytes.toString();
        } catch { /* Missing or rotating infrastructure log. */ }
        finally { if (fd !== undefined) closeSync(fd); }
        const event = memoryGuardEvent({ signal, pid: child.pid, run, lines });
        if (event) report(`Error: infra: memory guard — browser PID ${child.pid}: ${event}`);
        else if (++attempts < 5) setTimeout(check, 100);
      };
      check();
    });
  };
}
