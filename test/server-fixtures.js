import { createPluginRuntime } from '../packages/server/src/plugin-runtime.js';
import { createMockReasoning } from '../packages/core/src/reasoning.js';

// Instrument operations after canonical admission; wrappers never acquire mock trust.
export function instrumentedMockRuntime(storage, plugin) {
  const runtime = createPluginRuntime({ storage, reasoning: createMockReasoning() });
  return { ...runtime, async admit(args) { return { ...await runtime.admit(args), plugin }; } };
}
