// The demo operator's allowlist. Locally every selectable option runs without a
// provider network, and real providers are declared so the settings screen shows how
// a host lists them. An explicitly selected provider makes the demo a live host: it
// then offers only its configured routes, so visitors never meet a mock there.
import { bindingReason } from '@inspr/aithema-core';
import { manifest as openRouterManifest } from '@inspr/aithema-plugin-openrouter';
import { MODEL_DISPLAY_NAMES } from '@inspr/aithema-ui/display';

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
  mock: { id: 'mock', label: 'Demo only: sample replies', binding: mock('mock', 'none'), efforts: ['none'] },
  swift: { id: 'mock/swift', label: 'Demo only: quick replies', binding: mock('mock/swift', 'none'), efforts: ['none', 'low'], effort: 'none' },
  deep: { id: 'mock/deep', label: 'Demo only: thorough replies', binding: mock('mock/deep', 'medium'), efforts: ['low', 'medium', 'high'], effort: 'medium' },
});

/**
 * Presets for the demo host. `reaction` and `understanding` are the selected provider's
 * private bindings; without account evidence (Mistral) admission reports them unverified.
 * A provider route keeps its configured effort: response styles need a host that has
 * sized its token ceilings for reasoning.
 */
export function demoPresets({ provider = 'mock', reaction, understanding = reaction, voicePlugin, voiceBinding, grokPlugin, grokBinding, imagePlugin, imageBinding,
  htmlPlugin, htmlBinding, htmlDemo = false, policy }) {
  const option = (id, label, plugin, binding, kind) => ({ id, label, ...(kind ? { kind } : {}), ...(plugin?.manifest.id === id ? { binding } : {}) });
  let voices = [option('fake-voice', 'Demo only: simulated voice', voicePlugin, voiceBinding), option('elevenlabs', 'ElevenLabs', voicePlugin, voiceBinding)];
  if (grokPlugin) voices.push(option('grok-voice', 'Grok Voice (xAI)', grokPlugin, grokBinding));
  // One Visuals control: HTML click-dummies and image concepts are alternatives of one choice.
  let visuals = [option('fake-html', 'Demo only: clickable draft', htmlPlugin, htmlBinding, 'html'),
    option('claude-html', 'Clickable draft', htmlPlugin, htmlBinding, 'html'),
    option('fake-images', 'Demo only: sample images', imagePlugin, imageBinding), option('openai-images', 'OpenAI GPT Image 2', imagePlugin, imageBinding)];
  const extras = [voicePlugin, grokPlugin, imagePlugin, htmlPlugin].filter(Boolean).map(plugin => plugin.manifest.id);
  if (provider !== 'mock') {
    // START-consented concrete models begin with openai, anthropic or x-ai.
    // A separate alias/ namespace avoids collisions without allowing ~ in client settings.
    const modelId = provider === 'openrouter' && reaction.model.startsWith('~') ? `alias/${reaction.model.slice(1)}` : reaction.model;
    const displayName = id => Object.hasOwn(MODEL_DISPLAY_NAMES, id) ? MODEL_DISPLAY_NAMES[id] : 'This host’s model';
    const replyName = displayName(reaction.model), understandingName = displayName(understanding.model);
    const route = { id: `${provider}/${modelId}`, bindings: { reaction, understanding },
      label: replyName === understandingName ? replyName : `${replyName} / ${understandingName}` };
    // Only configured live providers; the operator's explicit fake HTML is labelled a demo.
    const live = o => o.binding && (!o.id.startsWith('fake-') || htmlDemo && o.id === 'fake-html');
    voices = voices.filter(o => live(o) || o.id === 'grok-voice');
    visuals = visuals.filter(live).map(o => o.id === 'fake-html' ? { ...o, label: 'Demo only: clickable draft (no provider)' } : o);
    // Keep configured consent scopes and the existing unavailable presentation, but
    // remove the delegated voice endpoint from admission until the operator fixes
    // the explicit fast route. A saved visitor choice cannot bypass this policy.
    const voiceError = provider === 'openrouter' && voiceBinding && voices.some(o => o.id === 'elevenlabs' && o.binding) &&
      (reaction.legal?.evidence?.voiceReactionModel !== reaction.model || reaction.effort !== 'none' ||
        bindingReason({ binding: reaction, plugin: { manifest: openRouterManifest }, preset: 'best', policy }));
    if (voiceError) {
      console.error('Voice configuration error: OPENROUTER_SPEECH_MODEL is required for voice and must name an explicitly qualified fast reaction route with effort none; voice start refused.');
      // Recovery republishes voice choices under a freshly extended policy.
      // Carry the refusal on the private binding as well as the endpoint gate.
      voices = voices.map(option => option.id === 'elevenlabs' && option.binding
        ? { ...option, binding: { ...option.binding, legal: { ...option.binding.legal, approved: false } } } : option);
      policy = { ...policy, endpoints: (policy?.endpoints ?? []).filter(endpoint => endpoint !== voiceBinding.endpoint) };
    }
    const offered = new Set([...voices, ...visuals].map(o => o.binding?.plugin ?? o.id));
    return {
      best: { plugins: [provider, ...extras.filter(id => offered.has(id))], policy, choices: { models: [route], voices, visuals,
        defaults: { model: route.id, voice: voiceError ? 'off' : voices.find(o => o.id !== 'grok-voice' && o.binding)?.id ?? 'off', visuals: visuals[0]?.id ?? 'off' } } },
      eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} },
    };
  }
  const external = { id: 'openrouter/openai/gpt-4.1-mini', label: 'GPT-4.1 mini via OpenRouter' };
  const voice = voices.find(o => o.id !== 'grok-voice' && o.binding)?.id ?? 'off', images = visuals.find(o => o.binding)?.id ?? 'off';
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
