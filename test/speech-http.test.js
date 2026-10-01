import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { sha256Hex, validate } from '../contracts/validate.js';
import { OpenAISpeechToText, OpenAITextToSpeech, LocalChatterboxTextToSpeech,
  ElevenLabsSpeechToText, ElevenLabsTextToSpeech, createSpeechToTextPort, createTextToSpeechPort } from '../runtime/speech/index.js';
import { authority, barrier, claimed, collect, config, events, host, server, sttRequest, ttsRequest, wav } from './fixtures/speech/helpers.mjs';

for (const Adapter of [OpenAISpeechToText, ElevenLabsSpeechToText]) {
  it(`(a) ${Adapter.name}: claimed exact multipart WAV bytes, approved model, German, no speaker ID`, async (t) => {
    const { client, journal, ledger } = host(t);
    let body, headers;
    const endpoint = await server(t, async (req, res) => {
      claimed(ledger);
      headers = req.headers;
      const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'Synthetischer Test.' }));
    });
    const adapter = new Adapter(config(client, `${endpoint}/transcribe`));
    assert.deepEqual(await createSpeechToTextPort(adapter).transcribe(sttRequest()), { text: 'Synthetischer Test.' });
    const records = events(journal);
    assert.deepEqual(records.map((record) => record.kind), ['budget.hold', 'budget.claim', 'budget.settle']);
    assert.equal(records[1].data.request_sha256, sha256Hex(body));
    assert.ok(body.includes(wav())); assert.match(headers['content-type'], /multipart\/form-data; boundary=/);
    assert.match(body.toString(), /fixture-model/); assert.match(body.toString(), /\r\nde\r\n/);
    if (Adapter === ElevenLabsSpeechToText) {
      assert.match(body.toString(), /name="model_id"/); assert.match(body.toString(), /name="diarize"\r\n\r\nfalse/);
    } else assert.match(body.toString(), /name="model"/);
    assert.ok(records.every((record) => validate(record.contract, record).ok));
    assert.equal(records.at(-1).data.charged_micro, 100);
    assert.deepEqual((await client.listOpen()).holds, []);
  });
}

for (const Adapter of [OpenAITextToSpeech, ElevenLabsTextToSpeech, LocalChatterboxTextToSpeech]) {
  it(`(b) ${Adapter.name}: streams PCM, preserves split samples, digests exact JSON and settles`, async (t) => {
    const local = Adapter === LocalChatterboxTextToSpeech;
    const { client, journal, ledger } = host(t, local);
    let body, route;
    const endpoint = await server(t, async (req, res) => {
      claimed(ledger); route = req.url;
      const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.from([1]));
      setImmediate(() => res.end(Buffer.from([2, 3, 4])));
    });
    const adapter = new Adapter(config(client, `${endpoint}/speech`, { maxMicro: local ? 0 : 100 }));
    const result = await createTextToSpeechPort(adapter).synthesize(ttsRequest());
    assert.deepEqual(result.bytes, Buffer.from([1, 2, 3, 4]));
    assert.equal(result.mimeType, 'audio/pcm'); assert.equal(result.sampleRate, Adapter === ElevenLabsTextToSpeech ? 16000 : 24000);
    const parsed = JSON.parse(body);
    if (Adapter === ElevenLabsTextToSpeech) {
      assert.equal(parsed.model_id, 'fixture-model'); assert.match(route, /fixture-voice\/stream\?output_format=pcm_16000$/);
    } else { assert.equal(parsed.voice, 'fixture-voice'); assert.equal(parsed.response_format, 'pcm'); }
    const records = events(journal);
    assert.equal(records[1].data.request_sha256, sha256Hex(body));
    assert.equal(records.at(-1).data.outcome, 'settled');
    assert.equal(records.at(-1).data.charged_micro, local ? 0 : 100);
  });
}

