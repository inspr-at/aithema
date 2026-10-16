/** Self-contained so Puppeteer can evaluate this exact function in Chrome. */
export async function probeOutputDevice() {
  let context, oscillator;
  const evidence = { verified: false, labelledAudioOutputs: 0, elapsedMs: 0, outputLatency: 0 };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    evidence.labelledAudioOutputs = devices.filter(device => device.kind === 'audiooutput' && device.label.trim()).length;
    context = new AudioContext();
    oscillator = context.createOscillator();
    const silent = context.createGain(); silent.gain.value = 0;
    oscillator.connect(silent).connect(context.destination); oscillator.start();
    await context.resume();
    const started = performance.now();
    evidence.before = context.getOutputTimestamp();
    await new Promise(resolve => setTimeout(resolve, 550));
    evidence.after = context.getOutputTimestamp();
    evidence.elapsedMs = performance.now() - started;
    evidence.outputLatency = context.outputLatency;
    evidence.verified = evidence.labelledAudioOutputs > 0 && evidence.elapsedMs >= 500 &&
      Number.isFinite(evidence.outputLatency) && evidence.outputLatency > 0 &&
      ['contextTime', 'performanceTime'].every(key => Number.isFinite(evidence.before[key]) &&
        Number.isFinite(evidence.after[key]) && evidence.after[key] > evidence.before[key]);
  } catch { evidence.failure = 'Output-device APIs unavailable or refused'; }
  finally { oscillator?.stop(); await context?.close().catch(() => {}); }
  return evidence;
}
