import { validateManifest } from './plugins.js';
export { extractorConformance } from './extractor-conformance.js';
export { assertExtractor, createExtractor, isExtraction, sniffDocument, sniffUploadMime, EXTRACTOR_LIMITS, UPLOAD_LIMITS, EXTRACTOR_MEDIA_TYPES, TEXT_MEDIA_TYPES } from './extractor.js';
export { uiGenerationConformance } from './ui-generation-conformance.js';
import { matchesSchema, operationScope } from './reasoning.js';
import { PLUGIN_ERROR_CODES, PluginError, isCancelledZeroReport } from './invocation.js';
export { liveVoiceConformance } from './live-voice-conformance.js';
// Portable executable reasoning kit. No provider calls are built into the kit;
// adapters supply their local fixtures and a request valid for their schema.
export async function reasoningConformance(plugin, request, { timeoutMs = 1000, stallRequest, requestCount } = {}) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(validateManifest(plugin?.manifest).ok, 'manifest validity');
  check(typeof plugin?.health === 'function', 'health missing');
  check(plugin?.billable === false || Boolean(stallRequest), 'stalled structured fixture missing');
  check(plugin?.billable === false || typeof requestCount === 'function', 'fixture request counter missing');
  if (!plugin?.stream || !plugin?.structured) return { ok: false, failures: [...failures, 'reasoning operations missing'] };
  const within = async fn => {
    const scope = operationScope({ deadlineAt: Date.now() + timeoutMs }); let listener;
    try {
      const timed = new Promise((_, reject) => { listener = () => reject(new Error('conformance timeout'));
        scope.signal.addEventListener('abort', listener, { once: true }); });
      return await Promise.race([fn(scope.signal), timed]);
    } finally { scope.signal.removeEventListener('abort', listener); scope.dispose(); }
  };
  try { check((await within(signal => plugin.health({ signal, deadlineAt: Date.now() + timeoutMs })))?.available === true, 'health unavailable'); }
  catch { failures.push('health failed'); }
  for (const operation of ['stream', 'structured']) {
    for (const mode of ['completed', 'cancelled', 'deadline', ...(operation === 'stream' ? ['return'] : []),
      ...(operation === 'stream' || stallRequest ? ['active-cancelled', 'active-deadline'] : []), 'consume-refused']) {
      const controller = new AbortController(), reports = [];
      if (mode === 'cancelled') controller.abort();
      let burned = false, refused = false, conflictingReport = false;
      const beforeRequests = requestCount?.();
      const active = mode.startsWith('active-'), input = active && stallRequest ? stallRequest : request;
      let cancelTimer;
      const attemptId = crypto.randomUUID();
      const report = terminal => {
        if (reports.length) {
          if (refused && isCancelledZeroReport(terminal, attemptId)) return;
          conflictingReport = true; throw new PluginError('already-claimed');
        }
        reports.push(terminal);
      };
      const options = { signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? -1 : mode === 'active-deadline' ? 30 : timeoutMs),
        attempt: { attemptId, claimId: crypto.randomUUID(), consume() {
          if (requestCount) check(requestCount() === beforeRequests, `${operation} dispatched before consume`);
          if (mode === 'consume-refused') {
            refused = true;
            report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
            throw new PluginError('not-admitted');
          }
          if (burned) throw new Error('claim reused'); burned = true;
        } },
        report };
      try {
        await within(async () => {
          if (operation === 'stream') {
            let text = ''; for await (const delta of plugin.stream(input, options)) {
              check(typeof delta === 'string', 'stream delta type'); text += delta;
              if (mode === 'return') break;
              if (mode === 'active-cancelled') controller.abort();
              if (mode === 'active-deadline') await new Promise(resolve => setTimeout(resolve, 35));
            }
            if (mode === 'completed') check(text.length > 0, 'stream empty');
          } else {
            if (mode === 'active-cancelled') cancelTimer = setTimeout(() => controller.abort(), 30);
            const result = await plugin.structured(input, options);
            if (mode === 'completed') check(matchesSchema(result, request.schema), 'structured schema');
          }
          check(!['cancelled', 'deadline', 'active-cancelled', 'active-deadline', 'consume-refused'].includes(mode), `${operation} ignored ${mode}`);
        });
      } catch (error) {
        check(PLUGIN_ERROR_CODES.includes(error.code), `${operation} error code`);
        if (['cancelled', 'deadline', 'active-cancelled', 'active-deadline'].includes(mode)) check(error.code === mode.replace('active-', ''), `${operation} ${mode} error code`);
        else if (mode === 'consume-refused') check(error.code === 'not-admitted', `${operation} consume-refused error code`);
        else failures.push(`${operation} ${mode} failed`);
      }
      finally { clearTimeout(cancelTimer); controller.abort(); }
      if (mode === 'consume-refused') {
        check(refused && !burned, `${operation} consume refusal missing`);
        check(!conflictingReport && reports.length === 1 && isCancelledZeroReport(reports[0], attemptId), `${operation} consume refusal false completion`);
        if (requestCount) check(requestCount() === beforeRequests, `${operation} dispatched after consume refusal`);
        continue; // The authority settles before throwing, even when the plugin has no invocation to report.
      }
      check(burned, `${operation} claim not consumed`);
      check(reports.length === 1, `${operation} ${mode} terminal count`);
      const terminal = reports[0];
      check(terminal?.attemptId === attemptId, `${operation} terminal attempt`);
      check(['completed', 'cancelled', 'uncertain'].includes(terminal?.outcome), `${operation} terminal outcome`);
      if (terminal?.outcome !== 'uncertain') check(terminal?.usage && Number.isSafeInteger(terminal.usage.inputTokens) &&
        terminal.usage.inputTokens >= 0 && Number.isSafeInteger(terminal.usage.outputTokens) && terminal.usage.outputTokens >= 0, `${operation} terminal usage`);
      if (mode !== 'completed') check(terminal?.outcome !== 'completed', `${operation} false completion`);
    }
  }
  return { ok: failures.length === 0, failures };
}