for (const Adapter of [OpenAISpeechToText, ElevenLabsSpeechToText, OpenAITextToSpeech, ElevenLabsTextToSpeech, LocalChatterboxTextToSpeech]) {
  const stt = Adapter.name.includes('SpeechToText');
  const local = Adapter === LocalChatterboxTextToSpeech;
  it(`(d) ${Adapter.name}: abort closes mid-response socket, settles unknown and yields nothing late`, { timeout: 5000 }, async (t) => {
    const { client, journal, ledger } = host(t, local);
    const received = barrier(), disconnected = barrier();
    const endpoint = await server(t, async (req, res) => {
      claimed(ledger); for await (const ignored of req) { /* drain */ }
      res.on('close', disconnected.resolve);
      res.writeHead(200, { 'content-type': stt ? 'application/json' : 'audio/pcm' });
      res.write(stt ? '{"text":"' : Buffer.from([1, 2])); received.resolve();
    });
    const abort = new AbortController();
    const adapter = new Adapter(config(client, endpoint, { maxMicro: local ? 0 : 100 }));
    const iterator = stt ? adapter.streamTranscribe(sttRequest(abort.signal)) : adapter.streamSynthesize(ttsRequest(abort.signal));
    const outputs = [];
    const work = (async () => { for await (const chunk of iterator) outputs.push(chunk); })();
    const rejection = assert.rejects(work, { name: 'AbortError' });
    await received.promise;
    if (!stt) { while (!outputs.length) await new Promise((resolve) => setImmediate(resolve)); }
    const prior = outputs.length; abort.abort();
    await rejection; await disconnected.promise;
    assert.equal(outputs.length, prior);
    assert.equal((await iterator.next()).done, true);
    const settle = events(journal).at(-1).data;
    assert.equal(settle.outcome, 'unknown'); assert.equal(settle.charged_micro, local ? 0 : 100);
    assert.deepEqual((await client.listOpen()).holds, []);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  });

  it(`${Adapter.name}: denied/pre-aborted/unapproved attempts open no socket`, async (t) => {
    const { client, journal } = host(t, local, local ? {} : { session_cap_micro: 0 });
    let connections = 0;
    const endpoint = await server(t, () => { connections++; assert.fail('No request allowed'); });
    const adapter = new Adapter(config(client, endpoint, { maxMicro: local ? 0 : 100 }));
    const invoke = (input) => stt ? adapter.transcribe(input) : adapter.synthesize(input);
    const input = stt ? sttRequest() : ttsRequest();
    const abort = new AbortController(); abort.abort();
    await assert.rejects(invoke({ ...input, signal: abort.signal }), { name: 'AbortError' });
    await assert.rejects(invoke({ ...input, model: 'unapproved' }), /Unapproved/);
    await assert.rejects(invoke({ ...input, executionContext: undefined }), /attempt_id/);
    if (!local) await assert.rejects(invoke(input), { code: 'budget_denied' });
    assert.equal(connections, 0); assert.deepEqual(events(journal), []);
  });
}

it('admission followed by abort voids the unclaimed hold; malformed claim never opens transport', async (t) => {
  const { client, journal } = host(t);
  const abort = new AbortController();
  const wrapped = {
    get authority() { return client.authority; },
    admit: async (body) => { const hold = await client.admit(body); abort.abort(); return hold; },
    ...Object.fromEntries(['claim', 'settle', 'recover', 'isCurrent', 'listOpen'].map((method) => [method, client[method].bind(client)])),
  };
  const adapter = new OpenAISpeechToText(config(wrapped, 'http://127.0.0.1:9/transcribe', { fetchImpl: () => assert.fail('No socket') }));
  await assert.rejects(adapter.transcribe(sttRequest(abort.signal)), { name: 'AbortError' });
  assert.deepEqual((await client.listOpen()).holds, []);
  assert.equal(events(journal).length, 1); // recovery, not an invented claim/settle
  wrapped.admit = client.admit.bind(client); wrapped.claim = async () => ({ claim_id: 'invalid' });
  await assert.rejects(adapter.transcribe(sttRequest(undefined, 2)), /fresh valid claim_id/);
  assert.deepEqual((await client.listOpen()).holds, []);
});

it('claim refusal opens no socket and voids the unclaimed reservation', async (t) => {
  const { client } = host(t);
  const budget = { get authority() { return client.authority; },
    ...Object.fromEntries(['admit', 'settle', 'recover', 'isCurrent', 'listOpen'].map((method) => [method, client[method].bind(client)])),
    claim: async () => { throw new Error('Refused claim'); } };
  const adapter = new OpenAITextToSpeech(config(budget, 'http://127.0.0.1:9/speech', { fetchImpl: () => assert.fail('No socket') }));
  await assert.rejects(adapter.synthesize(ttsRequest()), /Refused claim/);
  assert.deepEqual((await client.listOpen()).holds, []);
});

