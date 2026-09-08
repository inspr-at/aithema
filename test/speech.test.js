import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import {
  MOCK_SPEECH_MARK,
  MockSpeechTranscriber,
  OpenAICompatibleTranscription,
  boundSpeechTranscript,
  assertSpeechAudio,
  createSpeechAdapter,
  filenameForSpeechMediaType,
  isAcceptedSpeechMediaType,
  normalizeSpeechConfig,
  rejectBrowserProviderOverride,
  spendCallId,
} from '../runtime/index.js';

const SAMPLE = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);

async function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('labelled speech test double', () => {
  it('is labelled non-live and returns a deterministic draft', async () => {
    const speech = new MockSpeechTranscriber();
    assert.equal(speech.live, false);
    assert.equal(speech.labelledDemo, true);
    const result = await speech.transcribe({
      bytes: SAMPLE,
      mimeType: 'audio/webm;codecs=opus',
      model: 'mock',
    });
    assert.equal(result.text.startsWith('Need a concrete sign-in check.'), true);
    assert.equal(result.text.includes(MOCK_SPEECH_MARK), true);
    assert.equal(result.live, false);
  });

  it('does not import a vendor SDK', () => {
    const source = readFileSync(fileURLToPath(new URL('../runtime/speech.js', import.meta.url)), 'utf8');
    assert.equal(/anthropic|openrouter|elevenlabs|@openai|SpeechRecognition/.test(source), false);
  });
});

describe('optional speech configuration', () => {
  const providers = {
    mock: { kind: 'mock' },
    local: {
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: 'chat-model',
      allowedModels: ['chat-model'],
      executionLocation: 'local',
      allowedDataClasses: ['unclassified'],
    },
  };

  it('defaults disabled and rejects partial or unsafe objects', () => {
    assert.equal(normalizeSpeechConfig(undefined, { providers, mode: 'test' }).enabled, false);
    assert.equal(normalizeSpeechConfig(false, { providers, mode: 'test' }).enabled, false);
    assert.equal(normalizeSpeechConfig({ enabled: false }, { providers, mode: 'test' }).enabled, false);
    assert.throws(() => normalizeSpeechConfig(true, { providers, mode: 'test' }), /must be an object/);
    assert.throws(() => normalizeSpeechConfig({}, { providers, mode: 'test' }), /providerId/);
    assert.throws(
      () => normalizeSpeechConfig({ providerId: 'local' }, { providers, mode: 'test' }),
      /speech model is required/,
    );
    assert.throws(
      () => normalizeSpeechConfig({
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper',
      }, { providers, mode: 'production' }),
      /exact transcription URL/,
    );
    assert.throws(
      () => normalizeSpeechConfig({
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        username: 'x',
      }, { providers, mode: 'production' }),
      /must not include credentials/,
    );
    assert.throws(
      () => normalizeSpeechConfig({ enabled: false, username: 'x' }, { providers, mode: 'test' }),
      /must not include credentials/,
    );
    assert.throws(
      () => normalizeSpeechConfig({
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper',
        endpoint: 'https://user:pass@whisper.example/v1/audio/transcriptions',
      }, { providers, mode: 'production' }),
      /must not include credentials/,
    );
    assert.throws(
      () => normalizeSpeechConfig({
        kind: 'mock',
        providerId: 'mock',
        model: 'mock',
      }, { providers, mode: 'production' }),
      /not allowed in production/,
    );
    assert.throws(
      () => normalizeSpeechConfig({
        kind: 'openai-compatible-transcription',
        providerId: 'local',
        model: 'whisper',
        endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
        acceptedMediaTypes: ['audio/mpeg'],
      }, { providers, mode: 'production' }),
      /audio\/webm and audio\/mp4/,
    );
  });

  it('does not treat chat compatibility as an implicit OpenAI transcription default', () => {
    assert.throws(
      () => createSpeechAdapter(normalizeSpeechConfig({
        providerId: 'local',
        model: 'whisper',
        kind: 'openai-compatible-transcription',
      }, { providers, mode: 'production' })),
      /exact transcription URL/,
    );
    const enabled = normalizeSpeechConfig({
      kind: 'openai-compatible-transcription',
      providerId: 'local',
      model: 'whisper',
      endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
    }, { providers, mode: 'production' });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.endpoint, 'http://127.0.0.1:8080/v1/audio/transcriptions');
    assert.equal(enabled.model, 'whisper');
    assert.equal(enabled.allowedModels.includes('chat-model'), false);
  });

  it('accepts only runtime webm and mp4 names and refuses silent truncate', () => {
    assert.equal(isAcceptedSpeechMediaType('audio/webm;codecs=opus'), true);
    assert.equal(isAcceptedSpeechMediaType('audio/mp4'), true);
    assert.equal(isAcceptedSpeechMediaType('audio/mpeg'), false);
    assert.equal(filenameForSpeechMediaType('audio/webm;codecs=opus'), 'recording.webm');
    assert.equal(filenameForSpeechMediaType('audio/mp4'), 'recording.mp4');
    assert.equal(boundSpeechTranscript('  hello  '), 'hello');
    assert.throws(() => boundSpeechTranscript('x'.repeat(8001)), /8000-character message limit/);
    assert.equal(spendCallId('speech:1', 'transcribe'), 'c:speech:1:transcribe');
    assert.throws(() => spendCallId('speech:1', 'tts'), /spend phase is invalid/);
    assert.throws(
      () => assertSpeechAudio({ bytes: SAMPLE, mimeType: 'audio/mpeg' }, ['audio/webm', 'audio/mp4'], 1024),
      /media type is not accepted/,
    );
    assert.throws(
      () => assertSpeechAudio({ bytes: new Uint8Array(8), mimeType: 'audio/webm' }, ['audio/webm'], 4),
      /too large/,
    );
  });
});

