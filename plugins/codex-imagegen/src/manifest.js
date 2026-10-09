import { deepFreeze } from '@inspr/aithema-core';

// D4: account, CLI paths, timeout, consent and qualification remain host-private.
export const manifest = deepFreeze({
  id: 'codex-imagegen', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['ui-generation'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  vendor: { name: 'OpenAI Codex', url: 'https://developers.openai.com/codex/cli/' },
  models: [{ id: '*', operations: ['generate', 'edit'], streaming: false, structured: false,
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], languages: ['en', 'de'],
    germanQuality: 'unverified', formats: ['image/png', 'image/webp', 'image/jpeg'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null, evidence: [],
    // Subscription-backed CLI invocation, not a claim about subscription prices or token usage.
    cost: { unit: 'invocation', inputMicro: 0, outputMicro: 0, reviewedAt: null } }],
});
