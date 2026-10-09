import { validateManifest } from './plugins.js';
import { isUIArtifact } from './ui-generation.js';
import { HTML_MEDIA_TYPE, verifyHTMLArtifact } from './ui-html.js';
import { imageInfo } from './image-info.js';
import { PluginError, PLUGIN_ERROR_CODES, isCancelledZeroReport } from './invocation.js';
/** Local-fixture kit only. stallSpec/stallFeedback must stall both operations;
 * requestCount counts outbound dispatches synchronously, including downloads.
 * expectedUsage, when supplied, is the fixture's known completed-call usage. */
export async function uiGenerationConformance(plugin, { spec, feedback, artifact },
  { timeoutMs = 1000, stallSpec, stallFeedback, requestCount, expectedUsage } = {}) {
  const failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
  check(validateManifest(plugin?.manifest).ok && plugin?.manifest?.kinds?.includes('ui-generation') &&
    plugin.manifest.placement === 'server', 'manifest validity');
  check(typeof plugin?.health === 'function', 'health missing');
  check(Boolean(stallSpec) && typeof stallFeedback === 'string', 'stalled fixture missing');
  check(typeof requestCount === 'function', 'fixture request counter missing');
  if (expectedUsage !== undefined) check(expectedUsage && ['inputTokens', 'outputTokens'].every(k =>
    Number.isSafeInteger(expectedUsage[k]) && expectedUsage[k] >= 0), 'fixture expected usage invalid');
  if (['generate', 'edit', 'health'].some(op => typeof plugin?.[op] !== 'function')) return { ok: false, failures: [...failures, 'ui-generation operations missing'] };
  // The watchdog aborts the actual operation signal as well as bounding broken fixtures.
  async function within(controller, fn) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('conformance timeout')); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  // The artifact kind follows the manifest's declared formats; HTML is checked against its static policy.
  const formats = Array.isArray(plugin?.manifest?.models) ? plugin.manifest.models.flatMap(m => m.formats ?? []) : [];
  async function matchesBytes(result) {
    if (!formats.includes(result?.mediaType)) return false;
    if (result.mediaType === HTML_MEDIA_TYPE) return verifyHTMLArtifact(result);
    if (!isUIArtifact(result)) return false;
    try {
      const info = imageInfo(result.bytes);
      if (info.mediaType !== result.mediaType || info.width !== result.width || info.height !== result.height) return false;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', result.bytes));
      return result.provenance.subject.contentDigest === `sha-256=:${btoa(String.fromCharCode(...digest))}:`;
    } catch { return false; }
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
        const inputSpec = active ? stallSpec : spec, inputFeedback = active ? stallFeedback : feedback;
        const result = await within(controller, () => operation === 'generate' ? plugin.generate(inputSpec, inputFeedback, options) :
          plugin.edit(artifact, inputSpec, inputFeedback, options));
        check(mode === 'completed', `${operation} ignored ${mode}`);
        if (mode === 'completed') check(await matchesBytes(result), `${operation} bytes/provenance artifact`);
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
      if (mode === 'completed' && expectedUsage !== undefined) check(terminal?.outcome === 'completed' &&
        ['inputTokens', 'outputTokens'].every(k => terminal.usage?.[k] === expectedUsage?.[k]), `${operation} expected usage`);
      if (['cancelled', 'deadline'].includes(mode)) {
        check(isCancelledZeroReport(terminal, attemptId), `${operation} preflight zero settlement`);
        if (requestCount) check(requestCount() === before, `${operation} preflight dispatch`);
      }
      if (active && requestCount) check(requestCount() > before, `${operation} active fixture did not dispatch`);
    }
  }
  return { ok: failures.length === 0, failures };
}
