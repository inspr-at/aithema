/**
 * Browser speech capture for the existing message textarea.
 * MediaRecorder only. Implicit-cloud browser dictation APIs are not used.
 * Transcription fills an editable draft; Send is never automatic.
 */

const RECORDING_MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
]);

/**
 * @param {unknown} mimeType
 */
export function canonicalSpeechClientMediaType(mimeType) {
  return String(mimeType ?? '').split(';')[0]?.trim().toLowerCase() || '';
}

/**
 * @param {{
 *   isSecureContext?: boolean,
 *   MediaRecorder?: { isTypeSupported?: (type: string) => boolean },
 *   mediaDevices?: { getUserMedia?: Function },
 * }} [env]
 */
export function detectSpeechCaptureSupport(env = globalThis) {
  const secure = env.isSecureContext === true;
  const Recorder = env.MediaRecorder;
  const canRecord = typeof Recorder === 'function'
    && typeof Recorder.isTypeSupported === 'function';
  const canAsk = typeof env.mediaDevices?.getUserMedia === 'function';
  return Boolean(secure && canRecord && canAsk);
}

/**
 * Operator-configured capture bounds. Missing or non-positive values refuse
 * recording rather than capturing without a ceiling.
 * @param {object} capability
 * @returns {{ maxAudioBytes: number, maxRecordingMs: number } | null}
 */
export function speechRecordingBounds(capability) {
  const maxAudioBytes = Number(capability?.maxAudioBytes);
  const maxRecordingMs = Number(capability?.maxRecordingMs);
  if (!Number.isFinite(maxAudioBytes) || maxAudioBytes <= 0) return null;
  if (!Number.isFinite(maxRecordingMs) || maxRecordingMs <= 0) return null;
  return { maxAudioBytes, maxRecordingMs };
}

/**
 * @param {(type: string) => boolean} isTypeSupported
 * @param {readonly string[]} [accepted]
 */
