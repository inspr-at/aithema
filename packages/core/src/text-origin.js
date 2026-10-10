/** Public producer identity only; never serialize a private binding. */
export function aiTextOrigin(binding = {}) {
  return { origin: 'ai-generated',
    ...(typeof binding.model === 'string' && binding.model ? { model: binding.model } : {}),
    ...(typeof binding.plugin === 'string' && binding.plugin ? { provider: binding.plugin } : {}) };
}

/** Old generated records gain the origin label without guessing a producer. */
export function withAITextOrigin(data) {
  const { origin, model, provider, ...rest } = data;
  if (data.erased || data.withdrawn) {
    const { engine, ...metadata } = rest;
    return metadata;
  }
  return data.role === 'user' ? rest : { ...rest, ...aiTextOrigin({ model, plugin: provider }) };
}
