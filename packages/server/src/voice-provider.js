import { createElevenLabsServer } from '../../../plugins/elevenlabs/src/server.js';

// Adapter instances capture the owned session, never a browser-selected authority.
export function createVoiceProvider({ storage, binding, resolveSecret, provisionFacade,
  revokeFacade, fetchImpl, requestProviderClose, reconcileLater, closureTimeoutMs, now = Date.now }) {
  if (typeof provisionFacade !== 'function' || typeof revokeFacade !== 'function') throw new TypeError('Facade provisioning and revocation required');
  const ports = request => ({ binding, resolveSecret, fetchImpl, requestProviderClose, reconcileLater, closureTimeoutMs, now,
    prepareCall: (record, options) => provisionFacade({ ...record, url: request.facadeUrl }, options),
    async saveCall(record, options) {
      options.signal?.throwIfAborted();
      if (!record.providerSessionId) {
        if (record.terminal) await revokeFacade(record.facadeSecretRef);
        return;
      }
      const ack = storage.saveVoiceCall(request.sessionId, { ...record,
        ...(record.terminal?.outcome === 'uncertain' ? { reconciliationPending: true } : {}) }, { ...options, guard: { ...options.guard, ownerToken: request.ownerToken } });
      if (record.terminal) await revokeFacade(record.facadeSecretRef);
      return ack;
    },
  });
  const adapter = createElevenLabsServer(ports({}));
  return { manifest: adapter.manifest, binding: adapter.binding, health: adapter.health,
    start: (request, options) => createElevenLabsServer(ports(request)).start(request, options) };
}