export function pickRecordingMimeType(isTypeSupported, accepted = ['audio/webm', 'audio/mp4']) {
  const allowed = new Set(accepted.map(canonicalSpeechClientMediaType));
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    const canonical = canonicalSpeechClientMediaType(candidate);
    if (!allowed.has(canonical)) continue;
    if (typeof isTypeSupported === 'function' && isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function createSpeechDraftGuard() {
  let generation = 0;
  return {
    begin(currentText) {
      generation += 1;
      return { generation, snapshot: String(currentText ?? '') };
    },
    cancel() {
      generation += 1;
    },
    canApply(token, currentText) {
      return Boolean(
        token
        && token.generation === generation
        && String(currentText ?? '') === token.snapshot,
      );
    },
  };
}

/**
 * @param {MediaStream | { getTracks?: () => { stop: () => void }[] } | null} stream
 */
export function stopMediaStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

/**
 * @param {Blob | { size?: number } | null} blob
 * @param {string} [url]
 */
export function revokeSpeechBlob(blob, url) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  return blob == null;
}

/**
 * @param {ParentNode | Document} root
 * @param {object} capability
 * @param {object} [deps]
 */
export function bindSpeechComposer(root, capability, deps = {}) {
  if (!capability?.enabled) return { supported: false };
  const doc = root.ownerDocument ?? root;
  const mount = root.querySelector?.('[data-speech-root]') ?? doc.getElementById?.('workspace-speech');
  const textarea = root.querySelector?.('textarea[name="message"]')
    ?? doc.querySelector?.('#workspace-compose textarea[name="message"]');
  if (!mount || !textarea) return { supported: false };

  const MediaRecorderImpl = deps.MediaRecorder ?? globalThis.MediaRecorder;
  const getUserMedia = deps.getUserMedia
    ?? globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const isSecureContext = deps.isSecureContext ?? globalThis.isSecureContext;
  const now = deps.now ?? Date.now;
  const setIntervalImpl = deps.setInterval ?? globalThis.setInterval?.bind(globalThis);
  const clearIntervalImpl = deps.clearInterval ?? globalThis.clearInterval?.bind(globalThis);
  const addWindowListener = deps.addWindowListener ?? ((type, fn) => {
    globalThis.addEventListener?.(type, fn);
    return () => globalThis.removeEventListener?.(type, fn);
  });
  const bounds = speechRecordingBounds(capability);

  const status = mount.querySelector('[data-speech-status]');
  const recordBtn = mount.querySelector('[data-speech-record]');
  const stopBtn = mount.querySelector('[data-speech-stop]');
  const transcribeBtn = mount.querySelector('[data-speech-transcribe]');
  const cancelBtn = mount.querySelector('[data-speech-cancel]');
  const provider = capability.providerId;
  const model = capability.model;
  const destination = capability.destinationLabel || 'configured';
  const destinationNote = capability.destinationNote
    || 'Operator-declared location label; not measured network placement.';

  mount.hidden = false;
  const supported = detectSpeechCaptureSupport({
    isSecureContext,
    MediaRecorder: MediaRecorderImpl,
    mediaDevices: { getUserMedia },
  });
  const mimeType = supported && bounds
    ? pickRecordingMimeType(MediaRecorderImpl.isTypeSupported.bind(MediaRecorderImpl), capability.acceptedMediaTypes)
    : null;

  if (!supported || !bounds || !mimeType) {
    setStatus(!bounds
      ? 'Recording limits are not configured. Type your message instead.'
      : 'Recording is unavailable in this browser or context. Type your message instead.');
    disableAll();
    return { supported: false };
  }

  const guard = createSpeechDraftGuard();
  let mediaStream = null;
  let recorder = null;
  let recordedBlob = null;
  let recordedUrl = null;
  let timer = 0;
  let transcribeAbort = null;
  let draftToken = null;
  let recording = false;
  let permissionPending = false;
  let captureGeneration = 0;

  setStatus(`${provider} / ${model}. Destination: ${destination}. ${destinationNote} Record, Stop, then Transcribe. The result is an editable draft; Send is never automatic.`);
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  transcribeBtn.disabled = true;
  if (cancelBtn) cancelBtn.hidden = true;

  const removePageHide = addWindowListener('pagehide', () => {
    void resetCapture({ keepDraft: true, cancelWork: true });
  });
  const removeFreeze = addWindowListener('freeze', () => {
    void resetCapture({ keepDraft: true, cancelWork: true });
  });

  recordBtn.addEventListener('click', () => {
    void startRecording();
  });
  stopBtn.addEventListener('click', () => {
    stopRecording();
  });
  transcribeBtn.addEventListener('click', () => {
    void transcribe();
  });
  cancelBtn?.addEventListener('click', () => {
    void resetCapture({ keepDraft: true, cancelWork: true });
    setStatus('Transcription cancelled. Typed text was kept.');
  });

  async function startRecording() {
    if (recording || permissionPending) return;
    resetCapture({ keepDraft: true, cancelWork: true });
    const generation = ++captureGeneration;
    permissionPending = true;
    recordBtn.disabled = true;
    if (cancelBtn) cancelBtn.hidden = false;
    setStatus('Waiting for microphone permission. You can cancel without changing your draft.');
    let acquiredStream;
    try {
      acquiredStream = await getUserMedia({ audio: true });
    } catch {
      if (generation !== captureGeneration) return;
      permissionPending = false;
      recordBtn.disabled = false;
      if (cancelBtn) cancelBtn.hidden = true;
      setStatus('Microphone permission was denied. Type your message instead.');
      return;
    }
    if (generation !== captureGeneration) {
      stopMediaStream(acquiredStream);
      return;
    }
    permissionPending = false;
    if (cancelBtn) cancelBtn.hidden = true;
    recordedBlob = null;
    revokeCurrentUrl();
    const captureStream = acquiredStream;
    const captureChunks = [];
    let captureStopReason = null;
    let captureRecorder;
    try {
      captureRecorder = new MediaRecorderImpl(captureStream, { mimeType });
      mediaStream = captureStream;
      recorder = captureRecorder;
      captureRecorder.addEventListener('dataavailable', (event) => {
        if (generation !== captureGeneration || recorder !== captureRecorder) return;
        if (event.data && event.data.size > 0) captureChunks.push(event.data);
        const size = captureChunks.reduce((total, part) => total + (part.size || 0), 0);
        if (size > bounds.maxAudioBytes) {
          captureStopReason = 'size';
          stopRecording();
        }
      });
      captureRecorder.addEventListener('error', () => {
        stopMediaStream(captureStream);
        if (generation !== captureGeneration || recorder !== captureRecorder) return;
        resetCapture({ keepDraft: true, cancelWork: true });
        setStatus('Recording failed. Type your message instead.');
      });
      captureRecorder.addEventListener('stop', () => {
        stopMediaStream(captureStream);
        if (generation !== captureGeneration || recorder !== captureRecorder) return;
        if (timer) {
          clearIntervalImpl?.(timer);
          timer = 0;
        }
        mediaStream = null;
        recorder = null;
        recording = false;
        recordedBlob = new Blob(captureChunks, { type: canonicalSpeechClientMediaType(mimeType) });
        if (recordedBlob.size === 0) {
          recordedBlob = null;
          transcribeBtn.disabled = true;
          setStatus('Recording was empty. Type your message instead.');
          return;
        }
        transcribeBtn.disabled = false;
        if (captureStopReason === 'size') {
          setStatus('Recording reached the audio size bound and was stopped.');
        } else if (captureStopReason === 'time') {
          setStatus('Recording reached the time bound and was stopped.');
        } else {
          setStatus('Recording stopped. Review is still your typed draft until you Transcribe.');
        }
      });
      captureRecorder.start(250);
    } catch {
      stopMediaStream(captureStream);
      if (generation === captureGeneration) {
        resetCapture({ keepDraft: true, cancelWork: true });
        setStatus('Recording failed. Type your message instead.');
      }
      return;
    }
    if (generation !== captureGeneration || recorder !== captureRecorder) {
      stopMediaStream(captureStream);
      return;
    }
    recording = true;
    const captureStartedAt = now();
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    transcribeBtn.disabled = true;
    timer = setIntervalImpl?.(() => {
      if (generation !== captureGeneration || recorder !== captureRecorder) return;
      if (now() - captureStartedAt >= bounds.maxRecordingMs) {
        captureStopReason = 'time';
        stopRecording();
      }
    }, 250) ?? 0;
    setStatus('Recording. Stop when finished. This does not send a message.');
  }

  function stopRecording() {
    if (timer) {
      clearIntervalImpl?.(timer);
      timer = 0;
    }
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.stop();
        recording = false;
      } catch {
        stopMediaStream(mediaStream);
        mediaStream = null;
        recorder = null;
        recording = false;
        recordedBlob = null;
        transcribeBtn.disabled = true;
      }
    } else {
      stopMediaStream(mediaStream);
      mediaStream = null;
      recording = false;
    }
  }

  async function transcribe() {
    if (!recordedBlob || transcribeAbort) return;
    const speechId = `speech:${cryptoRandom()}`;
    draftToken = guard.begin(textarea.value);
    transcribeAbort = typeof AbortController === 'function' ? new AbortController() : null;
    transcribeBtn.disabled = true;
    recordBtn.disabled = true;
    if (cancelBtn) cancelBtn.hidden = false;
    setStatus('Transcribing. Newly typed text will not be overwritten if you edit before this finishes.');
    const body = new FormData();
    body.append('file', recordedBlob, filenameForClientMime(recordedBlob.type));
    body.append('speech_id', speechId);
    body.append('providerId', provider);
    body.append('model', model);
    try {
      const response = await fetchImpl(capability.transcribePath, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body,
        signal: transcribeAbort?.signal,
        credentials: 'same-origin',
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        setStatus(typeof payload?.error === 'string'
          ? payload.error
          : 'Transcription failed. Typed text was kept.');
        return;
      }
      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!guard.canApply(draftToken, textarea.value)) {
        setStatus('A newer draft was kept. The stale transcription was discarded.');
        return;
      }
      if (!text) {
        setStatus('Transcription was empty. Typed text was kept.');
        return;
      }
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      setStatus('Transcription is in the message box as an editable draft. Send when you are ready.');
    } catch (error) {
      if (error?.name === 'AbortError') {
        setStatus('Transcription cancelled. Typed text was kept.');
        return;
      }
      setStatus('Transcription failed. Typed text was kept.');
    } finally {
      transcribeAbort = null;
      draftToken = null;
      recordBtn.disabled = false;
      transcribeBtn.disabled = !recordedBlob;
      if (cancelBtn) cancelBtn.hidden = true;
    }
  }

  function resetCapture({ keepDraft, cancelWork } = {}) {
    captureGeneration += 1;
    permissionPending = false;
    if (cancelWork) {
      guard.cancel();
      try { transcribeAbort?.abort(); } catch { /* ignore */ }
      transcribeAbort = null;
    }
    stopRecording();
    stopMediaStream(mediaStream);
    mediaStream = null;
    recorder = null;
    recordedBlob = null;
    revokeCurrentUrl();
    transcribeBtn.disabled = true;
    recordBtn.disabled = false;
    if (cancelBtn) cancelBtn.hidden = true;
    if (!keepDraft) {
      /* draft lives in the existing textarea */
    }
  }

  function revokeCurrentUrl() {
    if (recordedUrl) {
      revokeSpeechBlob(null, recordedUrl);
      recordedUrl = null;
    }
  }

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function disableAll() {
    if (recordBtn) recordBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    if (transcribeBtn) transcribeBtn.disabled = true;
    if (cancelBtn) cancelBtn.hidden = true;
  }

  function cryptoRandom() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  return {
    supported: true,
    mimeType,
    stop: () => {
      void resetCapture({ keepDraft: true, cancelWork: true });
      removePageHide?.();
      removeFreeze?.();
    },
  };
}

function filenameForClientMime(mimeType) {
  const type = canonicalSpeechClientMediaType(mimeType);
  if (type === 'audio/mp4') return 'recording.mp4';
  return 'recording.webm';
}

function autoBind() {
  if (typeof document === 'undefined') return;
  const raw = document.getElementById('aithema-speech-capability');
  if (!raw?.textContent) return;
  let capability;
  try {
    capability = JSON.parse(raw.textContent);
  } catch {
    return;
  }
  bindSpeechComposer(document, capability);
}

autoBind();
