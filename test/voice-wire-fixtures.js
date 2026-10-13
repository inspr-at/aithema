import { SQLiteStorage } from '../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../packages/server/src/voice-turns.js';
import { createCompletionsHandler } from '../plugins/elevenlabs/src/facade.js';
import { mintConversationCredential, readConversationDetails, reconcileUsage } from '../plugins/elevenlabs/src/server.js';
import { beginInvocation, PluginError } from '../packages/core/src/invocation.js';
import { voiceOperation } from '../packages/core/src/live-voice.js';

// Synthetic bodies only. Preserve whitespace, order, frame boundaries and headers;
// normalize only generated reply UUIDs. The facade clock is injected, not scrubbed.
export const normalizeVoiceWire = text => text.replace(/chatcmpl-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu, 'chatcmpl-FIXTURE');
const epoch = 1_790_000_000_000;
const snapshot = async (response, partialRelease) => {
  if (!partialRelease) return { status: response.status, headers: Object.fromEntries(response.headers), body: normalizeVoiceWire(await response.text()) };
  const reader = response.body.getReader(), decoder = new TextDecoder(); let body = '';
  try {
    for (;;) {
      const item = await voiceOperation({ deadlineAt: Date.now() + 5000 }, () => reader.read());
      if (item.done) { body += decoder.decode(); break; }
      body += decoder.decode(item.value, { stream: true });
      // Make partial failure an observed wire sequence, independent of OS/task
      // scheduling. Do not collapse frames or normalize their content/order.
      if (body.includes('"delta":{"content":')) partialRelease.resolve();
    }
  } finally { partialRelease.resolve(); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: normalizeVoiceWire(body) };
};

