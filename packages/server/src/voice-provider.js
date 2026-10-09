import { createElevenLabsServer } from '../../../plugins/elevenlabs/src/server.js';

// Adapter instances capture the owned session, never a browser-selected authority.
export function createVoiceProvider({ storage, binding, resolveSecret, provisionFacade,
  revokeFacade, fetchImpl, requestProviderClose, reconcileLater, closureTimeoutMs, staticFacade = false, now = Date.now }) {
  if (!staticFacade && (typeof provisionFacade !== 'function' || typeof revokeFacade !== 'function')) throw new TypeError('Facade provisioning and revocation required');
  const ports = request => ({ binding, resolveSecret, fetchImpl, requestProviderClose, reconcileLater, closureTimeoutMs, now,
    prepareCall: staticFacade ? () => {} : (record, options) => provisionFacade({ ...record, url: request.facadeUrl }, options),
    async saveCall(record, options) {
      options.signal?.throwIfAborted();
      if (!record.providerSessionId) {
        if (record.terminal && !staticFacade) await revokeFacade(record.facadeSecretRef);
        return;
      }
      // The settings revision a call started with; recovery never continues it under another choice.
      const ack = storage.saveVoiceCall(request.sessionId, { ...record,
        ...(Number.isSafeInteger(request.settingsRevision) ? { settingsRevision: request.settingsRevision } : {}),
        ...(record.terminal?.outcome === 'uncertain' ? { reconciliationPending: true } : {}) }, { ...options, guard: { ...options.guard, ownerToken: request.ownerToken } });
      if (record.terminal && !staticFacade) await revokeFacade(record.facadeSecretRef);
      return ack;
    },
  });
  const adapter = createElevenLabsServer(ports({}));
  return { manifest: adapter.manifest, binding: adapter.binding, health: adapter.health,
    start: (request, options) => createElevenLabsServer(ports(request)).start(request, options) };
}
