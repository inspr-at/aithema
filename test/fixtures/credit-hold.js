// Deterministic real-ledger/host fixture. No provider or mail transport is used.
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { SQLiteStorage, SQLiteBudgetLedger, createPluginRuntime, createHandlers } from '../../packages/server/src/index.js';
import { inputRevision, reduceUnderstanding, PluginError } from '../../packages/core/src/index.js';
import { admitCredits } from '../../packages/core/src/credits.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { mockConsent } from '../helpers.js';
import { listen } from '../../packages/server/src/http.js';

export async function creditHoldFixture({ ownerGuard = false, settledMicro = 3_900_000, holdMicro = 5_900_000, exposureMicro = 60_000_000, mockReasoning = false, locale = 'de' } = {}) {
  let time = 1_000;
  const storage = new SQLiteStorage(), owner = 'credit-hold-visitor';
  const ledger = new SQLiteBudgetLedger(storage, { sessionCapMicro: 100_000_000, visitorCapMicro: 100_000_000, now: () => time });
  const host = createDemoHost({ storage, now: () => time, ownerGuard, privacyDocumentConfigured: () => true });
  host.visitorCredits.saveSettings({ baseRevision: host.visitorCredits.settings().revision, allowancesUsd: { anonymous: '10', emailGiven: '15', emailConfirmed: '20' } }, { actor: 'ops-cli:fixture', source: 'ops-cli' });
  const session = storage.create({ ownerToken: owner, locale, demo: mockReasoning });
  storage.append(session.id, 'turn.final', { id: 'u1', role: 'user', content: 'Ich möchte eine Website.' });
  storage.append(session.id, 'turn.final', { id: 'a1', role: 'assistant', content: 'Welche Ziele haben Sie?' });
  const runtime = createPluginRuntime({ storage, budget: ledger, consent: mockConsent });
  // Fixture quote: a text/analysis invocation has a 200,000-micro maximum.
  // Read the same wallet + ledger admission rule; never use the display amount.
  runtime.matrix = async current => {
    const available = ledger.canAdmit(current.id, 200_000) && host.wallet(owner).canAdmit({ maxMicro: 200_000 });
    const onlyReconciling = ledger.canAdmitWithoutReconcilingHold(current.id, 200_000) &&
      host.wallet(owner).canAdmitWithoutReconcilingHold({ maxMicro: 200_000 });
    const verdict = { available, reason: available ? null : onlyReconciling ? 'budget reconciling' : 'budget denied' };
    return { best: { text: verdict, analysis: verdict, voice: { available: true }, uploads: { available: true } } };
  };
  if (mockReasoning) {
    const admit = runtime.admit.bind(runtime);
    runtime.admit = async args => {
      const verdict = (await runtime.matrix(args.session)).best[args.lane === 'understanding' ? 'analysis' : 'text'];
      if (!verdict.available) throw new PluginError('not-admitted', verdict.reason);
      return admit(args);
    };
  }
  const handlers = createHandlers({ storage, pluginRuntime: runtime, host, consent: mockConsent });
  const request = (lane, maxMicro, extra = {}) => ({ sessionId: session.id, lane, maxMicro,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64), ...extra });
  const spent = ledger.admit(request('reaction', settledMicro));
  const prior = ledger.claim(spent.attemptId); prior.consume();
  ledger.settle(prior.claimId, { attemptId: spent.attemptId, outcome: 'completed', chargedMicro: settledMicro,
    usage: { inputTokens: 0, outputTokens: 0 } });
  const admitted = await admitCredits(ledger, request('voice', holdMicro, { maxVisitorMicro: holdMicro,
    voiceExposure: { maxMicro: exposureMicro, maxVisitorMicro: exposureMicro },
    voiceEstimate: { upstreamMicroPerMinute: 100_000, visitorMicroPerMinute: 100_000 } }), host.wallet(owner));
  if (!admitted.ok) throw new Error('Fixture voice admission refused');
  const claim = ledger.claim(admitted.admission.attemptId); claim.consume(); time += 60_000;
  const call = (suffix, body) => handlers.handle(new Request(`http://local/api/sessions/${session.id}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { storage, ledger, host, session, owner, claim, request, call,
    handle: request => handlers.handle(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'x-aithema-session-token': owner } })),
    advance: ms => { time += ms; },
    async close() { await handlers.close(); storage.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  globalThis.fetch = () => { throw new Error('No providers in the credit hold browser fixture'); };
  let fixture = await creditHoldFixture();
  const root = new URL('../../', import.meta.url);
  const { server, url } = await listen(async request => {
    const path = new URL(request.url).pathname;
    if (path === '/fixture') {
      await fixture.close();
      const state = new URL(request.url).searchParams.get('state') ?? 'in-call';
      const locale = new URL(request.url).searchParams.get('locale') ?? 'de';
      fixture = await creditHoldFixture({ mockReasoning: true, locale, ...(state === 'low' ? { settledMicro: 8_950_000, holdMicro: 1_000_000 } : state === 'full-hold' ? { settledMicro: 0, holdMicro: 100_000 } : state === 'reconciling' ? { exposureMicro: 5_900_000 } : {}) });
      if (state === 'full-hold') {
        const { attemptId } = fixture.ledger.admit(fixture.request('reaction', 9_900_000));
        fixture.ledger.claim(attemptId).consume();
      }
      if (state.startsWith('reconciling')) fixture.ledger.retainVoiceExposure(fixture.claim.attemptId);
      const current = fixture.storage.get(fixture.session.id);
      fixture.storage.append(current.id, 'understanding.updated', reduceUnderstanding(current.understanding, {
        summary: locale === 'de' ? 'Eine Website für das Unternehmen.' : 'A website for the business.',
        signals: ['Website'], openQuestions: [locale === 'de' ? 'Wann soll die Website starten?' : 'When should the website launch?'],
        constraints: {}, progress: { talk: { value: .3 }, build: { value: .1 } },
      }, { transcript: current.transcript, inputRevision: inputRevision(current), locale, draft: true }));
      return Response.json({ session: fixture.storage.get(fixture.session.id), owner: fixture.owner });
    }
    if (path === '/reconcile') {
      fixture.ledger.settleVoice(fixture.claim.claimId, { attemptId: fixture.claim.attemptId, outcome: 'uncertain', closureConfirmed: false });
      fixture.ledger.reconcileVoice(fixture.claim.attemptId, { closureConfirmed: true, usage: { providerSeconds: 60, providerMinutes: 1,
        visitorSeconds: 60, pausedSeconds: 0, upstreamMicro: 150_000, visitorMicro: 150_000, costEstimated: false } });
      return Response.json({ ok: true });
    }
    if (path.startsWith('/api/')) {
      return fixture.handle(request);
    }
    if (path === '/') return new Response('<!doctype html><html><meta charset="utf-8"><style>body{margin:0}aithema-session{display:block;min-height:100vh}</style><aithema-session></aithema-session><script type="module" src="/packages/ui/src/session-element.js"></script></html>', { headers: { 'content-type': 'text/html' } });
    if (!/^\/packages\/(ui|core)\/src\/[a-z0-9/-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
    try { return new Response(await readFile(new URL(path.slice(1), root)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
    catch { return new Response(null, { status: 404 }); }
  });
  process.send?.({ url });
  process.once('SIGTERM', async () => { server.closeAllConnections(); await fixture.close(); server.close(); });
}