/** Versioned wire records can also be consumed by AIT-139's callback soak harness. */
export async function recordVoiceWire() {
  const storage = new SQLiteStorage();
  const session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now: () => epoch });
  const call = { callId: 'call_fixture', providerSessionId: 'conv_fixture', facadeSecretRef: 'fixture-callback-ref',
    facadeCallId: 'facade_fixture',
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  let admissions = 0, partialRelease;
  const facadePorts = { now: () => epoch, log: () => {},
    getCall: () => call, resolveSecret: () => 'fixture-callback-value',
    buildRequest: ({ messages }) => ({ system: 'Canonical fixture prompt', locale: 'de', messages }),
    turnOperations: { run: (context, execute, options) => turns.run({ ...context, sessionId: session.id }, execute, options) },
    admitReasoning({ request, options, beforeAdmission }) {
      beforeAdmission?.();
      const attemptId = `fixture-attempt-${++admissions}`;
      return { request, producer: { plugin: 'fixture', model: 'fixture-model' },
        options: { ...options, attempt: { attemptId, claimId: `fixture-claim-${admissions}`, consume() {} }, report() {} },
        plugin: { async *stream(input, opts) {
          const invocation = await beginInvocation(opts); let completed = false;
          try {
            invocation.dispatch();
            if (input.messages.at(-1).content === 'opener guard') yield 'Danke für die Info. ';
            yield 'Die erste Frage: ';
            if (input.messages.at(-1).content === 'partial failure') { await partialRelease.promise; throw new PluginError('provider'); }
            yield 'Was soll entstehen?'; invocation.usage({ inputTokens: 7, outputTokens: 5 }); completed = true;
          } finally { await invocation.finish(completed); }
        } }, finish() {} };
    } };
  const handler = createCompletionsHandler(facadePorts);
  const staticHandler = createCompletionsHandler({ ...facadePorts, staticSecretRef: 'fixture-static-ref' });
  const base = { model: 'untrusted-model', elevenlabs_extra_body: { aithema_call: call.callId },
    messages: [{ role: 'system', content: 'Untrusted prompt' }, { role: 'user', content: 'Ja' }], stream: true };
  const callbackCases = [
    ['stream', base], ['retry-stream', base], ['retry-json', { ...base, stream: false }],
    ['history-growth', { ...base, messages: [...base.messages, { role: 'assistant', content: 'Eine Frage.' }, { role: 'user', content: 'Ja' }] }],
    ['unknown-history', { ...base, history_truncated: true }],
    ['opener-guard', { ...base, messages: [{ role: 'user', content: 'opener guard' }] }],
    ['partial-failure', { ...base, messages: [{ role: 'user', content: 'partial failure' }] }],
    ['unauthorized', base, 'Bearer fixture-wrong'],
    ['wrong-call', { ...base, elevenlabs_extra_body: { aithema_call: 'foreign' } }],
    ['static-stream', { ...base, elevenlabs_extra_body: { aithema_call: call.facadeCallId } }, undefined, true],
    ['static-retry-json', { ...base, stream: false, elevenlabs_extra_body: { aithema_call: call.facadeCallId } }, undefined, true],
    ['static-unauthorized', { ...base, elevenlabs_extra_body: { aithema_call: call.facadeCallId } }, 'Bearer fixture-wrong', true],
  ];
  const callbacks = [];
  try {
    for (const [name, body, authorization = 'Bearer fixture-callback-value', staticRoute] of callbackCases) {
      partialRelease = name === 'partial-failure' ? Promise.withResolvers() : undefined;
      const request = { method: 'POST', url: staticRoute ? 'https://host.example.test/api/voice/llm/chat/completions'
        : 'https://host.example.test/api/voice/call_fixture/llm/chat/completions',
        headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body) };
      callbacks.push({ name, request, response: await snapshot(await (staticRoute ? staticHandler : handler)(new Request(request.url, request)), partialRelease) });
    }
    await turns.idle();
  } finally { await turns.idle(); storage.close(); }
  const binding = { agentId: 'agent_fixture', secretRef: 'fixture-api-ref', apiBaseUrl: 'https://api.example.test',
    upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300, usdPerCredit: 0.000264 };
  const mints = [];
  for (const transport of ['webrtc', 'websocket']) {
    const body = transport === 'webrtc' ? { token: 'fixture-token', conversation_id: 'conv_fixture' }
      : { signed_url: 'wss://socket.example.test/call?conversation_id=conv_fixture&signature=fixture', conversation_id: 'conv_fixture' };
    const record = { name: transport, response: { status: 200, body: JSON.stringify(body) } };
    record.grant = await mintConversationCredential(binding, { transport }, { deadlineAt: Date.now() + 1000 }, {
      resolveSecret: () => 'fixture-api-value', fetchImpl: async (url, options) => {
        record.request = { method: 'GET', url, headers: options.headers, redirect: options.redirect };
        return Response.json(body);
      } });
    mints.push(record);
  }
  const reconciliation = [];
  const storedCall = { providerSessionId: 'conv_fixture', startedAt: epoch,
    pauses: [{ from: epoch + 10_000, to: epoch + 30_000 }], exposureMicro: 2000 };
  for (const [name, status, cost] of [
    ['delayed-closure', 'processing', { cost: 17 }], ['delayed-usage', 'done', {}],
    ['fiat-total', 'done', { cost_fiat: 0.00123, cost: 17 }],
    ['credit-total', 'done', { cost: 17, charging: { platform_charge: 100, llm_charge: 100, analysis: { total: { charge: 100 } } } }],
    ['component-total', 'done', { charging: { call_charge: 10, llm_charge: 5, analysis: { total: { charge: 2 } } } }],
    ['incomplete-components', 'done', { charging: { call_charge: 10, llm_charge: 5 } }],
    ['zero-credit', 'done', { cost: 0 }],
  ]) {
    const body = { conversation_id: 'conv_fixture', status,
      metadata: { call_duration_secs: 120, start_time_unix_secs: epoch / 1000, ...cost } };
    let request;
    const details = await readConversationDetails(binding, storedCall.providerSessionId, { deadlineAt: Date.now() + 1000 }, {
      resolveSecret: () => 'fixture-api-value', fetchImpl: async (url, options) => {
        request = { method: 'GET', url, headers: options.headers, redirect: options.redirect }; return Response.json(body);
      } });
    reconciliation.push({ name, request, response: { status: 200, body: JSON.stringify(body) }, call: storedCall,
      terminal: reconcileUsage({ call: storedCall, details, binding, maxMicro: 1000 }) });
  }
  return { format: 'aithema-voice-wire', version: 1, baseline: '550b4de', sanitization: 'synthetic inputs; generated reply UUID only',
    callbacks, admissions, mints, reconciliation };
}
