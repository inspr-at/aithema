import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConversationController,
  MOCK_SPEECH_MARK,
  MockLlmProvider,
  SqliteProjectStore,
  createSpeechAdapter,
  normalizeSpeechConfig,
  spendCallId,
} from '../runtime/index.js';
import {
  bindSpeechComposer,
  createSpeechDraftGuard,
  createWorkspaceServer,
  detectSpeechCaptureSupport,
  normalizeSpeechConfig as workspaceNormalizeSpeechConfig,
  normalizeWorkspaceConfig,
  pickRecordingMimeType,
  speechRecordingBounds,
} from '../workspace/index.js';
import { resolveWorkspaceStatic } from '../workspace/flow-assets.js';
import { expandAllowlistPathsFromTree } from '../release/lib/tree.mjs';

const SAMPLE = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function eventually(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('condition was not met before timeout');
}
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const memberships = [
  {
    subject: 'demo-reviewer',
    party_ref: 'party:demo-reviewer',
    actor_kind: 'human',
    roles: ['requirements_approver', 'delivery_party'],
    projects: [],
  },
  {
    subject: 'demo-outsider',
    party_ref: 'party:demo-outsider',
    actor_kind: 'human',
    roles: ['delivery_party'],
    projects: [],
  },
];

const reviewer = {
  party_ref: 'party:demo-reviewer',
  actor_kind: 'human',
  roles: ['requirements_approver', 'delivery_party'],
  subject: 'demo-reviewer',
  projects: [],
};

function baseConfig(extra = {}) {
  return {
    mode: 'test',
    listenHost: '127.0.0.1',
    listenPort: 0,
    defaultProvider: 'mock',
    identity: {
      kind: 'demo',
      demoHmacSecret: 'demo-hmac-secret-not-for-production',
      defaultSubject: 'demo-reviewer',
      memberships,
    },
    providers: {
      mock: {
        kind: 'mock',
        executionLocation: 'local',
        allowedDataClasses: ['unclassified'],
      },
    },
    ...extra,
  };
}

async function start(config) {
  const workspace = createWorkspaceServer(config);
  const { url } = await workspace.listen();
  return { workspace, url };
}

function cookieFrom(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  const line = header.find((item) => item.startsWith('aithema_demo='));
  return line ? line.split(';')[0] : '';
}

async function demoSession(url, subject, mount = '') {
  const response = await fetch(`${url}${mount}/session/demo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({ subject }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function createProject(url, cookie, mount = '') {
  const response = await fetch(`${url}${mount}/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(url).origin,
    },
    body: new URLSearchParams({
      title: 'Speech project',
      project_kinds: 'new_product',
    }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  return response.headers.get('location');
}

function audioForm(extra = {}) {
  const body = new FormData();
  body.append('file', new Blob([SAMPLE], { type: extra.mimeType ?? 'audio/webm' }), extra.filename ?? 'recording.webm');
  if (extra.speechId) body.append('speech_id', extra.speechId);
  if (extra.providerId) body.append('providerId', extra.providerId);
  if (extra.model) body.append('model', extra.model);
  if (extra.endpoint) body.append('endpoint', extra.endpoint);
  return body;
}

describe('workspace speech defaults and inclusion', () => {
  it('keeps demo speech disabled and documents the production example shape', () => {
    const demo = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/demo-config.json', import.meta.url)), 'utf8'));
    const production = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/production-config.example.json', import.meta.url)), 'utf8'));
    assert.equal(demo.speech, undefined);
    assert.equal(normalizeWorkspaceConfig(baseConfig()).speech.enabled, false);
    assert.equal(production.speech.kind, 'openai-compatible-transcription');
    assert.equal(production.speech.endpoint, 'http://127.0.0.1:8080/v1/audio/transcriptions');
    assert.equal(production.speech.model, 'operator-approved-whisper');
    assert.equal(production.speech.endpoint.includes('/chat/completions'), false);
  });

  it('exports runtime/workspace speech surfaces and includes them in recursive allowlists', () => {
    const runtimeAllow = JSON.parse(readFileSync(new URL('../release/allowlist.json', import.meta.url), 'utf8'));
    const sourceAllow = JSON.parse(readFileSync(new URL('../release/source-allowlist.json', import.meta.url), 'utf8'));
    assert.equal(runtimeAllow.paths.includes('runtime/'), true);
    assert.equal(runtimeAllow.paths.includes('workspace/'), true);
    assert.equal(sourceAllow.paths.includes('test/'), true);
    const runtimeListed = expandAllowlistPathsFromTree(repoRoot, runtimeAllow.paths);
    const sourceListed = expandAllowlistPathsFromTree(repoRoot, sourceAllow.paths);
    assert.equal(runtimeListed.includes('runtime/speech.js'), true);
    assert.equal(runtimeListed.includes('workspace/speech-input.js'), true);
    assert.equal(sourceListed.includes('test/speech.test.js'), true);
    assert.equal(sourceListed.includes('test/speech-workspace.test.js'), true);
    const asset = resolveWorkspaceStatic('/workspace-speech-input.js');
    assert.ok(asset);
    const source = readFileSync(asset.path, 'utf8');
    assert.equal(source.includes('MediaRecorder'), true);
    assert.equal(source.includes('Send is never automatic'), true);
    assert.equal(workspaceNormalizeSpeechConfig, normalizeSpeechConfig);
  });
});

class FakeMediaRecorder {
  static instances = [];

  static isTypeSupported(type) {
    return String(type).startsWith('audio/webm');
  }

  /**
   * @param {{ getTracks?: () => { stop: () => void }[] }} stream
   * @param {{ mimeType?: string }} [options]
   */
  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.timeslice = 0;
    /** @type {Record<string, Function[]>} */
    this.listeners = Object.create(null);
    FakeMediaRecorder.instances.push(this);
  }

  /**
   * @param {string} type
   * @param {Function} fn
   */
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  /**
   * @param {number} [timeslice]
   */
  start(timeslice) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }

  /**
   * @param {Blob} data
   */
  emitData(data) {
    for (const fn of this.listeners.dataavailable ?? []) fn({ data });
  }

  stop() {
    this.state = 'inactive';
    const data = this.chunk ?? new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    for (const fn of this.listeners.dataavailable ?? []) fn({ data });
    for (const fn of this.listeners.stop ?? []) fn();
  }
}

