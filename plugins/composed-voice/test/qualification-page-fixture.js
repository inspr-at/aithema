import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { installQualificationOutputProbe, qualificationObservationWindow } from '../ops/qualification-output-timing.js';

// Execute the real page harness with fake media ports, so refusal returned from
// page.evaluate retains the trace rather than throwing past the run coordinator.
export async function pageFixture(reason, { type = 'waiting', firstAudio = false, bargeIn = false, sourceRefusal, sourceFailure,
  missingDiagnostics = false, closeError = false, productStop = false, productError = false, stopBeforeSource = false, errorAfterStop = false, lateEvents = [], teardownStop = false, silentOutput = true, outputTrace, explicitStop = true, stopRequestedAt = 850, deadlineSeconds = 60, deadlineElapsedMs = 0, firstAudioAt = 10, bargeInAt = 810 } = {}) {
  const source = (await readFile(new URL('../ops/qualification-page.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gmu, '');
  let onTiming, onRendered, sourceTiming, started = false, connected = false, closed = false, interrupts = 0, inputChanges = 0;
  const timers = [], order = []; let fenced = false;
  const stopInput = () => { fenced = true; order.push('input-fence'); };
  const measurementTerminal = async () => { order.push('server-fence'); };
  const runtime = { qualificationMeasurementTerminal: measurementTerminal, qualificationObservationWindow, installQualificationOutputProbe: () => runtime.qualificationOutputProbe,
    AudioNode: class { connect() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return setTimeout(fn, ms); }, clearTimeout,
    createPCMPlayer(options) { onTiming = options.onTiming; options.observeOutput({}); return { async close() {} }; },
    createPCMCapture: () => {}, createNetworkRelayClient: () => {},
    createComposedBrowserMedia: () => ({ async connect() {
      connected = true;
      return { events: (async function* () {
        if (stopBeforeSource) render();
        if (bargeIn) {
          sourceTiming({ kind: 'capture', captureAt: bargeInAt, voiced: true, durationMs: 64 });
          assert.equal(interrupts, 0, 'source observation cannot interrupt');
          assert.equal(inputChanges, 0, 'capture stays open for product VAD');
        }
        if (productError) throw new Error('product event exception');
        if (productStop) {
          if (explicitStop) onTiming({ kind: 'playback-stop', requestedAt: stopRequestedAt, stoppedAt: stopRequestedAt, origin: teardownStop ? 'teardown' : 'interrupt' });
          if (!stopBeforeSource) render();
          if (errorAfterStop) yield { type: 'ended', reason: 'closure-uncertain' };
          for (const event of lateEvents) {
            assert.equal(fenced, true, 'input fenced before another product event');
            assert.ok(order.includes('session-close'), 'session close already initiated');
            yield event;
          }
        }
        if (!productStop || teardownStop || !silentOutput) yield { type, reason };
      })(), async interrupt() { interrupts++; }, async setInput() { inputChanges++; },
        async close() { order.push('session-close'); if (closeError) throw new Error('close failed'); } };
    } }),
    qualificationScriptedCapture: { stopInput, subscribe(fn) { sourceTiming = fn; return () => {}; },
      diagnostics() { return missingDiagnostics ? undefined : { started, barged: firstAudio, failure: sourceFailure, refusal: sourceRefusal }; },
      startUtterance() {
        assert.equal(connected, true); started = true;
        sourceTiming({ kind: 'capture', captureAt: 1, voiced: true, durationMs: 4 });
        onTiming({ kind: 'playback-scheduled', scheduledAt: 10 });
        if (firstAudio) onTiming({ kind: 'playback-start', firstAudioAt });
      }, firstAudio() {
        if (sourceRefusal || sourceFailure) sourceTiming({ kind: 'capture-outcome',
          status: sourceFailure ? 'error' : 'refused', reason: sourceFailure || sourceRefusal });
      }, async close() { closed = true; } },
  };
  runtime.window = runtime;
  runInNewContext(`(${installQualificationOutputProbe.toString()})()`, runtime);
  runtime.qualificationOutputProbe.tap = (_source, callback) => { onRendered = callback; };
  const render = () => {
    const blocks = outputTrace ?? [{ at: firstAudioAt, durationMs: 20, rms: .2, voiced: true },
      ...Array.from({ length: 50 }, (_, i) => ({ at: 910 + i * 20, durationMs: 20, rms: silentOutput ? 0 : .2, voiced: !silentOutput,
        timestamp: { contextTime: (930 + i * 20) / 1000, performanceTime: 930 + i * 20 } }))];
    for (const block of blocks) onRendered(block);
  };
  runInNewContext(source, runtime);
  return { run: () => runtime.composedQualification.run({ grant: { opaque: { spendDeadlineAt: Date.now() + deadlineSeconds * 1000 - deadlineElapsedMs } }, headers: {} }), timers, order, state: () => ({ started, closed, interrupts, inputChanges }) };
}
