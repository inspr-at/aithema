import { createBinding } from '@inspr/aithema-core';
import { modelPrice, providerMaxPrice } from '../plugins/openrouter/src/pricing.js';
import { usdMicro } from '../packages/server/src/spend-cap.js';
import { qualifyStartBinding } from './processing-consent.js';
const claudeModel = model => /^(?:anthropic\/claude-[a-z0-9.:-]+|~anthropic\/claude-[a-z0-9.:-]+-latest)$/u.test(model);
/** A live host (`live`) defaults to no HTML; fake HTML there is an explicit, labelled demo. */
export function htmlConfig(values, { live = false } = {}) {
  const mode = values.AITHEMA_HTML_MODE ?? (live ? 'off' : 'fake');
  if (!['fake', 'claude', 'off'].includes(mode)) throw new TypeError('Unknown HTML mode');
  if (mode === 'fake' && live) return { mode, demo: true };
  if (mode !== 'claude') return { mode };
  const reasoningModel = values.OPENROUTER_MODEL?.trim();
  const model = values.AITHEMA_HTML_MODEL?.trim() || (claudeModel(reasoningModel) ? reasoningModel : 'anthropic/claude-opus-5.5');
  if (!claudeModel(model)) throw new TypeError('AITHEMA_HTML_MODEL must be an anthropic/claude-* model or ~anthropic/claude-*-latest alias');
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
  const binding = createBinding(qualifyStartBinding({ plugin: 'claude-html', model, effort: 'none',
    endpoint: 'https://openrouter.ai/api/v1', accountRef: 'start2-openrouter', secretRef: 'OPENROUTER_API_KEY', maxMicro, maxTokens,
    rates: { inputMicro: Math.ceil(providerMaxPrice(price).prompt), outputMicro: Math.ceil(providerMaxPrice(price).completion),
      inputUSD: price.prompt, outputUSD: price.completion },
    routing: { require_parameters: true, allow_fallbacks: false, ...(only.length ? { only } : {}), ...(ignore.length ? { ignore } : {}),
      max_price: providerMaxPrice(price) } }));
  return { mode, prices, binding, capMicro: usdMicro(values.AITHEMA_OPENROUTER_CAP_USD ?? '10'),
    disabledReason: null };
}