class ConstructorThrowingMediaRecorder {
  static isTypeSupported(type) {
    return FakeMediaRecorder.isTypeSupported(type);
  }

  constructor() {
    throw new Error('synthetic constructor failure');
  }
}

class StartThrowingMediaRecorder extends FakeMediaRecorder {
  start() {
    throw new Error('synthetic start failure');
  }
}

class DelayedStopMediaRecorder extends FakeMediaRecorder {
  stop() {
    this.state = 'inactive';
  }

  finishStop() {
    const data = this.chunk ?? new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    for (const fn of this.listeners.dataavailable ?? []) fn({ data });
    for (const fn of this.listeners.stop ?? []) fn();
  }
}

class UnusedDictation {
  constructor() {
    throw new Error('implicit-cloud dictation API must not be constructed');
  }

  start() {
    throw new Error('implicit-cloud dictation API must not start');
  }
}

function button() {
  /** @type {Record<string, Function[]>} */
  const listeners = Object.create(null);
  return {
    disabled: false,
    hidden: false,
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    click() {
      for (const fn of listeners.click ?? []) fn();
    },
  };
}

function composerHarness(textareaValue = 'keep typing') {
  const textarea = { value: textareaValue, name: 'message', dispatchEvent() {} };
  const status = { textContent: '' };
  const recordBtn = button();
  const stopBtn = button();
  const transcribeBtn = button();
  const cancelBtn = button();
  cancelBtn.hidden = true;
  const controls = {
    '[data-speech-status]': status,
    '[data-speech-record]': recordBtn,
    '[data-speech-stop]': stopBtn,
    '[data-speech-transcribe]': transcribeBtn,
    '[data-speech-cancel]': cancelBtn,
  };
  const root = {
    ownerDocument: {
      getElementById: () => null,
      querySelector: () => textarea,
    },
    querySelector(selector) {
      if (selector === '[data-speech-root]') {
        return {
          hidden: true,
          querySelector: (inner) => controls[inner] ?? null,
        };
      }
      if (selector === 'textarea[name="message"]') return textarea;
      return null;
    },
  };
  return { textarea, status, recordBtn, stopBtn, transcribeBtn, cancelBtn, root };
}