describe('openai-compatible completed-file transcription adapter', () => {
  it('posts multipart file, model, and response_format=json to the exact endpoint', async () => {
    /** @type {import('node:http').IncomingMessage | null} */
    let seen = null;
    let form = null;
    const server = createServer(async (req, res) => {
      seen = req;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request('http://127.0.0.1/audio/transcriptions', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks),
      });
      form = await request.formData();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'Users need a sign-in check.' }));
    });
    const origin = await listen(server);
    const endpoint = `${origin}/v1/audio/transcriptions`;
    try {
      const adapter = new OpenAICompatibleTranscription({
        id: 'local',
        endpoint,
        apiKey: 'dummy-speech-test',
        modelId: 'whisper-fixture',
        allowedModels: ['whisper-fixture'],
      });
      const result = await adapter.transcribe({
        bytes: SAMPLE,
        mimeType: 'audio/webm',
        model: 'whisper-fixture',
      });
      assert.equal(result.text, 'Users need a sign-in check.');
      assert.equal(seen?.method, 'POST');
      assert.equal(seen?.url, '/v1/audio/transcriptions');
      assert.equal(seen?.headers.authorization, 'Bearer dummy-speech-test');
      assert.match(seen?.headers['content-type'] ?? '', /multipart\/form-data/);
      assert.equal(form.get('model'), 'whisper-fixture');
      assert.equal(form.get('response_format'), 'json');
      const file = form.get('file');
      assert.equal(typeof file === 'object' && file && 'name' in file, true);
      assert.equal(file.name, 'recording.webm');
      assert.equal(file.type, 'audio/webm');
      assert.equal((await file.arrayBuffer()).byteLength, SAMPLE.byteLength);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses redirects so credentials are not forwarded', async () => {
    let secondHits = 0;
    const second = createServer((_req, res) => {
      secondHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'should-not-run' }));
    });
    const secondOrigin = await listen(second);
    const first = createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer dummy-speech-test');
      res.writeHead(302, { location: `${secondOrigin}/stolen` });
      res.end();
    });
    const firstOrigin = await listen(first);
    try {
      const adapter = new OpenAICompatibleTranscription({
        id: 'local',
        endpoint: `${firstOrigin}/v1/audio/transcriptions`,
        apiKey: 'dummy-speech-test',
        modelId: 'whisper-fixture',
        allowedModels: ['whisper-fixture'],
      });
      await assert.rejects(
        () => adapter.transcribe({ bytes: SAMPLE, mimeType: 'audio/mp4' }),
        /redirect was refused/,
      );
      assert.equal(secondHits, 0);
    } finally {
      await new Promise((resolve) => first.close(resolve));
      await new Promise((resolve) => second.close(resolve));
    }
  });

  it('aborts an in-flight transcription and refuses oversize drafts', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'x'.repeat(8001) }));
    });
    const origin = await listen(server);
    try {
      const adapter = new OpenAICompatibleTranscription({
        id: 'local',
        endpoint: `${origin}/v1/audio/transcriptions`,
        modelId: 'whisper-fixture',
        allowedModels: ['whisper-fixture'],
      });
      await assert.rejects(
        () => adapter.transcribe({ bytes: SAMPLE, mimeType: 'audio/webm' }),
        /8000-character message limit/,
      );
      const hanging = createServer(() => { /* leave open */ });
      const hangOrigin = await listen(hanging);
      const abort = new AbortController();
      const pending = new OpenAICompatibleTranscription({
        id: 'local',
        endpoint: `${hangOrigin}/v1/audio/transcriptions`,
        modelId: 'whisper-fixture',
        allowedModels: ['whisper-fixture'],
      }).transcribe({ bytes: SAMPLE, mimeType: 'audio/webm', signal: abort.signal });
      abort.abort();
      await assert.rejects(() => pending, /cancelled|AbortError/);
      await new Promise((resolve) => hanging.close(resolve));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('browser speech override rejection', () => {
  it('rejects endpoint, speech, and limit overrides while allowing providerId', () => {
    assert.throws(
      () => rejectBrowserProviderOverride({ endpoint: 'http://evil.example/audio/transcriptions' }),
      /must not supply provider endpoints/,
    );
    assert.throws(
      () => rejectBrowserProviderOverride({ speech: { model: 'x' } }),
      /must not supply provider endpoints/,
    );
    assert.throws(
      () => rejectBrowserProviderOverride({ maxAudioBytes: 99 }),
      /must not supply provider endpoints/,
    );
    assert.doesNotThrow(() => rejectBrowserProviderOverride({ providerId: 'local', model: 'whisper' }));
  });
});
