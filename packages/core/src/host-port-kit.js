// Shared local-fixture watchdog. Kits are destructive; never run on live ports.
export function hostPortKit(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid conformance timeout');
  const failures = [];
  return { failures, check(ok, message) { if (!ok) failures.push(message); },
    async run(label, fn) {
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('conformance timeout')), timeoutMs);
        })]);
      } catch { failures.push(label); }
      finally { clearTimeout(timer); }
    }, result() { return { ok: failures.length === 0, failures }; } };
}