describe('client speech capability fallback and draft lifecycle', () => {
  it('requires a real MediaRecorder function, not an object fixture or dictation API', () => {
    assert.equal(detectSpeechCaptureSupport({
      isSecureContext: false,
      MediaRecorder: FakeMediaRecorder,
      mediaDevices: { getUserMedia: () => {} },
    }), false);
    assert.equal(detectSpeechCaptureSupport({
      isSecureContext: true,
      MediaRecorder: { isTypeSupported: () => true },
      mediaDevices: { getUserMedia: () => {} },
    }), false);
    assert.equal(detectSpeechCaptureSupport({
      isSecureContext: true,
      SpeechRecognition: UnusedDictation,
      webkitSpeechRecognition: UnusedDictation,
      mediaDevices: { getUserMedia: () => {} },
    }), false);
    assert.equal(detectSpeechCaptureSupport({
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      SpeechRecognition: UnusedDictation,
      webkitSpeechRecognition: UnusedDictation,
      mediaDevices: { getUserMedia: () => {} },
    }), true);
    assert.equal(speechRecordingBounds({}), null);
    assert.equal(speechRecordingBounds({ maxAudioBytes: 8, maxRecordingMs: 0 }), null);
    assert.deepEqual(speechRecordingBounds({ maxAudioBytes: 8, maxRecordingMs: 1000 }), {
      maxAudioBytes: 8,
      maxRecordingMs: 1000,
    });
    assert.equal(
      pickRecordingMimeType(FakeMediaRecorder.isTypeSupported, ['audio/webm', 'audio/mp4']),
      'audio/webm;codecs=opus',
    );
    assert.equal(pickRecordingMimeType(() => false, ['audio/webm']), null);
    const guard = createSpeechDraftGuard();
    const first = guard.begin('old');
    assert.equal(guard.canApply(first, 'old'), true);
    guard.begin('old');
    assert.equal(guard.canApply(first, 'old'), false);
    const second = guard.begin('typed later');
    assert.equal(guard.canApply(second, 'changed'), false);
    assert.equal(guard.canApply(second, 'typed later'), true);
    guard.cancel();
    assert.equal(guard.canApply(second, 'typed later'), false);
  });

  it('leaves the existing textarea alone when capture is unsupported', () => {
    const { textarea, status, root } = composerHarness();
    const bound = bindSpeechComposer(root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 1024,
      maxRecordingMs: 1000,
    }, {
      isSecureContext: false,
      MediaRecorder: FakeMediaRecorder,
      getUserMedia: async () => ({ getTracks: () => [] }),
    });
    assert.equal(bound.supported, false);
    assert.equal(textarea.value, 'keep typing');
    assert.equal(status.textContent.includes('Type your message'), true);
  });

  it('asks for microphone consent only after Record and never uses a dictation API', async () => {
    FakeMediaRecorder.instances = [];
    const track = { stopped: false, stop() { this.stopped = true; } };
    let mediaCalls = 0;
    const { textarea, status, recordBtn, stopBtn, transcribeBtn, root } = composerHarness('draft');
    const windowListeners = [];
    const bound = bindSpeechComposer(root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 1024,
      maxRecordingMs: 10_000,
    }, {
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      SpeechRecognition: UnusedDictation,
      getUserMedia: async () => {
        mediaCalls += 1;
        return { getTracks: () => [track] };
      },
      addWindowListener(type, fn) {
        windowListeners.push({ type, fn });
        return () => {};
      },
    });
    assert.equal(bound.supported, true);
    assert.equal(mediaCalls, 0);
    assert.equal(FakeMediaRecorder.instances.length, 0);
    recordBtn.click();
    await flush();
    assert.equal(mediaCalls, 1);
    assert.equal(FakeMediaRecorder.instances.length, 1);
    assert.equal(FakeMediaRecorder.instances[0].state, 'recording');
    assert.equal(track.stopped, false);
    stopBtn.click();
    assert.equal(track.stopped, true);
    assert.equal(transcribeBtn.disabled, false);
    assert.equal(textarea.value, 'draft');
    assert.equal(status.textContent.includes('editable draft') || status.textContent.includes('typed draft'), true);
    bound.stop();
  });

  it('stops a late microphone stream and never records after pending permission is cancelled or the page hides', async () => {
    for (const cancellation of ['cancel', 'pagehide']) {
      FakeMediaRecorder.instances = [];
      const permission = deferred();
      const track = { stopped: false, stop() { this.stopped = true; } };
      const { textarea, recordBtn, cancelBtn, root } = composerHarness('keep this draft');
      const windowListeners = new Map();
      const bound = bindSpeechComposer(root, {
        enabled: true,
        providerId: 'mock',
        model: 'mock',
        acceptedMediaTypes: ['audio/webm'],
        transcribePath: '/projects/x/transcribe',
        maxAudioBytes: 1024,
        maxRecordingMs: 10_000,
      }, {
        isSecureContext: true,
        MediaRecorder: FakeMediaRecorder,
        getUserMedia: () => permission.promise,
        addWindowListener(type, fn) {
          windowListeners.set(type, fn);
          return () => windowListeners.delete(type);
        },
      });

      recordBtn.click();
      await flush();
      assert.equal(cancelBtn.hidden, false);
      if (cancellation === 'cancel') cancelBtn.click();
      else windowListeners.get('pagehide')();
      permission.resolve({ getTracks: () => [track] });
      await flush();

      assert.equal(track.stopped, true);
      assert.equal(FakeMediaRecorder.instances.length, 0);
      assert.equal(textarea.value, 'keep this draft');
      bound.stop();
    }
  });

  it('stops granted tracks and restores capture controls when recorder construction or start throws', async () => {
    for (const RecorderImpl of [ConstructorThrowingMediaRecorder, StartThrowingMediaRecorder]) {
      FakeMediaRecorder.instances = [];
      const track = { stopped: false, stop() { this.stopped = true; } };
      const { textarea, status, recordBtn, stopBtn, transcribeBtn, root } = composerHarness('keep this draft');
      const bound = bindSpeechComposer(root, {
        enabled: true,
        providerId: 'mock',
        model: 'mock',
        acceptedMediaTypes: ['audio/webm'],
        transcribePath: '/projects/x/transcribe',
        maxAudioBytes: 1024,
        maxRecordingMs: 10_000,
      }, {
        isSecureContext: true,
        MediaRecorder: RecorderImpl,
        getUserMedia: async () => ({ getTracks: () => [track] }),
      });

      recordBtn.click();
      await flush();

      assert.equal(track.stopped, true);
      assert.equal(recordBtn.disabled, false);
      assert.equal(stopBtn.disabled, true);
      assert.equal(transcribeBtn.disabled, true);
      assert.equal(status.textContent.includes('Recording failed'), true);
      assert.equal(textarea.value, 'keep this draft');
      bound.stop();
    }
  });

  it('ignores delayed stop and data events from a superseded recorder', async () => {
    FakeMediaRecorder.instances = [];
    const tracks = [
      { stopped: false, stop() { this.stopped = true; } },
      { stopped: false, stop() { this.stopped = true; } },
    ];
    let streamIndex = 0;
    const { textarea, status, recordBtn, stopBtn, transcribeBtn, root } = composerHarness('keep this draft');
    const bound = bindSpeechComposer(root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 1024,
      maxRecordingMs: 10_000,
    }, {
      isSecureContext: true,
      MediaRecorder: DelayedStopMediaRecorder,
      getUserMedia: async () => {
        const track = tracks[streamIndex++];
        return { getTracks: () => [track] };
      },
    });

    recordBtn.click();
    await flush();
    const first = FakeMediaRecorder.instances[0];
    stopBtn.click();
    recordBtn.click();
    await flush();
    const second = FakeMediaRecorder.instances[1];
    assert.equal(second.state, 'recording');
    assert.equal(tracks[0].stopped, true);
    assert.equal(tracks[1].stopped, false);

    first.finishStop();

    assert.equal(second.state, 'recording');
    assert.equal(tracks[1].stopped, false);
    assert.equal(transcribeBtn.disabled, true);
    assert.equal(status.textContent.includes('Recording. Stop when finished'), true);
    assert.equal(textarea.value, 'keep this draft');
    bound.stop();
    assert.equal(tracks[1].stopped, true);
  });

  it('refuses missing limits, denied consent, and oversize or overtime capture', async () => {
    const missing = composerHarness();
    const withoutLimits = bindSpeechComposer(missing.root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
    }, {
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      getUserMedia: async () => {
        throw new Error('consent must not be requested without limits');
      },
    });
    assert.equal(withoutLimits.supported, false);
    assert.equal(missing.textarea.value, 'keep typing');
    assert.equal(missing.status.textContent.includes('limits are not configured'), true);

    const denied = composerHarness('typed already');
    let asked = 0;
    const deniedBind = bindSpeechComposer(denied.root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 16,
      maxRecordingMs: 1000,
    }, {
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      getUserMedia: async () => {
        asked += 1;
        throw new Error('Permission denied');
      },
    });
    assert.equal(deniedBind.supported, true);
    denied.recordBtn.click();
    await flush();
    assert.equal(asked, 1);
    assert.equal(denied.textarea.value, 'typed already');
    assert.equal(denied.status.textContent.includes('denied'), true);
    assert.equal(denied.transcribeBtn.disabled, true);

    FakeMediaRecorder.instances = [];
    const oversized = composerHarness();
    const sizeBind = bindSpeechComposer(oversized.root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 4,
      maxRecordingMs: 10_000,
    }, {
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    });
    assert.equal(sizeBind.supported, true);
    oversized.recordBtn.click();
    await flush();
    const recorder = FakeMediaRecorder.instances.at(-1);
    recorder.emitData(new Blob([new Uint8Array(8)], { type: 'audio/webm' }));
    assert.equal(oversized.status.textContent.includes('size bound'), true);

    FakeMediaRecorder.instances = [];
    let clock = 0;
    /** @type {Function | null} */
    let tick = null;
    const timed = composerHarness();
    const timeBind = bindSpeechComposer(timed.root, {
      enabled: true,
      providerId: 'mock',
      model: 'mock',
      acceptedMediaTypes: ['audio/webm'],
      transcribePath: '/projects/x/transcribe',
      maxAudioBytes: 1024,
      maxRecordingMs: 500,
    }, {
      isSecureContext: true,
      MediaRecorder: FakeMediaRecorder,
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      now: () => clock,
      setInterval(fn) {
        tick = fn;
        return 1;
      },
      clearInterval() {
        tick = null;
      },
    });
    assert.equal(timeBind.supported, true);
    timed.recordBtn.click();
    await flush();
    clock = 500;
    tick?.();
    assert.equal(timed.status.textContent.includes('time bound'), true);
    timeBind.stop();
    sizeBind.stop();
  });
});

