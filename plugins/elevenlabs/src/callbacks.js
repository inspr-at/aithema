import { randomBytes, randomUUID } from 'node:crypto';
import { createCompletionsHandler } from './facade.js';
import { CUSTOM_LLM_BASE_PATH } from './ensure-agent.js';
import { elevenLabsConfig } from './config.js';

const perCallPath = '/api/voice/:callId/llm/chat/completions';
const callRoute = /^\/api\/voice\/([a-zA-Z0-9_-]{1,128})\/llm\/chat\/completions$/u;
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
function bindCallbacks({ secrets, staticSecretRef, presentation, timeoutMs, log, ...operations }) {
  // ensure-agent also imports server helpers; read its constant after module initialization.
  const staticPath = `${CUSTOM_LLM_BASE_PATH}/chat/completions`;
  if (!secrets?.provision || !secrets.resolve || !secrets.revoke) throw new TypeError('Private facade secret store required');
  if (presentation !== undefined && typeof presentation !== 'function') throw new TypeError('Voice presentation must be a function of the session locale');
  const facade = createCompletionsHandler({ ...operations, resolveSecret: ref => secrets.resolve(ref),
    staticSecretRef, timeoutMs,
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
    prepareCallback({ callId, binding, locale, continuation, explicitResume = false, hasPriorTurns = false }) {
      const facadeSecretRef = staticSecretRef ?? 'voice-' + randomUUID();
      const facadeCallId = staticSecretRef ? randomUUID() : undefined;
      // Automatic transport repair stays silent; a visitor's Resume uses host copy.
      const overrides = continuation && !explicitResume ? { agent: { language: locale, firstMessage: '' } }
        : presentation?.(locale, { hasPriorTurns });
      return { identity: facadeCallId,
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
