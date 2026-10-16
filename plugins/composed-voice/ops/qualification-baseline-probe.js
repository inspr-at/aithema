/** Injected with evaluateOnNewDocument. No secrets, expected text or product
 * imports. Observe the production graph and final-user persistence unchanged.
 * PCM/trace bounds: qualification-live-server.mjs / live-qualification.js.
 * RMS .015: browser-audio.js. 1024 frames: ScriptProcessor's supported size,
 * chosen for ~21 ms output observations at 48 kHz, not a quality threshold. */
export function installBaselineProbe() {
  const trace = [], pcm = [], contexts = new Set();
  let responseReady = false, agentSink;
  let armed = false, bytes = 0, format, hypothesis, firstAudioAt, bargeInAt, stoppedAt, failure;
  const emit = event => { if (trace.length >= 100_000) failure = true; else trace.push(event); };
  const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const sinks = new WeakMap(), tapped = new WeakSet();
  function output(source, volume = () => 1) {
    const context = source.context;
    let sink = sinks.get(context);
    if (!sink) {
      sink = context.createScriptProcessor(1024, 1, 1);
      const pending = []; let observer;
      const observe = () => {
        clearTimeout(observer);
        if (!armed || failure) return;
        const timestamp = context.getOutputTimestamp();
        while (pending.length && timestamp.performanceTime > 0 && timestamp.contextTime >= pending[0].time) {
          const { samples, time } = pending.shift();
          rendered(samples, timestamp.performanceTime + (time - timestamp.contextTime) * 1000, timestamp);
        }
        // Same 10 ms rendered-clock observation interval as browser-audio.js.
        if (pending.length) observer = setTimeout(observe, 10);
      };
      const rendered = (samples, at, timestamp) => {
        const voiced = rms(samples) >= 0.015;
        if (agentSink && agentSink !== sink) return;
        if (voiced) {
          if (firstAudioAt === undefined) {
            agentSink = sink; firstAudioAt = at;
            emit({ kind: 'playback-start', firstAudioAt, outputTimestamp: timestamp });
          }
          if (format && format.sampleRateHz !== context.sampleRate) { failure = true; return; }
          format = { encoding: 'pcm_f32le', sampleRateHz: context.sampleRate, channels: 1 };

        } else if (firstAudioAt !== undefined && bargeInAt !== undefined && at >= bargeInAt && stoppedAt === undefined) {
          stoppedAt = at;
          emit({ kind: 'playback-stop', stoppedAt, outputTimestamp: timestamp });
        }
        if (firstAudioAt !== undefined && stoppedAt === undefined) {
          bytes += samples.byteLength;
          if (bytes > 16_000_000) { failure = true; return; }
          pcm.push(Float32Array.from(samples));
        }
      };
      sink.onaudioprocess = event => {
        if (!armed || failure || !hypothesis || !responseReady) return; // Exclude the production opener.
        if (pending.length * 1024 / context.sampleRate >= 8) { failure = true; return; } // browser-audio.js maxQueuedSeconds.
        pending.push({ samples: Float32Array.from(event.inputBuffer.getChannelData(0), value => value * volume()),
          time: event.playbackTime - event.inputBuffer.duration });
        observe();
      };
      const silence = context.createGain(); silence.gain.value = 0;
      nativeConnect.call(sink, silence); nativeConnect.call(silence, context.destination);
      sinks.set(context, sink);
    }
    nativeConnect.call(source, sink);
  }
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = nativeConnect.call(this, destination, ...args);
    if (armed && destination === this.context.destination && !tapped.has(this)) { tapped.add(this); output(this); }
    return result;
  };
  // WebRTC SDK output uses HTMLAudioElement.srcObject. Observe its track in a
  // silent parallel Web Audio graph; retain the element's actual volume gate.
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    if (armed && this.srcObject instanceof MediaStream && !tapped.has(this)) {
      tapped.add(this);
      const context = new AudioContext(); contexts.add(context);
      output(context.createMediaStreamSource(this.srcObject), () => this.muted ? 0 : this.volume);
      void context.resume();
    }
    return nativePlay.apply(this, args);
  };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await getUserMedia(constraints);
    if (armed && constraints?.audio && !tapped.has(stream)) {
      tapped.add(stream);
      const context = new AudioContext({ sampleRate: 16000 }); contexts.add(context);
      const source = context.createMediaStreamSource(stream), sink = context.createScriptProcessor(1024, 1, 1);
      let frames = 0;
      sink.onaudioprocess = event => {
        if (!armed || failure) return;
        const samples = event.inputBuffer.getChannelData(0), receivedAt = performance.now();
        const frame = Math.round((event.playbackTime - event.inputBuffer.duration) * context.sampleRate);
        const captureAt = receivedAt + (frame / context.sampleRate - context.currentTime) * 1000;
        const voiced = rms(samples) >= 0.015;
        emit({ kind: 'capture', captureAt, receivedAt, voiced, durationMs: samples.length / context.sampleRate * 1000,
          captureFrame: frame, contextSampleRate: context.sampleRate, byteLength: samples.length * 2, wavFrame: frames });
        frames += samples.length;
        if (voiced && captureAt >= firstAudioAt) bargeInAt ??= captureAt;
      };
      const silence = context.createGain(); silence.gain.value = 0;
      nativeConnect.call(source, sink); nativeConnect.call(sink, silence); nativeConnect.call(silence, context.destination);
      await context.resume();
    }
    return stream;
  };
  const fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    // Production client.js emits final user callbacks through voice-control.js.
    // Observe only ordinal 1 in this fresh visitor session, never tentative STT
    // or a later committed barge-in phrase. Do not change body or callbacks.
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (armed && url.origin === location.origin && /\/voice\/[^/]+\/events$/u.test(url.pathname)) {
        const event = JSON.parse(init?.body).event;
        if (!hypothesis && bargeInAt === undefined && event.type === 'final' && event.role === 'user' &&
          event.userTurnOrdinal === 1 && typeof event.text === 'string' && event.text.trim()) hypothesis = event.text;
        if (hypothesis && event.type === 'final' && event.role === 'assistant') responseReady = true;
      }
    } catch { /* Not a production final-user persistence request. */ }
    return fetch(input, init);
  };
  window.qualificationBaselineProbe = {
    arm() { armed = true; },
    diagnostics() { return { armed, hasHypothesis: !!hypothesis, responseReady, firstAudioAt, bargeInAt, stoppedAt, failure,
      counts: Object.fromEntries(['capture', 'playback-start', 'playback-stop'].map(kind => [kind, trace.filter(e => e.kind === kind).length])),
      voiced: trace.filter(e => e.kind === 'capture' && e.voiced).slice(-8) }; },
    complete() { return !!failure || [firstAudioAt, bargeInAt, stoppedAt].every(Number.isFinite); },
    result() {
      if (failure || !hypothesis || !pcm.length || ![firstAudioAt, bargeInAt, stoppedAt].every(Number.isFinite)) throw new Error('Incomplete production media evidence');
      // Chunk conversion avoids argument/string limits for bounded PCM evidence.
      const samples = new Float32Array(bytes / 4); let offset = 0;
      for (const chunk of pcm) { samples.set(chunk, offset); offset += chunk.length; }
      const data = new Uint8Array(samples.buffer); let binary = '';
      for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
      return { hypothesis, trace, ttsPCM: btoa(binary), ttsFormat: format };
    },
    async close() {
      armed = false;
      for (const context of contexts) await context.close().catch(() => {});
      AudioNode.prototype.connect = nativeConnect; AudioNode.prototype.disconnect = nativeDisconnect;
    },
  };
}