describe('speech HTTP workspace boundary', () => {
  it('does not expose Record controls or accept transcribe when speech is disabled', async () => {
    const { workspace, url } = await start(baseConfig());
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.doesNotMatch(page, /data-speech-record/);
      assert.doesNotMatch(page, /workspace-speech-input\.js/);
      const denied = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm(),
      });
      assert.equal(denied.status, 404);
    } finally {
      await workspace.close();
    }
  });

  it('transcribes through the labelled double without changing store state before Send', async () => {
    const { workspace, url } = await start(baseConfig({
      speech: { kind: 'mock', providerId: 'mock', model: 'mock' },
    }));
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.match(page, /data-speech-record/);
      assert.match(page, /workspace-speech-input\.js/);
      assert.match(page, /configured local/);
      assert.match(page, /not measured network placement/);
      const before = workspace.controller.loadProject(reviewer, decodeURIComponent(projectUrl.pathname.split('/')[2]));
      const transcribe = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm({ speechId: 'speech:draft-one' }),
      });
      assert.equal(transcribe.status, 200);
      const body = await transcribe.json();
      assert.equal(body.text.includes(MOCK_SPEECH_MARK), true);
      assert.equal(body.revision, before.revision);
      const after = workspace.controller.loadProject(reviewer, before.project_ref);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.transcript, []);
      assert.equal(after.understanding, null);
      assert.equal(after.stream.proposals.length, before.stream.proposals.length);
      assert.equal(after.stream.baselines.length, 0);
      const sent = await fetch(`${projectUrl.href}/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: new URL(url).origin,
        },
        body: new URLSearchParams({ message: body.text }),
        redirect: 'manual',
      });
      assert.equal(sent.status, 303);
      const complete = workspace.controller.loadProject(reviewer, before.project_ref);
      assert.equal(complete.revision > before.revision, true);
      assert.equal(complete.transcript[0].content, body.text);
    } finally {
      await workspace.close();
    }
  });

  it('enforces origin, membership, MIME, and override rejection before egress', async () => {
    let egress = 0;
    const fixture = createServer((_req, res) => {
      egress += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'should-not-run' }));
    });
    const fixtureOrigin = await new Promise((resolve) => {
      fixture.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${fixture.address().port}`));
    });
    const { workspace, url } = await start(baseConfig({
      providers: {
        mock: {
          kind: 'mock',
          executionLocation: 'local',
          allowedDataClasses: ['unclassified'],
        },
        local: {
          kind: 'openai-compatible',
          baseUrl: `${fixtureOrigin}/v1`,
          modelId: 'chat-model',
          allowedModels: ['chat-model'],
          executionLocation: 'local',
          allowedDataClasses: ['unclassified'],
          apiKey: 'dummy-speech-test',
        },
      },
      speech: {
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper-fixture',
        endpoint: `${fixtureOrigin}/v1/audio/transcriptions`,
      },
    }));
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const outsider = await demoSession(url, 'demo-outsider');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);

      const csrf = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, accept: 'application/json' },
        body: audioForm(),
      });
      assert.equal(csrf.status, 403);

      const foreign = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie: outsider, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm(),
      });
      assert.equal(foreign.status === 403 || foreign.status === 404, true);

      const badMime = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm({ mimeType: 'audio/mpeg', filename: 'clip.mp3' }),
      });
      assert.equal(badMime.status, 400);

      const override = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm({ endpoint: 'http://evil.example/audio/transcriptions' }),
      });
      assert.equal(override.status, 400);
      assert.equal(egress, 0);
    } finally {
      await workspace.close();
      await new Promise((resolve) => fixture.close(resolve));
    }
  });

  it('uses native publicBasePath URLs for the speech module and transcribe path', async () => {
    const mount = '/aithema';
    const { workspace, url } = await start(baseConfig({
      publicBasePath: mount,
      speech: { kind: 'mock', providerId: 'mock', model: 'mock' },
    }));
    try {
      const cookie = await demoSession(url, 'demo-reviewer', mount);
      const location = await createProject(url, cookie, mount);
      assert.equal(location.startsWith(`${mount}/projects/`), true);
      const projectUrl = new URL(location, url);
      const page = await (await fetch(projectUrl, { headers: { cookie } })).text();
      assert.match(page, /src="\/aithema\/workspace-speech-input\.js"/);
      assert.match(page, /"transcribePath":"\/aithema\/projects\/[^"]+\/transcribe"/);
      const script = await fetch(`${url}${mount}/workspace-speech-input.js`);
      assert.equal(script.status, 200);
      const transcribe = await fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm(),
      });
      assert.equal(transcribe.status, 200);
    } finally {
      await workspace.close();
    }
  });

  it('keeps a completed upload live, then aborts provider work when that client disconnects', async () => {
    const arrivals = [deferred(), deferred()];
    const releases = [deferred(), deferred()];
    const providerCloses = [deferred(), deferred()];
    let providerCalls = 0;
    const fixture = createServer(async (req, res) => {
      const index = providerCalls++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let closedBeforeResponse = false;
      res.once('close', () => {
        closedBeforeResponse = !res.writableEnded;
        providerCloses[index].resolve(closedBeforeResponse);
      });
      arrivals[index].resolve({ body, headers: req.headers });
      await releases[index].promise;
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: `provider transcript ${index}` }));
      }
    });
    const fixtureOrigin = await new Promise((resolvePromise) => {
      fixture.listen(0, '127.0.0.1', () => resolvePromise(`http://127.0.0.1:${fixture.address().port}`));
    });
    const { workspace, url } = await start(baseConfig({
      providers: {
        mock: {
          kind: 'mock',
          executionLocation: 'local',
          allowedDataClasses: ['unclassified'],
        },
        local: {
          kind: 'openai-compatible',
          baseUrl: `${fixtureOrigin}/v1`,
          modelId: 'chat-model',
          allowedModels: ['chat-model'],
          executionLocation: 'local',
          allowedDataClasses: ['unclassified'],
          apiKey: 'dummy-speech-test',
        },
      },
      policy: {
        epoch: 1,
        execution: 'local',
        allowedProviders: ['mock', 'local'],
        allowedDataClasses: ['unclassified'],
        dataClass: 'unclassified',
        maxOutboundCallsPerProject: 4,
      },
      speech: {
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper-fixture',
        endpoint: `${fixtureOrigin}/v1/audio/transcriptions`,
      },
    }));
    try {
      const cookie = await demoSession(url, 'demo-reviewer');
      const location = await createProject(url, cookie);
      const projectUrl = new URL(location, url);
      const projectRef = decodeURIComponent(projectUrl.pathname.split('/').at(-1));
      const before = workspace.controller.loadProject(reviewer, projectRef);

      const completed = fetch(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: { cookie, origin: new URL(url).origin, accept: 'application/json' },
        body: audioForm({ speechId: 'speech:completed-upload' }),
      });
      await arrivals[0].promise;
      assert.equal(await Promise.race([
        providerCloses[0].promise,
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 30)),
      ]), false);
      releases[0].resolve();
      const completedResponse = await completed;
      assert.equal(completedResponse.status, 200);
      assert.equal((await completedResponse.json()).text, 'provider transcript 0');

      const formRequest = new Request('http://127.0.0.1/transcribe', {
        method: 'POST',
        body: audioForm({ speechId: 'speech:disconnected-upload' }),
      });
      const requestBody = Buffer.from(await formRequest.arrayBuffer());
      const clientDone = deferred();
      const clientRequest = httpRequest(`${projectUrl.href}/transcribe`, {
        method: 'POST',
        headers: {
          cookie,
          origin: new URL(url).origin,
          accept: 'application/json',
          'content-type': formRequest.headers.get('content-type'),
          'content-length': requestBody.byteLength,
        },
      }, (response) => {
        response.resume();
        response.once('end', clientDone.resolve);
      });
      clientRequest.once('error', clientDone.resolve);
      clientRequest.end(requestBody);
      await arrivals[1].promise;
      const disconnectedAt = Date.now();
      clientRequest.destroy();
      assert.equal(await Promise.race([
        providerCloses[1].promise,
        new Promise((_, rejectPromise) => setTimeout(
          () => rejectPromise(new Error('provider request was not cancelled promptly')),
          1000,
        )),
      ]), true);
      assert.equal(Date.now() - disconnectedAt < 1000, true);
      releases[1].resolve();
      await clientDone.promise;

      const callId = spendCallId('speech:disconnected-upload', 'transcribe');
      await eventually(() => workspace.store.getOutboundCall(projectRef, 1, callId) === 'committed');
      assert.equal(workspace.store.countOutboundCalls(projectRef, 1), 2);
      const after = workspace.controller.loadProject(reviewer, projectRef);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.transcript, []);
      assert.equal(after.understanding, null);
      assert.equal(after.documents.length, 0);
      assert.equal(after.stream.proposals.length, 0);
      assert.equal(after.stream.baselines.length, 0);
    } finally {
      releases.forEach((release) => release.resolve());
      await workspace.close();
      await new Promise((resolvePromise) => fixture.close(resolvePromise));
    }
  });
});

