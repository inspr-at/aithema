// The demo operator's allowlist. Locally every selectable option runs without a
// provider network, and real providers are declared so the settings screen shows how
// a host lists them. An explicitly selected provider makes the demo a live host: it
// then offers only its configured routes, so visitors never meet a mock there.

/**
 * Voice or image mode for this host. Fake providers are local-demo only: a live host
 * defaults to off and never runs them, even when the variable says fake.
 */
export function providerMode(value, live) {
  const mode = value ?? (live ? 'off' : 'fake');
  return live && mode === 'fake' ? 'off' : mode;
}
const mock = (model, effort) => ({ plugin: 'mock', model, effort, endpoint: 'https://example.test', accountRef: 'demo',
  secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
export const demoModels = Object.freeze({
  mock: { id: 'mock', label: 'Mock reasoning', binding: mock('mock', 'none'), efforts: ['none'] },
  swift: { id: 'mock/swift', label: 'Swift (mock)', binding: mock('mock/swift', 'none'), efforts: ['none', 'low'], effort: 'none' },
  deep: { id: 'mock/deep', label: 'Deep (mock)', binding: mock('mock/deep', 'medium'), efforts: ['low', 'medium', 'high'], effort: 'medium' },
});

/**
 * Presets for the demo host. `reaction` and `understanding` are the selected provider's
 * private bindings; without account evidence (Mistral) admission reports them unverified.
 * A provider route keeps its configured effort: response styles need a host that has
 * sized its token ceilings for reasoning.
 */
export function demoPresets({ provider = 'mock', reaction, understanding = reaction, voicePlugin, voiceBinding, imagePlugin, imageBinding,
  htmlPlugin, htmlBinding, htmlDemo = false, policy }) {
  const option = (id, label, plugin, binding, kind) => ({ id, label, ...(kind ? { kind } : {}), ...(plugin?.manifest.id === id ? { binding } : {}) });
  let voices = [option('fake-voice', 'Fake voice (local agent)', voicePlugin, voiceBinding), option('elevenlabs', 'ElevenLabs', voicePlugin, voiceBinding)];
  // One Visuals control: HTML click-dummies and image concepts are alternatives of one choice.
  let visuals = [option('fake-html', 'Fake HTML (local click-dummy)', htmlPlugin, htmlBinding, 'html'),
    option('claude-html', 'Claude HTML click-dummy', htmlPlugin, htmlBinding, 'html'),
    option('fake-images', 'Fake images (local PNG)', imagePlugin, imageBinding), option('openai-images', 'OpenAI GPT Image 2', imagePlugin, imageBinding)];
  const extras = [voicePlugin, imagePlugin, htmlPlugin].filter(Boolean).map(plugin => plugin.manifest.id);
  if (provider !== 'mock') {
    const vendor = provider === 'mistral' ? 'Mistral' : 'OpenRouter';
    const route = { id: `${provider}/${reaction.model}`, bindings: { reaction, understanding },
      label: reaction.model === understanding.model ? `${reaction.model} via ${vendor}` : `${reaction.model} and ${understanding.model} via ${vendor}` };
    // Only configured live providers; the operator's explicit fake HTML is labelled a demo.
    const live = o => o.binding && (!o.id.startsWith('fake-') || htmlDemo && o.id === 'fake-html');
    voices = voices.filter(live);
    visuals = visuals.filter(live).map(o => o.id === 'fake-html' ? { ...o, label: 'Demo only: fake HTML click-dummy (no provider)' } : o);
    const offered = new Set([...voices, ...visuals].map(o => o.binding.plugin));
    return {
      best: { plugins: [provider, ...extras.filter(id => offered.has(id))], policy, choices: { models: [route], voices, visuals,
        defaults: { model: route.id, voice: voices[0]?.id ?? 'off', visuals: visuals[0]?.id ?? 'off' } } },
      eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} },
    };
  }
  const external = { id: 'openrouter/openai/gpt-4.1-mini', label: 'GPT-4.1 mini via OpenRouter' };
  const voice = voices.find(o => o.binding)?.id ?? 'off', images = visuals.find(o => o.binding)?.id ?? 'off';
  const plugins = ['mock', ...extras];
  return {
    // Best models: the host's recommendation, with voice and visual concepts ready.
    best: { plugins, policy, choices: { models: [demoModels.mock, demoModels.deep, external], voices, visuals,
      defaults: { model: 'mock', voice, visuals: images } } },
    // No EU-qualified account exists in the demo; the preset explains why it is unavailable.
    eu: { plugins: [], bindings: {} },
    // Custom: every option the host offers, starting from a thorough text-only setup.
    custom: { plugins, policy, choices: { models: [demoModels.mock, demoModels.swift, demoModels.deep, external], voices, visuals,
      defaults: { model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off' } } },
  };
}
