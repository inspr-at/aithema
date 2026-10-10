import { createBinding } from '@inspr/aithema-core';
import { modelPrice, providerMaxPrice } from '../plugins/openrouter/src/pricing.js';
import { usdMicro } from '../packages/server/src/spend-cap.js';
import { modelProvider } from './model-provider.js';

export const HTML_CONSENT_UNAVAILABLE = 'HTML consent scope unavailable: START has no matching HTML item';
const endpoint = binding => binding.endpoint.replace(/\/$/u, '').replace(/\/chat\/completions$/u, '');
const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : Array.isArray(value) ? value.map(canonical) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** Reuse START's model item only on an identical processor/account/provider route.
 * max_price is part of routing too; do not widen a consent grant by ignoring it.
 * Otherwise leave legal qualification absent until the host has matching copy.
 */
export function matchingHTMLReasoning(binding, reasoningBindings) {
  return reasoningBindings.find(b => b.plugin === 'openrouter' && b.legal?.purpose === 'models-international' &&
    modelProvider(b.model) === modelProvider(binding.model) && b.accountRef === binding.accountRef && b.secretRef === binding.secretRef &&
    endpoint(b) === endpoint(binding) && same(b.routing ?? {}, binding.routing ?? {}));
}
export function coverHTMLBinding(binding, reasoningBindings) {
  const reasoning = matchingHTMLReasoning(binding, reasoningBindings);
  if (!reasoning) return binding;
  return createBinding({ ...binding, legal: { ...reasoning.legal,
    evidence: { ...reasoning.legal.evidence, model: binding.model, endpoint: binding.endpoint, routing: binding.routing } } });
}
/** A live host (`live`) defaults to no HTML; fake HTML there is an explicit, labelled demo. */
export function htmlConfig(values, reasoningBindings = [], { live = false } = {}) {
  const mode = values.AITHEMA_HTML_MODE ?? (live ? 'off' : 'fake');
  if (!['fake', 'claude', 'off'].includes(mode)) throw new TypeError('Unknown HTML mode');
  if (mode === 'fake' && live) return { mode, demo: true };
  if (mode !== 'claude') return { mode };
  const model = values.AITHEMA_HTML_MODEL?.trim() || 'anthropic/claude-opus-5.5';
  if (!/^anthropic\/claude-[a-z0-9.:-]+$/u.test(model)) throw new TypeError('AITHEMA_HTML_MODEL must be an anthropic/claude-* model');
  let prices;
  try { prices = JSON.parse(values.AITHEMA_OPENROUTER_PRICES); }
  catch { throw new TypeError('AITHEMA_OPENROUTER_PRICES is required for HTML'); }
  const price = modelPrice(prices, model);
  if (price.prompt <= 0 || price.completion <= 0) throw new TypeError('HTML requires positive per-token prices');
  const csv = (key, fallback) => {
    let value = values[key]?.trim();
    if (value?.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1).trim();
    return (value || fallback || '').split(',').map(v => v.trim()).filter(Boolean);
  };
  const only = csv('OPENROUTER_PROVIDER_ONLY'), ignore = csv('OPENROUTER_ANALYSIS_PROVIDER_IGNORE', 'Azure');
  const maxTokens = 8000, maxMicro = 1_000_000;
  const binding = coverHTMLBinding(createBinding({ plugin: 'claude-html', model, effort: 'none',
    endpoint: 'https://openrouter.ai/api/v1', accountRef: 'start2-openrouter', secretRef: 'OPENROUTER_API_KEY', maxMicro, maxTokens,
    rates: { inputMicro: Math.ceil(providerMaxPrice(price).prompt), outputMicro: Math.ceil(providerMaxPrice(price).completion),
      inputUSD: price.prompt, outputUSD: price.completion },
    routing: { require_parameters: true, allow_fallbacks: false, ...(only.length ? { only } : {}), ...(ignore.length ? { ignore } : {}),
      max_price: providerMaxPrice(price) } }), reasoningBindings);
  return { mode, prices, binding, capMicro: usdMicro(values.AITHEMA_OPENROUTER_CAP_USD ?? '10'),
    disabledReason: binding.legal ? null : HTML_CONSENT_UNAVAILABLE };
}
