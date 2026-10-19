import { PluginError } from '@inspr/aithema-core/invocation';
import { assertVoiceMediaGrant, voiceOperation } from '@inspr/aithema-core/live-voice';
import { createComposedBrowserMedia } from '@inspr/aithema-server/composed-voice/client';
import { createNetworkRelayClient } from '@inspr/aithema-server/composed-voice/network-client';
import { createPCMCapture, createPCMPlayer } from '@inspr/aithema-server/composed-voice/browser-audio';
import { manifest } from './manifest.js';
export { manifest } from './manifest.js';

/** Normal start/control receipts plus independent PCM channels. All finals and
 * replies are persisted by the server; browser events carry no answer authority. */
export function createGrokVoiceClient({ control, openRelay, capture, player, network, audio, now = Date.now } = {}) {
  if (['start', 'close', 'pause', 'resume', 'heartbeat', 'recover'].some(name => typeof control?.[name] !== 'function')) throw new TypeError('Voice control required');
  openRelay ??= createNetworkRelayClient(network);
  capture ??= createPCMCapture(audio);
  player ??= createPCMPlayer(audio);
  let starting = false;
  const receiptGrant = receipt => {
    const grant = assertVoiceMediaGrant(receipt?.mediaGrant, now());
    if (grant.callId !== receipt.callId || grant.providerSessionId !== receipt.providerSessionId || grant.opaque.epoch !== receipt.epoch) throw new PluginError('invalid-output');
    return grant;
  };
  const media = createComposedBrowserMedia({ capture, player, now,
    control: { async recover(identity) { return receiptGrant(await control.recover(identity)); } },
    async openRelay(grant, options) {
      const transport = await openRelay(grant, options), identity = () => ({ callId: grant.callId, providerSessionId: grant.providerSessionId, epoch: grant.opaque.epoch });
      return { ...transport, recoverOnResume: true,
        command(name, ...args) {
          if (['pause', 'resume', 'heartbeat', 'close'].includes(name)) return control[name]({ ...identity(),
            ...(name === 'close' ? { reason: args[0] } : {}) }, name === 'close' ? {} : args[0]);
          return transport.command(name, ...args);
        } };
    } });
  return Object.freeze({ manifest, tabId: control.tabId,
    health: async () => ({ available: true, reason: 'not yet qualified in live use' }),
    takeover: (identity, options) => control.takeover({ ...identity, explicit: true }, options),
    closeWaiting: (identity, options) => control.close(identity, options),
    async start(request, options = {}) {
      if (starting) throw new PluginError('already-claimed');
      starting = true; let receipt, accepted = false;
      const pending = Promise.resolve().then(() => control.start(request, options));
      try {
        receipt = await voiceOperation(options, () => pending);
        const grant = receiptGrant(receipt);
        if (grant.callId !== request.callId) throw new PluginError('invalid-output');
        const session = await media.connect(grant, options); accepted = true; return session;
      } finally {
        starting = false;
        if (!accepted) void pending.then(value => control.close({ callId: value.callId, providerSessionId: value.providerSessionId,
          epoch: value.epoch, reason: 'start-failed' })).catch(() => {});
      }
    } });
}