it('early iterator return cancels stalled PCM transport and settles unknown', { timeout: 5000 }, async (t) => {
  const { client, journal } = host(t);
  const closed = barrier();
  const endpoint = await server(t, (req, res) => {
    req.resume(); res.on('close', closed.resolve); res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.from([1, 2]));
  });
  const stream = new OpenAITextToSpeech(config(client, endpoint)).streamSynthesize(ttsRequest());
  assert.equal((await stream.next()).value.length, 2);
  await stream.return(); await closed.promise;
  assert.equal(events(journal).at(-1).data.outcome, 'unknown');
});

for (const response of ['not JSON', '{"text":""}', '{"text":17}', '{"text":"xxxxxxxx"}']) {
  it(`refuses malformed/empty/bounded STT output: ${response}`, async (t) => {
    const { client, journal } = host(t);
    const endpoint = await server(t, (req, res) => { req.resume(); res.end(response); });
    const adapter = new OpenAISpeechToText(config(client, endpoint, { limits: { maxTextChars: 4 } }));
    await assert.rejects(adapter.transcribe(sttRequest()));
    assert.equal(events(journal).at(-1).data.outcome, 'unknown');
  });
}

for (const kind of ['odd', 'empty', 'type', 'oversize', 'redirect', 'error', 'truncate']) {
  it(`refuses ${kind} TTS output without success settlement`, async (t) => {
    const { client, journal } = host(t);
    let redirectRequests = 0;
    const endpoint = await server(t, (req, res) => {
      req.resume();
      if (req.url === '/redirected') { redirectRequests++; res.end(); return; }
      if (kind === 'redirect') { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
      res.writeHead(kind === 'error' ? 500 : 200, { 'content-type': kind === 'type' ? 'application/json' : 'audio/pcm',
        ...(kind === 'truncate' ? { 'content-length': '10' } : {}) });
      res.end(kind === 'empty' ? Buffer.alloc(0) : Buffer.from(kind === 'odd' ? [1] : [1, 2, 3, 4]));
      if (kind === 'truncate') res.socket?.destroy();
    });
    const adapter = new OpenAITextToSpeech(config(client, endpoint, { limits: { maxResponseBytes: kind === 'oversize' ? 2 : 100, maxDurationMs: 500 } }));
    await assert.rejects(adapter.synthesize(ttsRequest()));
    assert.equal(events(journal).at(-1).data.outcome, 'unknown'); assert.equal(redirectRequests, 0);
  });
}

it('duplicate attempt is never resent; a retry uses its own hold and claim', async (t) => {
  const { client, journal } = host(t);
  let requests = 0;
  const endpoint = await server(t, (req, res) => { requests++; req.resume(); res.writeHead(500); res.end(); });
  const adapter = new OpenAITextToSpeech(config(client, endpoint));
  await assert.rejects(adapter.synthesize(ttsRequest()));
  await assert.rejects(adapter.synthesize(ttsRequest()));
  assert.equal(requests, 1);
  await assert.rejects(adapter.synthesize(ttsRequest(undefined, 2)));
  assert.equal(requests, 2);
  assert.equal(new Set(events(journal).filter((r) => r.kind === 'budget.claim').map((r) => r.data.claim_id)).size, 2);
});

it('rejects unsafe endpoint, local DNS, remote zero cost, invalid signals and malformed WAV before admission', async (t) => {
  const { client, journal } = host(t);
  for (const endpoint of ['http://remote.example.invalid/speech', 'https://user:password@example.invalid', 'https://example.invalid?q=1', 'file:///tmp/audio']) {
    assert.throws(() => new OpenAITextToSpeech(config(client, endpoint)));
  }
  for (const endpoint of ['http://localhost:9/speech', 'https://remote.example.invalid/speech']) {
    assert.throws(() => new LocalChatterboxTextToSpeech(config(client, endpoint)));
  }
  assert.throws(() => new OpenAITextToSpeech(config(client, 'https://example.invalid', { maxMicro: 0 })));
  const adapter = new OpenAISpeechToText(config(client, 'http://127.0.0.1:9/transcribe', { fetchImpl: () => assert.fail('No transport') }));
  await assert.rejects(adapter.transcribe(sttRequest({ aborted: false })), TypeError);
  const malformed = wav(); malformed.writeUInt32LE(48000, 24);
  for (const input of [{ bytes: Buffer.alloc(0) }, { bytes: malformed }, { mimeType: 'audio/mp3' }, { bytes: wav(Array(480001).fill(0)) }, { bytes: wav().subarray(0, 45) }]) {
    await assert.rejects(adapter.transcribe({ ...sttRequest(), ...input }));
  }
  assert.deepEqual(events(journal), []);
});

it('a transport returning a late response after abort has its body disposed without output', async (t) => {
  const { client, journal } = host(t);
  const started = barrier(), late = barrier(), cancelled = barrier();
  const abort = new AbortController();
  const adapter = new OpenAISpeechToText(config(client, 'http://127.0.0.1:9/transcribe', {
    fetchImpl: () => { started.resolve(); return late.promise; },
  }));
  const work = adapter.transcribe(sttRequest(abort.signal));
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await started.promise; abort.abort(); await rejected;
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
  await cancelled.promise;
  assert.equal(events(journal).at(-1).data.outcome, 'unknown');
});

it('cancellation never hides settlement/recovery failure; caller sees the aggregate and can recover', async (t) => {
  const { client } = host(t);
  const abort = new AbortController(), started = barrier();
  const broken = {
    get authority() { return client.authority; },
    ...Object.fromEntries(['admit', 'claim', 'isCurrent', 'listOpen'].map((method) => [method, client[method].bind(client)])),
    settle: async () => { throw new Error('Ledger settlement unavailable'); },
    recover: async () => { throw new Error('Ledger recovery unavailable'); },
  };
  const adapter = new OpenAISpeechToText(config(broken, 'http://127.0.0.1:9/transcribe', {
    fetchImpl: async () => { started.resolve(); return new Response(new ReadableStream({})); },
  }));
  const work = adapter.transcribe(sttRequest(abort.signal));
  const rejected = assert.rejects(work, (error) => error instanceof AggregateError);
  await started.promise; abort.abort(); await rejected;
  assert.equal((await client.listOpen()).holds.length, 1);
  assert.equal((await client.recoverOpen())[0].closed_reason, 'unknown');
});

it('already claimed attempts are not resent, including concurrent callers sharing an attempt id', async (t) => {
  const { client, journal } = host(t);
  const opened = barrier(); let finish, requests = 0;
  const endpoint = await server(t, (req, res) => {
    requests++; req.resume(); finish = () => res.end('{"text":"Synthetic concurrency"}'); opened.resolve();
  });
  const adapter = new OpenAISpeechToText(config(client, endpoint));
  const first = adapter.transcribe(sttRequest()); await opened.promise;
  await assert.rejects(adapter.transcribe(sttRequest()), { code: 'already_claimed' });
  finish();
  assert.deepEqual(await first, { text: 'Synthetic concurrency' });
  assert.equal(requests, 1); assert.equal(events(journal).filter((row) => row.kind === 'budget.claim').length, 1);
  assert.equal(events(journal).at(-1).data.outcome, 'settled');
});

it('known operator pricing settles the actual amount using bounded audio units', async (t) => {
  const { client, journal } = host(t);
  let usage;
  const endpoint = await server(t, (req, res) => { req.resume(); res.end('{"text":"Synthetic priced audio"}'); });
  const adapter = new OpenAISpeechToText(config(client, endpoint, { priceUsage: (input, lane) => {
    usage = input; assert.equal(lane, 'stt'); return 17;
  } }));
  await adapter.transcribe(sttRequest());
  assert.equal(usage.input_seconds, 4 / 16000); assert.equal(usage.provider_usage, null);
  assert.equal(events(journal).at(-1).data.charged_micro, 17);
  assert.equal(events(journal).at(-1).data.outcome, 'settled');
});

for (const finalCost of [undefined, -1, 1.5, 101, '17']) {
  it(`unprovable/invalid final speech cost ${String(finalCost)} settles unknown at maximum`, async (t) => {
    const { client, journal } = host(t);
    const endpoint = await server(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'audio/pcm' }); res.end(Buffer.from([1, 2])); });
    const adapter = new OpenAITextToSpeech(config(client, endpoint, { priceUsage: () => finalCost }));
    await assert.rejects(adapter.synthesize(ttsRequest()), (error) => error.reason === 'invalid_usage');
    assert.equal(events(journal).at(-1).data.outcome, 'unknown'); assert.equal(events(journal).at(-1).data.charged_micro, 100);
  });
}
