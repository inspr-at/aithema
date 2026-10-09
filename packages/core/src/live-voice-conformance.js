import { validateManifest } from './plugins.js';
import { PluginError, PLUGIN_ERROR_CODES } from './invocation.js';
import { LIVE_VOICE_COMMANDS, assertVoiceSession, assertVoiceEvent, voiceOperation } from './live-voice.js';

/** Local joined fixture. probe/providerOpen independently observe closure; drive supplies fixture events. */
export async function liveVoiceConformance(plugin, request, { requestCount, probe, providerOpen, drive, persistedEvents, timeoutMs = 1000 } = {}) {
  const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
  const valid = validateManifest(plugin?.manifest).ok && plugin?.manifest?.kinds?.includes('live-voice');
  check(valid, 'manifest validity');
  if (!valid) return { ok: false, failures };
  if (!plugin?.start || !plugin?.health || !requestCount || !probe || !drive) return { ok: false, failures: [...failures, 'live voice fixtures missing'] };
  const contract = plugin.manifest.liveVoice;
  check(contract.transcript.persistence !== 'durable' || typeof persistedEvents === 'function', 'durable transcript observation missing');
  try { check((await voiceOperation({ deadlineAt: Date.now() + timeoutMs }, opts => plugin.health(opts)))?.available === true, 'health unavailable'); }
  catch { failures.push('health failed'); }
  for (const mode of ['completed', 'cancelled', 'deadline', 'consume-refused', 'active-cancelled', 'spend-deadline', 'browser-liveness-deadline']) {
    const reports = [], events = [], controller = new AbortController();
    const before = requestCount(); let consumed = false, session, consumer;
    const persistedBefore = persistedEvents?.().length ?? 0;
    const attemptId = crypto.randomUUID(), claimId = crypto.randomUUID();
    const options = { signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? -1 : timeoutMs),
      spendDeadlineAt: Date.now() + (mode === 'spend-deadline' ? 40 : timeoutMs),
      browserLivenessDeadlineAt: Date.now() + (mode === 'browser-liveness-deadline' ? 40 : timeoutMs),
      attempt: { attemptId, claimId, maxMicro: 1_000_000, consume() {
        check(requestCount() === before, 'dispatched before consume');
        if (mode === 'consume-refused') {
          reports.push({ attemptId, outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0 }); throw new PluginError('not-admitted');
        }
        if (consumed) throw new PluginError('already-claimed'); consumed = true;
      } }, report: terminal => { reports.push(terminal); } };
    if (mode === 'cancelled') controller.abort();
    try {
      session = await voiceOperation({ deadlineAt: Date.now() + timeoutMs }, () => plugin.start(request, options));
      assertVoiceSession(session);
      consumer = (async () => { for await (const event of session.events) { assertVoiceEvent(event); events.push(event); } })();
      if (mode === 'completed') {
        check(session.callId === request.callId, 'stable call identity');
        const values = { setInput: false, setOutput: false, sendText: 'typed fixture', updateContext: { focus: 'fixture' } };
        // send/context first; pause/resume are deliberate separate transitions.
        for (const command of ['sendText', 'updateContext', 'setInput', 'setOutput', 'pause', 'resume', 'interrupt']) {
          const declared = contract.capabilities[command]; let result, rejected = false;
          if (command === 'interrupt' && declared !== 'unavailable' && contract.capabilities.setInput !== 'unavailable') await session.setInput(true);
          const beforeEffect = await probe(command, session, { phase: 'before' });
          try {
            const pending = voiceOperation({ deadlineAt: Date.now() + timeoutMs }, opts =>
              ['setInput', 'setOutput', 'sendText', 'updateContext'].includes(command) ? session[command](values[command], opts) : session[command](opts));
            if (command === 'interrupt' && declared !== 'unavailable') await drive(session, { command: 'interrupt' });
            result = await pending;
          }
          catch (error) {
            rejected = true;
            check(declared === 'unavailable' && error.code === 'unavailable' && error.message.includes(command), `${command} clear unavailable error`);
          }
          if (declared === 'unavailable') check(rejected, `${command} unavailable command accepted`);
          else {
            check(!rejected, `${command} claimed capability failed`);
            if (['pause', 'resume'].includes(command)) check(result?.acknowledged === true, `${command} not acknowledged`);
          }
          const effect = await probe(command, session, { phase: 'after', before: beforeEffect });
          check(effect.capability === declared && effect.applied === (declared !== 'unavailable'), `${command} capability differs from behaviour`);
        }
        const expected = await drive(session);
        const closure = await session.close({ deadlineAt: Date.now() + timeoutMs });
        check(closure?.closureConfirmed === true, 'provider closure confirmation missing');
        await voiceOperation({ deadlineAt: Date.now() + timeoutMs }, () => consumer);
        const actual = events.filter(event => ['partial', 'final', 'heard'].includes(event.type));
        check(JSON.stringify(actual) === JSON.stringify(expected), 'fabricated or missing transcript/heard event');
        if (contract.transcript.persistence === 'durable') check(JSON.stringify(persistedEvents?.().slice(persistedBefore)) ===
          JSON.stringify(expected.filter(event => ['final', 'heard'].includes(event.type))), 'durable transcript/heard persistence differs from events');
        check(!actual.some(event => event.type === 'heard') || contract.capabilities.heard !== 'unavailable', 'unavailable heard event fabricated');
        check(actual.filter(event => event.type === 'final').length > 0 || contract.transcript.finality !== 'turns', 'declared final turns missing');
      } else if (['active-cancelled', 'spend-deadline', 'browser-liveness-deadline'].includes(mode)) {
        if (mode === 'active-cancelled') controller.abort();
        await voiceOperation({ deadlineAt: Date.now() + timeoutMs }, () => consumer);
        check(events.some(event => event.type === 'ended'), `${mode} missing ended event`);
      } else failures.push(`ignored ${mode}`);
    } catch (error) {
      check(PLUGIN_ERROR_CODES.includes(error.code), `${mode} error code`);
      if (['cancelled', 'deadline', 'consume-refused'].includes(mode)) check(error.code === (mode === 'consume-refused' ? 'not-admitted' : mode), `${mode} wrong error`);
      else failures.push(`${mode} failed`);
    } finally {
      if (session) { try { await session.close({ deadlineAt: Date.now() + timeoutMs }); } catch {} }
      controller.abort();
    }
    if (requestCount() > before) {
      let observedClosed = false;
      try {
        observedClosed = await voiceOperation({ deadlineAt: Date.now() + timeoutMs }, async () => typeof providerOpen === 'function'
          ? await providerOpen(session, { mode }) === false
          : (await probe('close', session, { phase: 'after', mode }))?.providerOpen === false);
      } catch { /* Missing, failed or timed-out fixture observations must fail closed. */ }
      check(observedClosed, `${mode} provider still open or closure observation missing`);
    }
    check(consumed === (mode !== 'consume-refused'), `${mode} claim consumption`);
    check(reports.length === 1 && reports[0]?.attemptId === attemptId, `${mode} terminal count/identity`);
    check(['completed', 'cancelled', 'uncertain'].includes(reports[0]?.outcome), `${mode} terminal outcome`);
    if (session) check(reports[0]?.providerSessionId === session.providerSessionId, `${mode} terminal provider identity`);
    if (reports[0]?.outcome !== 'uncertain') check(reports[0]?.usage &&
      ['providerSeconds', 'providerMinutes', 'pausedSeconds', 'visitorSeconds'].every(key => Number.isFinite(reports[0].usage[key]) && reports[0].usage[key] >= 0) &&
      ['upstreamMicro', 'visitorMicro'].every(key => Number.isSafeInteger(reports[0].usage[key]) && reports[0].usage[key] >= 0)
      || mode === 'consume-refused', `${mode} terminal usage`);
    if (['cancelled', 'deadline', 'consume-refused'].includes(mode)) {
      check(requestCount() === before, `${mode} dispatched`);
      check(reports[0]?.outcome === 'cancelled' && reports[0]?.chargedMicro === 0, `${mode} preflight charge`);
    }
    if (reports[0]?.outcome !== 'uncertain') check(reports[0]?.closureConfirmed === true, `${mode} terminal did not confirm provider closure`);
    if (mode !== 'completed') check(reports[0]?.outcome !== 'completed', `${mode} false completion`);
    if (reports[0]?.outcome === 'uncertain') check(reports[0]?.chargedMicro === options.attempt.maxMicro, 'uncertain not charged at claim maximum');
  }
  check(LIVE_VOICE_COMMANDS.every(command => command === 'close' || Object.hasOwn(contract.capabilities, command)), 'command declarations missing');
  return { ok: failures.length === 0, failures };
}
