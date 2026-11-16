import { voiceOverrides } from './options.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompletionsHandler, VOICE_CALLBACK_TIMEOUT_MS } from './facade.js';
import { CUSTOM_LLM_BASE_PATH } from './ensure-agent.js';
import { elevenLabsConfig } from './config.js';
import { reportBearerRejection } from './secret-repair.js';

const perCallPath = '/api/voice/:callId/llm/chat/completions';
const callRoute = /^\/api\/voice\/([a-zA-Z0-9_-]{1,128})\/llm\/chat\/completions$/u;
const spokenContinuations = Object.freeze({
  en: 'Welcome back – your AI assistant is ready to pick up where we left off.',
  de: 'Schön, dass Sie wieder da sind – Ihre KI-Assistenz ist bereit, das Gespräch fortzusetzen.',
});
const notFound = () => Response.json({ error: 'not-found' }, { status: 404, headers: { 'cache-control': 'no-store' } });

/** Private credentials and a compatibility injection for the legacy host API. */
export function createFacadeSecrets() {
  const values = new Map();
  const store = { provision(ref) { values.set(ref, randomBytes(32).toString('base64url')); },
    resolve: ref => values.get(ref), revoke: ref => { values.delete(ref); } };
  Object.defineProperty(store, 'serverAdapter', { value: elevenLabsCallbackPort });
  return store;
}

/** Bind the authenticated codec to server-owned call and reasoning operations. */
function bindCallbacks({ secrets, staticSecretRef, presentation, opener = {}, timeoutMs = VOICE_CALLBACK_TIMEOUT_MS, log, ...operations }) {
  // ensure-agent also imports server helpers; read its constant after module initialization.
  const staticPath = `${CUSTOM_LLM_BASE_PATH}/chat/completions`;
  if (!secrets?.provision || !secrets.resolve || !secrets.revoke) throw new TypeError('Private facade secret store required');
  if (presentation !== undefined && typeof presentation !== 'function') throw new TypeError('Voice presentation must be a function of the session locale');
  const loggedFallbacks = new Set();
  const eligibleOpener = (language, firstMessage) => {
    try { voiceOverrides({ agent: { language, firstMessage } }); return true; }
    catch (error) {
      if (!presentation) throw error;
      if (!loggedFallbacks.has(language)) {
        loggedFallbacks.add(language);
        try { (log ?? console.log)({ event: 'voice.host-opener-fallback', locale: language }); }
        catch { /* Diagnostics cannot interrupt speech or accounting. */ }
      }
      return false;
    }
  };
  // Without a presentation, fail closed at startup. Presentations retain their
  // own disclosing greeting for each locale whose text-only opener fails validation.
  for (const [language, firstMessage] of Object.entries(opener)) eligibleOpener(language, firstMessage);
  const facade = createCompletionsHandler({ ...operations, resolveSecret: ref => secrets.resolve(ref),
    staticSecretRef, timeoutMs, log,
    onBearerRejected: staticSecretRef ? () => reportBearerRejection(secrets) : undefined,
    onOpenerStripped() {
      try { (log ?? console.log)({ event: 'reply.opener-stripped', count: 1, lane: 'voice' }); }
      catch { /* Diagnostics cannot interrupt speech or accounting. */ }
    },
    getCall(request, options, identity) {
      return operations.getCall(staticSecretRef ? identity : callRoute.exec(new URL(request.url).pathname)?.[1],
        { ...options, callbackIdentity: Boolean(staticSecretRef) });
    } });
  return Object.freeze({
    callbackRoutes: Object.freeze([
      { method: 'POST', path: perCallPath, handle: staticSecretRef ? async () => notFound() : facade,
        ...(staticSecretRef ? { methodNotAllowedStatus: 404 } : {}) },
      ...(staticSecretRef ? [{ method: 'POST', path: staticPath, handle: facade }] : []),
    ]),
    prepareCallback({ callId, binding, locale, continuation, explicitResume = false, hasPriorTurns = false, hasPriorCalls = false, hostOpener }) {
      const facadeSecretRef = staticSecretRef ?? 'voice-' + randomUUID();
      const facadeCallId = staticSecretRef ? randomUUID() : undefined;
      // Validate the exact offered bytes on every call, from the start snapshot.
      const offered = Boolean(hostOpener && !continuation && !hasPriorTurns && eligibleOpener(locale, hostOpener));
      const context = { hasPriorTurns, ...(hasPriorCalls ? { hasPriorCalls: true } : {}),
        ...(offered ? { hostOpener } : {}) };
      // Automatic transport repair stays silent; a visitor's Resume uses host copy.
      const overrides = continuation && !explicitResume ? { agent: { language: locale, firstMessage: '' } }
        : presentation ? presentation(locale, context) : (offered
          ? { agent: { language: locale, firstMessage: hostOpener } }
          : opener[locale] && hasPriorTurns ? { agent: { language: locale, firstMessage: spokenContinuations[locale] } } : undefined);
      return { identity: facadeCallId,
        hostOpener: offered && overrides?.agent?.firstMessage === hostOpener && overrides.agent.language === locale,
        details: { facadeSecretRef, facadeCallId },
        request: { facadeSecretRef,
          facadeUrl: `${elevenLabsConfig(binding).publicFacadeBaseUrl}${staticSecretRef ? CUSTOM_LLM_BASE_PATH : `/api/voice/${callId}/llm`}`,
          ...(overrides ? { overrides } : {}) },
        receipt: staticSecretRef ? { facadeCallId } : {},
        prepare: () => { if (!staticSecretRef) return secrets.provision(facadeSecretRef); },
        revoke: () => { if (!staticSecretRef) return secrets.revoke(facadeSecretRef); } };
    },
    revokeRecord(record) { if (!staticSecretRef) return secrets.revoke(record.facadeSecretRef); },
  });
}

// The same optional callback port is exposed by the segment adapter and legacy
// credential-store injection. No generic server module constructs a codec.
export const elevenLabsCallbackPort = Object.freeze({ bindCallbacks });
