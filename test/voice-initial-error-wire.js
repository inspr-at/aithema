import { SQLiteStorage } from '../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../packages/server/src/voice-turns.js';
import { createCompletionsHandler } from '../plugins/elevenlabs/src/facade.js';
import { beginInvocation, PluginError } from '../packages/core/src/invocation.js';

export const INITIAL_ERROR_EPOCH = 1_790_000_000_000;
export const INITIAL_ERROR_CAUSES = ['fenced', 'paused', 'consent-revoked', 'deadline', 'cancel'];
const normalize = text => text.replace(/chatcmpl-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu, 'chatcmpl-FIXTURE');

// The worker loses permission or expires after returning its unread SSE body.
// Reader authority stays current, isolating the pre-first-frame worker failure
// from the separate voice-turn-* claim/replay/reader refusals.
export async function recordInitialErrorWire(t, cause) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: INITIAL_ERROR_EPOCH });
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now: () => INITIAL_ERROR_EPOCH });
  t.after(async () => { await turns.idle(); storage.close(); });
  const cancellation = new AbortController(), reports = [];
  let blocked = false, admissions = 0, finishes = 0, completions = 0;
  const call = { callId: 'call_initial_error', providerSessionId: 'conv_initial_error', facadeSecretRef: 'fixture-ref',
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  const handler = createCompletionsHandler({ now: () => INITIAL_ERROR_EPOCH, log: () => {},
    getCall: () => call, resolveSecret: () => 'fixture-value',
    buildRequest: ({ messages }) => ({ locale: 'de', messages }),
    onCompletion() { completions++; },
    turnOperations: { run(context, execute, options) {
      return turns.run({ ...context, sessionId: session.id }, async worker => {
        const response = await execute({ ...worker, assertCurrent() {
          worker.assertCurrent();
          if (blocked) throw new PluginError('not-admitted', `worker-${cause}`);
        } });
        if (cause === 'deadline') t.mock.timers.tick(100);
        else if (cause === 'cancel') cancellation.abort();
        else blocked = true;
        return response;
      }, options);
    } },
    admitReasoning({ request, options, beforeAdmission }) {
      beforeAdmission(); admissions++;
      return { request, producer: { plugin: 'fixture', model: 'fixture-model' },
        options: { ...options, signal: cancellation.signal, deadlineAt: Date.now() + 100,
          attempt: { attemptId: 'fixture-attempt', claimId: 'fixture-claim', consume() {} },
          report(terminal) { reports.push(terminal); } },
        plugin: { async *stream(input, opts) {
          const invocation = await beginInvocation(opts);
          try { invocation.dispatch(); yield 'Unpublished text'; }
          finally { await invocation.finish(false); }
        } }, finish() { finishes++; } };
    },
  });
  const response = await handler(new Request('https://host.example.test/voice/call_initial_error/completions', {
    method: 'POST', headers: { authorization: 'Bearer fixture-value', 'content-type': 'application/json' },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: call.callId }, stream: true,
      messages: [{ role: 'user', content: 'Ja' }] }),
  }));
  const wire = { status: response.status, headers: Object.fromEntries(response.headers), body: normalize(await response.text()) };
  await turns.idle();
  return { wire, admissions, finishes, completions, reports,
    operation: storage.voiceOperations(session.id)[0] };
}
