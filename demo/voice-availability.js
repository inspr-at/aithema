import { PluginRegistry } from '@inspr/aithema-core';
import { createDurationBinding } from '@inspr/aithema-server';
import { normalizeElevenLabsDurationBinding } from '@inspr/aithema-plugin-elevenlabs/voice-host';

/** Prepare an isolated runtime. The host publishes it with the binding in one assignment. */
export function prepareVoiceRuntime({ current, binding: raw, createPlugin, createPresets, extendPolicy }) {
  const binding = createDurationBinding(normalizeElevenLabsDurationBinding(raw)), plugin = createPlugin(binding);
  if (current.registry.get(plugin.manifest.id)) throw new TypeError('Duplicate plugin');
  const added = new PluginRegistry().register(plugin);
  // Keep existing entries (including canonical mock identity) in their original registry.
  const registry = {
    get: id => added.get(id) ?? current.registry.get(id),
    list: () => [...current.registry.list(), ...added.list()],
    isCanonicalMock: entry => current.registry.isCanonicalMock(entry) || added.isCanonicalMock(entry),
  };
  const policy = extendPolicy(current.policy, binding);
  const recovered = createPresets({ binding, plugin, policy }), presets = { ...current.presets };
  for (const name of ['best', 'custom']) {
    const before = current.presets[name], after = recovered[name];
    if (!before?.choices || !after?.choices) continue;
    presets[name] = { ...before, policy,
      plugins: [...new Set([...before.plugins, ...after.plugins])],
      choices: { ...before.choices, voices: after.choices.voices,
        defaults: { ...before.choices.defaults, voice: after.choices.defaults.voice } } };
  }
  return { binding, runtime: { binding, registry, policy, presets } };
}

/** Stable ports held by request handlers; each read uses the active host snapshot. */
export function voiceRuntimePorts(read) {
  return {
    registry: { get: id => read().registry.get(id), list: () => read().registry.list(),
      isCanonicalMock: entry => read().registry.isCanonicalMock(entry) },
    presets: new Proxy({}, { get: (_, name) => read().presets[name] }),
  };
}
