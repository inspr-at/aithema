import { validateManifest } from './plugins.js';
import { isUIArtifact } from './ui-generation.js';
import { PluginError, PLUGIN_ERROR_CODES, isCancelledZeroReport } from './invocation.js';
/** Local-fixture kit only. stallSpec/stallFeedback must stall both operations;
 * requestCount counts outbound dispatches synchronously, including downloads. */
export async function uiGenerationConformance(plugin, { spec, feedback, artifact },
  { timeoutMs = 1000, stallSpec, stallFeedback, requestCount } = {}) {
  const failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
  check(validateManifest(plugin?.manifest).ok && plugin?.manifest?.kinds?.includes('ui-generation') &&
    plugin.manifest.placement === 'server', 'manifest validity');
  check(typeof plugin?.health === 'function', 'health missing');
  check(Boolean(stallSpec) && typeof stallFeedback === 'string', 'stalled fixture missing');
  check(typeof requestCount === 'function', 'fixture request counter missing');
  if (['generate', 'edit', 'health'].some(op => typeof plugin?.[op] !== 'function')) return { ok: false, failures: [...failures, 'ui-generation operations missing'] };
  // The watchdog aborts the actual operation signal as well as bounding broken fixtures.
  async function within(controller, fn) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('conformance timeout')); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  const health = new AbortController();
  try { check((await within(health, () => plugin.health({ signal: health.signal, deadlineAt: Date.now() + timeoutMs })))?.available === true, 'health unavailable'); }
  catch { failures.push('health failed'); } finally { health.abort(); }
  for (const operation of ['generate', 'edit']) {
    for (const mode of ['completed', 'cancelled', 'deadline', 'active-cancelled', 'active-deadline', 'consume-refused']) {
      const controller = new AbortController(), reports = [], attemptId = crypto.randomUUID();
      let consumed = false, refused = false, conflictingReport = false, cancelTimer;
      const before = requestCount?.(), active = mode.startsWith('active-');
      if (mode === 'cancelled') controller.abort();
      const report = terminal => {
        if (reports.length) {
          if (refused && isCancelledZeroReport(terminal, attemptId)) return;
          conflictingReport = true; throw new PluginError('already-claimed');
        }
        reports.push(terminal);
      };
      const options = { signal: controller.signal,
        deadlineAt: Date.now() + (mode === 'deadline' ? -1 : mode === 'active-deadline' ? 30 : timeoutMs),
        attempt: { attemptId, claimId: crypto.randomUUID(), consume() {
          if (requestCount) check(requestCount() === before, `${operation} dispatched before consume`);
          if (mode === 'consume-refused') { refused = true; report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }); throw new PluginError('not-admitted'); }
          if (consumed) throw new PluginError('already-claimed'); consumed = true;
        } }, report };
      try {
        if (mode === 'active-cancelled') cancelTimer = setTimeout(() => controller.abort(), 30);
        const result = await within(controller, () => plugin[operation](operation === 'generate' ? active ? stallSpec : spec : artifact,
          active ? stallFeedback : feedback, options));
        check(mode === 'completed', `${operation} ignored ${mode}`);
        if (mode === 'completed') check(isUIArtifact(result), `${operation} bytes/provenance artifact`);
      } catch (error) {
        check(PLUGIN_ERROR_CODES.includes(error.code), `${operation} error code`);
        if (['cancelled', 'deadline', 'active-cancelled', 'active-deadline'].includes(mode)) check(error.code === mode.replace('active-', ''), `${operation} ${mode} error code`);
        else if (mode === 'consume-refused') check(error.code === 'not-admitted', `${operation} consume-refused error code`);
        else failures.push(`${operation} completed failed`);
      } finally { clearTimeout(cancelTimer); controller.abort(); }
      if (mode === 'consume-refused') {
        check(refused && !consumed, `${operation} consume refusal missing`);
        check(!conflictingReport && reports.length === 1 && isCancelledZeroReport(reports[0], attemptId), `${operation} consume refusal false completion`);
        if (requestCount) check(requestCount() === before, `${operation} dispatched after consume refusal`);
        continue;
      }
      check(consumed, `${operation} claim not consumed`);
      check(!conflictingReport && reports.length === 1, `${operation} ${mode} terminal count`);
      const terminal = reports[0];
      check(terminal?.attemptId === attemptId, `${operation} terminal attempt`);
      check(['completed', 'cancelled', 'uncertain'].includes(terminal?.outcome), `${operation} terminal outcome`);
      if (terminal?.outcome !== 'uncertain') check(terminal?.usage && ['inputTokens', 'outputTokens'].every(k =>
        Number.isSafeInteger(terminal.usage[k]) && terminal.usage[k] >= 0), `${operation} terminal usage`);
      if (mode === 'completed') check(terminal?.outcome === 'completed' || terminal?.outcome === 'uncertain', `${operation} completion outcome`);
      else check(terminal?.outcome !== 'completed', `${operation} false completion`);
      if (['cancelled', 'deadline'].includes(mode)) {
        check(isCancelledZeroReport(terminal, attemptId), `${operation} preflight zero settlement`);
        if (requestCount) check(requestCount() === before, `${operation} preflight dispatch`);
      }
      if (active && requestCount) check(requestCount() > before, `${operation} active fixture did not dispatch`);
    }
  }
  return { ok: failures.length === 0, failures };
}
