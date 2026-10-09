import { createVoiceProvider } from './voice-provider.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { deepFreeze } from '@inspr/aithema-core';

const localStarts = new WeakSet();
export const isLocalVoice = plugin => localStarts.has(plugin?.start);
export const localVoiceBinding = Object.freeze({ plugin: 'fake-voice', model: 'local-agent', agentId: 'local-agent',
  effort: 'none', endpoint: 'https://example.test', accountRef: 'local-demo', secretRef: 'local-only',
  maxMicro: 0, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 3600,
  upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0, publicFacadeBaseUrl: 'http://localhost' });

/** Local provider fixture: no sockets, audio upload, keys or external agent. */
export function createLocalVoiceProvider({ storage, now = Date.now, ...ports }) {
  const opened = new Map();
  const plugin = createVoiceProvider({ storage, now, ...ports,
    binding: { agentId: 'local-agent', secretRef: 'local-only', apiBaseUrl: 'https://example.test',
      upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 },
    resolveSecret: () => 'local-fixture-value',
    fetchImpl: async url => {
      if (String(url).includes('/token?')) {
        const id = 'fake-' + crypto.randomUUID(); opened.set(id, now());
        return Response.json({ token: 'local-credential', conversation_id: id });
      }
      const id = String(url).split('/').at(-1), started = opened.get(id);
      return Response.json({ conversation_id: id, status: 'done', metadata: {
        start_time_unix_secs: started / 1000, call_duration_secs: Math.max(0, (now() - started) / 1000), cost: 0 } });
    },
  });
  const local = { ...plugin, manifest: deepFreeze({ ...manifest, id: 'fake-voice' }) };
  localStarts.add(local.start); return local;
}
