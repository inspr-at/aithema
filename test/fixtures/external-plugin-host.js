// Host configuration only: external package, public core/server exports, real runtime.
import { PluginRegistry, createBinding, processingScope } from '@inspr/aithema-core';
import { createHandlers, createPluginRuntime, SQLiteStorage } from '@inspr/aithema-server';
import { consentItem, createExternalReasoning, manifest } from './external-plugin/index.js';

export function externalBinding(at = Date.now()) {
  const value = { plugin: manifest.id, model: manifest.models[0].id, effort: 'none',
    endpoint: 'https://external-fixture.invalid', routing: {}, accountRef: 'local-fixture', secretRef: 'unused-fixture',
    maxMicro: 100_000, maxTokens: 512, rates: { inputMicro: 1, outputMicro: 2 } };
  return createBinding({ ...value, legal: { purpose: consentItem.id, recipient: 'local-fixture', processors: [],
    dataCategories: ['messages', 'conversation-history', 'assessment'], consentVersion: consentItem.version,
    countries: ['AT'], training: false, retention: 'in-process fixture only', approved: true,
    evidence: { ...Object.fromEntries(['accountRef', 'secretRef', 'model', 'endpoint', 'routing'].map(k => [k, value[k]])),
      verifiedAt: at, expiresAt: at + 60 * 60_000, qualified: true } } });
}

export function createExternalHost({ storage = new SQLiteStorage(), reportCost = true, available = true, now = Date.now } = {}) {
  const binding = externalBinding(now()), reasoning = createExternalReasoning({ binding, reportCost, available });
  const grants = new Map(), contract = `${consentItem.id}:${consentItem.version}`;
  const scopes = ['stream', 'structured'].map(op => processingScope(binding, op));
  const consent = {
    describe(sessionId) {
      const grant = grants.get(sessionId), session = sessionId && storage.get(sessionId);
      return { contract, items: [consentItem], optional: [], intro: 'Choose the local external model.',
        withdrawal: 'You can withdraw at any time.', selected: grant && session && !session.consentWithdrawn &&
          grant.revision === session.consentRevision && grant.expiresAt > now() ? grant.items : [] };
    },
    grant({ sessionId, consentRevision, decision }) {
      if (decision?.contract !== contract || !Array.isArray(decision.items) || decision.items.length !== 1 || decision.items[0] !== consentItem.id) return false;
      grants.set(sessionId, { revision: consentRevision, items: [...decision.items], expiresAt: now() + 60_000 }); return true;
    },
    withdraw({ sessionId }) { grants.delete(sessionId); },
    coverage({ sessionId, consentRevision, scope }) {
      const grant = grants.get(sessionId), session = storage.get(sessionId);
      if (!grant || grant.revision !== consentRevision || session.consentRevision !== consentRevision || session.tombstone || session.consentWithdrawn ||
        grant.expiresAt <= now() || !scopes.some(s => JSON.stringify(s) === JSON.stringify(scope))) return { covered: false };
      return { ...structuredClone(scope), covered: true, scope: structuredClone(scope), checkedAt: now(), consentRevision, expiresAt: grant.expiresAt };
    },
  };
  const registry = new PluginRegistry().register(reasoning);
  const presets = { best: { plugins: [manifest.id], policy: { endpoints: [binding.endpoint] }, choices: {
    models: [{ id: 'external-proof', label: 'External proof model', bindings: { reaction: binding, understanding: binding } }],
    defaults: { model: 'external-proof' } } } };
  const pluginRuntime = createPluginRuntime({ storage, reasoning, registry, presets, consent });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime, consent });
  return { storage, binding, consent, registry, pluginRuntime, handlers,
    async close() { await handlers.close(); storage.close(); } };
}
