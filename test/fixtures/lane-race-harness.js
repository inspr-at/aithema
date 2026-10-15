// Real lanes, storage, admission, adapters and facade. Only the provider wire is fake.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { PluginRegistry, reasoningRequest, inputRevision } from '../../packages/core/src/index.js';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createClaudeHTML } from '../../plugins/claude-html/src/index.js';
import { createCompletionsHandler } from '../../plugins/elevenlabs/src/facade.js';
import { createVoiceTurnOperations } from '../../packages/server/src/voice-turns.js';
import { openRouterConfig } from '../../demo/openrouter-config.js';
import { htmlConfig } from '../../demo/html-config.js';
import { createFakeProviderKit, assessment, reply, draftHTML } from './fake-provider-kit.js';
export const laneNames = ['reaction', 'understanding', 'concept', 'voice-facade'];
export const lanePairs = laneNames.flatMap((a, i) => laneNames.slice(i + 1).map(b => [a, b]));
export const wireLane = call => call.body.model === 'anthropic/claude-race' ? 'concept'
  : call.body.messages[0].content.includes('Facade race reply') ? 'voice-facade'
  : call.body.stream ? 'reaction' : 'understanding';
export async function createLaneRaceHarness({ honorAbort = true, purposePolicy } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aithema-lane-race-')), kit = createFakeProviderKit({ honorAbort });
  const values = { OPENROUTER_MODEL: 'anthropic/race', OPENROUTER_ANALYSIS_EFFORT: 'low',
    AITHEMA_HTML_MODE: 'claude', AITHEMA_HTML_MODEL: 'anthropic/claude-race',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'anthropic/race': { prompt: 1e-6, completion: 2e-6 }, 'anthropic/claude-race': { prompt: 1e-6, completion: 2e-6 } }) };
  const config = openRouterConfig(values), html = htmlConfig(values), storage = new SQLiteStorage();
  const consent = { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision,
    checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) };
  const reasoning = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only', fetchImpl: kit.fetchImpl });
  const visuals = createClaudeHTML({ binding: html.binding, spendPath: join(dir, 'spend.json'), resolveSecret: () => 'fake-only', fetchImpl: kit.fetchImpl });
  const runtime = createPluginRuntime({ storage, consent, registry: new PluginRegistry().register(reasoning).register(visuals),
    presets: { best: { plugins: ['openrouter', 'claude-html'], bindings: { reaction: config.reaction, understanding: config.understanding, html: html.binding, visuals: 'html' },
      policy: { endpoints: [config.reaction.endpoint, html.binding.endpoint] } } } });
  const settlements = [], settle = runtime.budget.settle.bind(runtime.budget);
  runtime.budget.settle = (claim, terminal, rates) => {
    settlements.push(terminal.attemptId); return settle(claim, terminal, rates);
  };
  const logs = [], handlers = createHandlers({ storage, pluginRuntime: runtime, consent, purposePolicy, log: event => logs.push(event), concepts: { policy: { thresholds: [0, 50, 80] } } });
  const owner = 'lane-race-owner', session = storage.create({ demo: true, locale: 'de', ownerToken: owner });
  const id = session.id, controller = new AbortController(), callController = new AbortController();
  let ordinal = 0;
  const turn = (content = 'We need an API dashboard.') => {
    const turnId = `person-${++ordinal}`;
    storage.postTurn(id, turnId, Buffer.from(content), content); handlers.lanes.supersede(id); return turnId;
  };
  const source = turn();
  const call = { callId: 'race-call', providerSessionId: 'race-provider', facadeSecretRef: 'fake-reference',
    signal: callController.signal, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  const turns = createVoiceTurnOperations({ storage, log: () => {} });
  const facade = createCompletionsHandler({ log: () => {}, getCall: () => ({ ...call, paused: storage.get(id).paused }), resolveSecret: () => 'fake-only',
    turnOperations: { run: (context, execute, options) => turns.run({ ...context, sessionId: id }, execute, options) },
    buildRequest: ({ messages }) => {
      const request = reasoningRequest(storage.get(id), 'reaction', false, '', { voiceReply: true });
      return { ...request, system: request.system + '\nFacade race reply', messages: [...request.messages, ...messages] };
    },
    admitReasoning: async ({ request, options, beforeAdmission }) => {
      beforeAdmission?.();
      const admission = await runtime.admit({ session: storage.get(id), lane: 'reaction', operation: 'stream', request, options: { ...options, voiceReply: true } });
      return { ...admission, request };
    },
  });
  const route = (action = '', body) => handlers.handle(new Request(`http://fixture/api/sessions/${id}${action ? '/' + action : ''}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-aithema-session-token': owner, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const run = lane => {
    let promise;
    if (lane === 'concept') {
      handlers.conceptLane.recordIntent(id, { intentId: 'visual-wish', sourceTurnId: source });
      promise = handlers.conceptLane.run(id, { trigger: 'manual', signal: controller.signal });
    }
    else if (lane === 'voice-facade') promise = facade(new Request('http://fixture/api/voice/race-call/llm/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer fake-only' }, body: JSON.stringify({ aithema_call: call.callId, stream: false, messages: [{ role: 'user', content: `Voice input ${ordinal}` }] })
    })).then(async response => ({ status: response.status, body: await response.json() }));
    else promise = handlers.lanes.run(id, lane, { signal: controller.signal });
    // A test may intentionally await the other lane before this rejection.
    promise.catch(() => {}); return promise;
  };
  return { id, kit, storage, runtime, handlers, logs, settlements, turn, run, route, controller, callController,
    next: lane => kit.next(c => wireLane(c) === lane),
    resolve(call, options) { call.resolve(wireLane(call) === 'concept' ? draftHTML : call.body.stream ? reply : assessment, options); },
    async close() { controller.abort(); callController.abort(); kit.close(); await turns.idle(); await handlers.close(); storage.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
