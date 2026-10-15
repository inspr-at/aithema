// OPS-341 records its SIGTERM after sending it. Only new, exact PID/run matches
// classify a browser exit as infrastructure; unrelated terminations stay errors.
export function memoryGuardEvent({ signal, pid, run, lines }) {
  if (signal !== 'SIGTERM' || !Number.isInteger(pid) || !run) return null;
  return lines.split('\n').find(line => line.includes(`SIGTERM chrome pid ${pid} (${run})`)
    && /\bKILL free=\d+% /u.test(line)) ?? null;
}