function speechSpendHarness(ceiling) {
  const store = new SqliteProjectStore(':memory:');
  const provider = new MockLlmProvider({
    executionLocation: 'local',
    allowedDataClasses: ['unclassified'],
  });
  const speech = normalizeSpeechConfig({
    kind: 'mock',
    providerId: 'mock',
    model: 'mock',
  }, {
    mode: 'test',
    providers: {
      mock: { kind: 'mock', executionLocation: 'local', allowedDataClasses: ['unclassified'] },
    },
    policy: {
      execution: 'local',
      allowedProviders: ['mock'],
      allowedDataClasses: ['unclassified'],
      dataClass: 'unclassified',
      maxOutboundCallsPerProject: ceiling,
    },
  });
  const adapter = createSpeechAdapter(speech, { mode: 'test' });
  const original = adapter.transcribe.bind(adapter);
  let adapterCalls = 0;
  adapter.transcribe = async (request) => {
    adapterCalls += 1;
    return original(request);
  };
  const controller = new ConversationController({
    store,
    provider,
    providers: { mock: provider },
    defaultProviderId: 'mock',
    policy: {
      epoch: 1,
      execution: 'local',
      allowedProviders: ['mock'],
      allowedDataClasses: ['unclassified'],
      dataClass: 'unclassified',
      maxOutboundCallsPerProject: ceiling,
      projects: {},
    },
    mode: 'test',
    speech,
    speechAdapter: adapter,
  });
  const project = controller.createProject(reviewer, {
    title: 'Spend',
    projectKinds: ['new_product'],
  });
  return {
    store,
    controller,
    project,
    adapterCalls: () => adapterCalls,
    transcribe(speechId) {
      return controller.transcribeSpeech({
        actor: reviewer,
        projectRef: project.project_ref,
        file: { bytes: SAMPLE, mimeType: 'audio/webm' },
        speechId,
      });
    },
    snapshot() {
      const current = store.getProject(project.project_ref, reviewer);
      return {
        revision: current.revision,
        transcript: current.transcript,
        understanding: current.understanding,
        proposals: current.stream.proposals.length,
        baselines: current.stream.baselines.length,
      };
    },
  };
}

