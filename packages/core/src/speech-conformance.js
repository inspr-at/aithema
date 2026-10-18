import { PluginError, PLUGIN_ERROR_CODES } from './invocation.js';
import { assertSTTComponent, assertTTSComponent, assertComponentUsage, TTS_MESSAGE_BYTES, TTS_SPEAK_BYTES } from './voice-components.js';

/** Offline component kits. Fixtures observe dispatch and resource lifetime independently
 * of component reports, and select normal, stalled, malformed and overflowing wire data. */
export const sttConformance = (component, request, fixtures) => speechConformance('stt', component, request, fixtures);
export const ttsConformance = (component, request, fixtures) => speechConformance('tts', component, request, fixtures);

async function speechConformance(role, component, request, { formats, prepare, requestCount, activeCount, observedMicro,
  expectedText, expectedTranscripts, playback, timeoutMs = 1000, maxMicro = 1_000_000,
  maxInputChunkBytes = 64_000, maxInputBytes = 1_920_000, maxTranscriptCharacters = 32_768, maxChunkBytes = TTS_MESSAGE_BYTES, maxAudioBytes = TTS_SPEAK_BYTES } = {}) {
  const failures = [], check = (condition, rule) => { if (!condition) failures.push(`${role}: ${rule}`); };
  try { (role === 'stt' ? assertSTTComponent : assertTTSComponent)(component); }
  catch { check(false, 'capability declarations/operations'); }
  if (!component || typeof component.negotiateAudioFormat !== 'function' ||
    typeof component[role === 'stt' ? 'transcribe' : 'speak'] !== 'function') return { ok: false, failures };
  if (!Array.isArray(formats) || !formats.length || [prepare, requestCount, activeCount, observedMicro].some(fn => typeof fn !== 'function') ||
    !Number.isFinite(timeoutMs) || timeoutMs < 100 || !Number.isSafeInteger(maxMicro) || maxMicro < 1 ||
    [maxInputChunkBytes, maxInputBytes, maxTranscriptCharacters, maxChunkBytes, maxAudioBytes].some(n => !Number.isSafeInteger(n) || n < 1) ||
    role === 'stt' && (typeof expectedText !== 'string' || !(request?.audio instanceof Uint8Array)) ||
    role === 'tts' && (typeof request?.text !== 'string' || !request.text.length)) {
    return { ok: false, failures: [...failures, `${role}: offline fixtures required`] };
  }
  const bounded = async work => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('conformance timeout')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  const rejects = async (work, code, rule) => {
    try { await bounded(work); check(false, rule); }
    catch (error) { check(error?.code === code, `${rule} (${code})`); }
  };
  const beforeNegotiation = requestCount();
  let selected;
  try {
    selected = await bounded(() => component.negotiateAudioFormat(formats, { deadlineAt: Date.now() + timeoutMs }));
    check(formats.some(format => ['encoding', 'sampleRateHz', 'channels'].every(key => format[key] === selected?.[key])), 'format negotiation selects offered encoding/rate/channels');
    for (const offered of [[], [{ encoding: 'conformance-incompatible', sampleRateHz: 1, channels: 99 }],
      formats.map(format => ({ ...format, sampleRateHz: format.sampleRateHz + 1 })),
      formats.map(format => ({ ...format, channels: 99 }))]) {
      await rejects(() => component.negotiateAudioFormat(offered, {}), 'unavailable', 'format negotiation rejects incompatible offer');
    }
    const abort = new AbortController(); abort.abort();
    await rejects(() => component.negotiateAudioFormat(formats, { signal: abort.signal }), 'cancelled', 'format negotiation cancellation');
    await rejects(() => component.negotiateAudioFormat(formats, { deadlineAt: Date.now() - 1 }), 'deadline', 'format negotiation deadline');
  } catch { check(false, 'format negotiation failed'); }
  check(requestCount() === beforeNegotiation, 'format negotiation dispatches no work');
  if (!selected) return { ok: false, failures };
  const operations = role === 'stt' ? ['transcribe', ...(typeof component.stream === 'function' ? ['stream'] : [])]
    : ['speak', ...(component.capabilities?.heardPrefix === 'aligned' ? ['speakAligned'] : [])];
  if (operations.includes('stream')) check(Array.isArray(expectedTranscripts) && expectedTranscripts.length > 0, 'transcript replacement fixture required');
  if (operations.includes('speakAligned')) check(playback && ['reset', 'deliver', 'confirm', 'heardPrefix'].every(key => typeof playback[key] === 'function'), 'playback-confirmed heard prefix fixture required');
  const attempts = new Set(), claims = new Set();
  for (const operation of operations) {
    const modes = ['completed', 'provider-error', 'retry', ...(role === 'tts' ? ['fragment'] : []),
      'cancelled', 'deadline', 'consume-refused', 'pending-consume', 'active-cancelled', 'active-deadline',
      ...(operation !== 'transcribe' ? ['return'] : []), 'missing-final', 'overflow',
      ...(role === 'tts' ? ['overflow-total'] : ['overflow-input', ...(operation === 'stream' ? ['overflow-input-total'] : [])]), 'over-ceiling', 'report-rejected'];
    for (const mode of modes) {
      const label = `${operation}/${mode}`, abort = new AbortController(), reports = [];
      const reportError = new Error('Synthetic report rejection');
      let consumed = 0, settledConsume = false, iterator, sourceReturned = false, sourceOpened = false, bytes = 0, finalCount = 0, previousEnd = 0;
      let error, cancelTimer, reportCalls = 0, textEvents = [], successful = false;
      const input = { ...request, format: selected.encoding };
      if (mode === 'fragment') input.text = [...request.text].slice(0, Math.max(1, Math.floor([...request.text].length / 2))).join('');
      if (mode === 'overflow-input') input.audio = new Uint8Array(maxInputChunkBytes + 2);
      const sourceAudio = input.audio;
      if (operation === 'stream') input.audio = { [Symbol.asyncIterator]() {
        sourceOpened = true; let sent = 0;
        const count = mode === 'overflow-input-total' ? Math.floor(maxInputBytes / maxInputChunkBytes) + 1 : 1;
        return { async next() { if (sent++ >= count) return { done: true };
          return { value: mode === 'overflow-input-total' ? new Uint8Array(maxInputChunkBytes) : sourceAudio, done: false }; },
          async return() { sourceReturned = true; return { done: true }; } };
      } };
      try { await bounded(() => prepare({ role, operation, mode, request: input })); }
      catch { check(false, `${label} fixture preparation`); continue; }
      const before = requestCount(), attemptId = crypto.randomUUID(), claimId = crypto.randomUUID();
      check(!attempts.has(attemptId) && !claims.has(claimId), `${label} fresh retry/fragment claims`);
      attempts.add(attemptId); claims.add(claimId);
      if (mode === 'cancelled') abort.abort();
      const options = { signal: abort.signal, deadlineAt: Date.now() + (mode === 'deadline' ? -1 : mode === 'active-deadline' ? Math.min(100, timeoutMs / 2) : timeoutMs),
        attempt: { attemptId, claimId, maxMicro: mode === 'over-ceiling' ? 1 : maxMicro, async consume() {
          consumed++;
          check(consumed === 1, `${label} fresh retry/fragment claims: consume once`);
          check(requestCount() === before, `${label} consume-before-dispatch`);
          await Promise.resolve();
          check(requestCount() === before, `${label} consume-before-dispatch while pending`);
          if (mode === 'consume-refused') throw new PluginError('not-admitted');
          if (mode === 'pending-consume') { abort.abort(); await new Promise(resolve => setTimeout(resolve, 5)); }
          settledConsume = true;
        } }, async report(terminal) {
          reportCalls++; reports.push(structuredClone(terminal));
          if (mode === 'report-rejected') throw reportError;
        } };
      const consume = async () => {
        if (operation === 'transcribe') {
          const result = await component.transcribe(input, options);
          check(typeof result?.text === 'string', `${label} transcript text`);
          check(result?.text?.length <= maxTranscriptCharacters, `${label} stream bounds: transcript characters`);
          if (['completed', 'retry'].includes(mode)) check(result?.text === expectedText, `${label} transcript finality/text`);
        } else {
          iterator = component[operation](input, options)[Symbol.asyncIterator]();
          if (operation === 'speakAligned' && playback) await playback.reset(input);
          for (;;) {
            const item = await iterator.next(); if (item.done) break;
            if (operation === 'stream') {
              const event = item.value;
              check(typeof event?.text === 'string' && typeof event.final === 'boolean', `${label} transcript shape`);
              check(!finalCount, `${label} transcript finality: event after final`);
              check(event?.text?.length <= maxTranscriptCharacters, `${label} stream bounds: transcript characters`);
              if (event?.final) finalCount++;
              if (event?.final === false) check(component.capabilities?.partialTranscripts !== false, `${label} partial transcript declaration`);
              textEvents.push(event);
            } else {
              const audio = operation === 'speakAligned' ? item.value?.audio : item.value;
              check(audio instanceof Uint8Array && audio.byteLength > 0, `${label} audio chunk type`);
              if (!(audio instanceof Uint8Array) || !audio.byteLength) throw new PluginError('invalid-output');
              bytes += audio?.byteLength ?? 0;
              check(audio?.byteLength <= maxChunkBytes && bytes <= maxAudioBytes, `${label} stream bounds: audio bytes`);
              const frameBytes = selected.encoding === 'pcm_f32le' ? 4 : selected.encoding === 'pcm_s16le' ? 2 : 1;
              check(audio?.byteLength % (frameBytes * selected.channels) === 0, `${label} negotiated audio framing`);
              if (operation === 'speakAligned') {
                const end = item.value?.textEnd;
                check(Number.isSafeInteger(end) && end >= previousEnd && end <= input.text.length && end >= 0 &&
                  !(end > 0 && end < input.text.length && /[\uD800-\uDBFF]/u.test(input.text[end - 1]) && /[\uDC00-\uDFFF]/u.test(input.text[end])), `${label} aligned offsets`);
                if (playback) {
                  const heard = await playback.heardPrefix();
                  await playback.deliver(item.value);
                  check(await playback.heardPrefix() === heard, `${label} playback-confirmed heard prefixes: delivery is not playback`);
                  await playback.confirm(bytes - 1);
                  check(await playback.heardPrefix() === heard, `${label} playback-confirmed heard prefixes: whole chunk required`);
                  await playback.confirm(bytes);
                  check(await playback.heardPrefix() === input.text.slice(0, end), `${label} playback-confirmed heard prefixes`);
                }
                previousEnd = end;
              }
            }
            // Stop a malicious infinite producer as soon as it violates the bound.
            if (bytes > maxAudioBytes || textEvents.length > maxTranscriptCharacters || textEvents.at(-1)?.text?.length > maxTranscriptCharacters) {
              check(false, `${label} stream bounds`); await iterator.return?.(); break;
            }
            if (mode === 'return') { await iterator.return?.(); break; }
          }
          if (['completed', 'retry', 'fragment'].includes(mode)) {
            if (operation === 'stream') {
              check(finalCount === 1, `${label} transcript finality: exactly one final`);
              check(JSON.stringify(textEvents) === JSON.stringify(expectedTranscripts), `${label} transcript replacement hypotheses`);
            } else check(bytes > 0, `${label} nonempty audio`);
          }
        }
        successful = true;
      };
      try {
        // Stalled fixtures ignore signals themselves; only the component can stop them.
        if (mode === 'active-cancelled') cancelTimer = setTimeout(() => abort.abort(), Math.min(50, timeoutMs / 4));
        await bounded(consume);
      } catch (caught) { error = caught; }
      finally {
        clearTimeout(cancelTimer);
        // Inspect settlement BEFORE harness abort, which must not repair missing terminals.
        check(reportCalls === 1 && reports.length === 1, `${label} once-only terminal settlement before exhaustion/rejection`);
        abort.abort();
        if (iterator?.return) { try { await bounded(() => iterator.return()); } catch { check(false, `${label} cancellation cleanup: iterator return`); } }
      }
      check(activeCount() === 0, `${label} cancellation cleanup: provider still active`);
      if (operation === 'stream' && sourceOpened) check(sourceReturned, `${label} cancellation cleanup: audio source return`);
      check(reportCalls === 1, `${label} once-only terminal settlement after cleanup`);
      const noDispatch = ['cancelled', 'deadline', 'consume-refused', 'pending-consume'].includes(mode);
      if (noDispatch) check(requestCount() === before, `${label} consume-before-dispatch: preflight/refusal`);
      else if (mode !== 'over-ceiling') check(requestCount() === before + 1 && settledConsume, `${label} consume-before-dispatch: one dispatch per fresh claim`);
      if (!['cancelled', 'deadline'].includes(mode)) check(consumed === 1, `${label} fresh retry/fragment claims: consumed`);
      if (['completed', 'retry', 'fragment', 'return'].includes(mode)) check(successful && !error, `${label} operation failed`);
      else {
        check(Boolean(error), `${label} ignored ${mode === 'missing-final' ? 'transcript/synthesis finality' : mode.startsWith('overflow') ? 'stream bounds' : mode}`);
        if (error) {
          const code = ['cancelled', 'active-cancelled', 'pending-consume'].includes(mode) ? 'cancelled'
            : ['deadline', 'active-deadline'].includes(mode) ? 'deadline' : mode === 'consume-refused' ? 'not-admitted' : undefined;
          check(mode === 'report-rejected' ? error === reportError : code ? error.code === code : PLUGIN_ERROR_CODES.includes(error.code), `${label} ${mode === 'report-rejected' ? 'report rejection propagates' : `typed ${code ?? 'provider'} error`}`);
          if (mode === 'over-ceiling') check(['limit', 'not-admitted'].includes(error.code), `${label} terminal accounting: over-ceiling usage rejected`);
        }
      }
      const terminal = reports[0];
      check(terminal?.attemptId === attemptId, `${label} terminal accounting: attempt identity`);
      check(['completed', 'cancelled', 'uncertain'].includes(terminal?.outcome), `${label} terminal accounting: outcome`);
      if (terminal?.usage) {
        try { assertComponentUsage(terminal.usage); } catch { check(false, `${label} terminal accounting: usage`); }
        check(terminal.usage.attemptId === attemptId && terminal.usage.role === role, `${label} terminal accounting: usage identity/role`);
      }
      if (terminal?.outcome !== 'uncertain') check(Boolean(terminal?.usage), `${label} terminal accounting: usage required`);
      if (noDispatch) check(terminal?.outcome === 'cancelled' && terminal.chargedMicro === 0 && terminal.usage?.quantity === 0 && terminal.usage?.upstreamMicro === 0, `${label} terminal accounting: undispatched zero`);
      else if (['completed', 'retry', 'fragment', 'report-rejected'].includes(mode)) check(terminal?.outcome === 'completed', `${label} terminal accounting: completion evidence`);
      else if (mode !== 'over-ceiling' || requestCount() > before) check(terminal?.outcome === 'uncertain', `${label} terminal accounting: missing completion retains uncertainty`);
      if (terminal?.outcome === 'uncertain') check(Number.isSafeInteger(terminal.chargedMicro) &&
        terminal.chargedMicro >= Math.max(options.attempt.maxMicro, observedMicro()), `${label} terminal accounting: uncertain >= max(maxMicro, observed)`);
      if (terminal?.outcome === 'completed') check(terminal.chargedMicro === undefined || terminal.chargedMicro === terminal.usage?.upstreamMicro, `${label} terminal accounting: completed charge`);
    }
  }
  return { ok: failures.length === 0, failures };
}
