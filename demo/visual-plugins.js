import { createLocalHTML, localHTMLBinding, createLocalImages, localImageBinding, imagePluginBinding } from '@inspr/aithema-server';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { createOpenAIImages } from '@inspr/aithema-plugin-openai-images';

// The host owns provider defaults; the runtime receives registered implementations.
export function htmlPlugin(config, options = {}) {
  const plugin = config.mode === 'fake' ? createLocalHTML() : config.mode === 'claude'
    ? createClaudeHTML({ ...options, binding: config.binding, capMicro: config.capMicro }) : null;
  return { plugin, binding: plugin ? config.binding ?? localHTMLBinding : undefined };
}
export function imagePlugin(mode, host, options = {}) {
  const plugin = mode === 'fake' ? createLocalImages() : host ? createOpenAIImages({ ...options,
    binding: imagePluginBinding(host.binding) }) : null;
  return { plugin, binding: plugin ? host?.binding ?? localImageBinding : undefined };
}