describe('speech policy and reserved spend', () => {
  it('rejects the same reserved transcription id while capacity remains and does not call the adapter', async () => {
    const harness = speechSpendHarness(3);
    const before = harness.snapshot();
    const reserved = harness.store.reserveOutboundCall({
      projectRef: harness.project.project_ref,
      epoch: 1,
      callId: spendCallId('speech:stuck', 'transcribe'),
      ceiling: 3,
    });
    assert.equal(reserved.reserved, true);
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    await assert.rejects(() => harness.transcribe('speech:stuck'), /did not finish cleanly/);
    assert.equal(harness.adapterCalls(), 0);
    assert.equal(
      harness.store.getOutboundCall(harness.project.project_ref, 1, spendCallId('speech:stuck', 'transcribe')),
      'reserved',
    );
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    assert.deepEqual(harness.snapshot(), before);
    harness.store.close();
  });

  it('classifies a reserved same-id retry as uncertain when the ceiling is already full', async () => {
    const harness = speechSpendHarness(1);
    const reserved = harness.store.reserveOutboundCall({
      projectRef: harness.project.project_ref,
      epoch: 1,
      callId: spendCallId('speech:stuck', 'transcribe'),
      ceiling: 1,
    });
    assert.equal(reserved.reserved, true);
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    await assert.rejects(() => harness.transcribe('speech:stuck'), /did not finish cleanly/);
    assert.equal(harness.adapterCalls(), 0);
    assert.equal(
      harness.store.getOutboundCall(harness.project.project_ref, 1, spendCallId('speech:stuck', 'transcribe')),
      'reserved',
    );
    harness.store.close();
  });

  it('refuses a new transcription id at an exhausted ceiling without an extra adapter call', async () => {
    const harness = speechSpendHarness(1);
    const first = await harness.transcribe('speech:one');
    assert.equal(first.text.includes(MOCK_SPEECH_MARK), true);
    assert.equal(harness.adapterCalls(), 1);
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    const afterFirst = harness.snapshot();
    await assert.rejects(() => harness.transcribe('speech:two'), /outbound request ceiling reached/);
    assert.equal(harness.adapterCalls(), 1);
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    assert.equal(harness.store.getOutboundCall(harness.project.project_ref, 1, spendCallId('speech:two', 'transcribe')), null);
    assert.deepEqual(harness.snapshot(), afterFirst);
    harness.store.close();
  });

  it('does not resend a completed transcription id and never persists the draft', async () => {
    const harness = speechSpendHarness(2);
    const before = harness.snapshot();
    const first = await harness.transcribe('speech:one');
    assert.equal(first.text.includes(MOCK_SPEECH_MARK), true);
    assert.equal(harness.adapterCalls(), 1);
    const after = harness.snapshot();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.transcript, []);
    assert.equal(after.understanding, null);
    assert.equal(after.proposals, 0);
    assert.equal(after.baselines, 0);
    await assert.rejects(() => harness.transcribe('speech:one'), /already completed/);
    assert.equal(harness.adapterCalls(), 1);
    assert.equal(harness.store.countOutboundCalls(harness.project.project_ref, 1), 1);
    assert.deepEqual(harness.snapshot(), after);
    harness.store.close();
  });

  it('denies a disallowed location before any adapter call', async () => {
    let called = 0;
    const store = new SqliteProjectStore(':memory:');
    const provider = new MockLlmProvider({
      executionLocation: 'cloud',
      allowedDataClasses: ['unclassified'],
    });
    const speech = normalizeSpeechConfig({
      kind: 'mock',
      providerId: 'mock',
      model: 'mock',
    }, {
      mode: 'test',
      providers: {
        mock: { kind: 'mock', executionLocation: 'cloud', allowedDataClasses: ['unclassified'] },
      },
    });
    const adapter = createSpeechAdapter(speech, { mode: 'test' });
    const original = adapter.transcribe.bind(adapter);
    adapter.transcribe = async (...args) => {
      called += 1;
      return original(...args);
    };
    const controller = new ConversationController({
      store,
      provider,
      providers: { mock: provider },
      defaultProviderId: 'mock',
      policy: {
        epoch: 1,
        execution: 'local',
        allowedProviders: ['mock'],
        allowedDataClasses: ['unclassified'],
        dataClass: 'unclassified',
        maxOutboundCallsPerProject: 4,
        projects: {},
      },
      mode: 'test',
      speech: { ...speech, executionLocation: 'cloud', allowedDataClasses: ['unclassified'] },
      speechAdapter: adapter,
    });
    const project = controller.createProject(reviewer, {
      title: 'Denied',
      projectKinds: ['new_product'],
    });
    await assert.rejects(
      () => controller.transcribeSpeech({
        actor: reviewer,
        projectRef: project.project_ref,
        file: { bytes: SAMPLE, mimeType: 'audio/webm' },
      }),
      /execution location/,
    );
    assert.equal(called, 0);
    assert.equal(store.countOutboundCalls(project.project_ref, 1), 0);
    store.close();
  });
});
