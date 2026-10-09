import { createPluginRuntime } from '../packages/server/src/plugin-runtime.js';
import { mockConsent } from './helpers.js';
import { createMockReasoning } from '../packages/core/src/reasoning.js';

// Instrument operations after canonical admission; wrappers never acquire mock trust.
export function instrumentedMockRuntime(storage, plugin, consent = mockConsent) {
  const runtime = createPluginRuntime({ storage, reasoning: createMockReasoning(), consent });
  return { ...runtime, async admit(args) { return { ...await runtime.admit(args), plugin }; } };
}
