// OpenRouter family aliases keep the configured id but consent to its provider.
export const modelProvider = model => (/^~[^/]+\/[^/]+-latest$/u.test(model) ? model.slice(1) : model).split('/')[0];
