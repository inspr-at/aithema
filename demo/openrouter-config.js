import { modelPrice } from '../plugins/openrouter/src/pricing.js';
import { usdMicro } from '../packages/server/src/spend-cap.js';
import { qualifyStartBinding } from './processing-consent.js';

// Mirror START's readExact/integer semantics for these routing settings.
function read(values, name) {
  let value = values[name]?.trim();
  if (value?.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1).trim();
  return value || undefined;
}
function integer(values, name, fallback) {
  const value = read(values, name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

/** Validate non-secret configuration before opening storage or ensuring live voice. */
export function openRouterConfig(values) {
  const understandingModel = values.OPENROUTER_MODEL?.trim();
  if (!understandingModel) throw new TypeError('OPENROUTER_MODEL is required when AITHEMA_PROVIDER=openrouter');
  const speechModel = values.OPENROUTER_SPEECH_MODEL === undefined ? understandingModel : values.OPENROUTER_SPEECH_MODEL.trim();
  if (!speechModel) throw new TypeError('OPENROUTER_SPEECH_MODEL must be a model id');
  let prices;
  try { prices = JSON.parse(values.AITHEMA_OPENROUTER_PRICES); }
  catch { throw new TypeError('AITHEMA_OPENROUTER_PRICES is required as JSON with prompt/completion USD per token for every configured model'); }
  const capMicro = usdMicro(values.AITHEMA_OPENROUTER_CAP_USD ?? '10');
  const maxTokens = integer(values, 'OPENROUTER_MAX_TOKENS', 1200);
  // START found smaller ceilings truncated real analyses, including reasoning tokens.
  const analysisMaxTokens = integer(values, 'OPENROUTER_ANALYSIS_MAX_TOKENS', 8000);
  const providerOnly = read(values, 'OPENROUTER_PROVIDER_ONLY')?.split(',').map(entry => entry.trim()).filter(Boolean);
  // START's Azure workspace rejects response_format despite advertised support,
  // making roughly half of structured analyses fail; exclude it only for analysis.
  const analysisProviderIgnore = (read(values, 'OPENROUTER_ANALYSIS_PROVIDER_IGNORE') ?? 'Azure')
    .split(',').map(entry => entry.trim()).filter(Boolean);
  const binding = (model, maxTokens, ignore) => {
    const price = modelPrice(prices, model);
    return qualifyStartBinding({ plugin: 'openrouter', model, effort: 'none',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', accountRef: 'start2-openrouter', secretRef: 'OPENROUTER_API_KEY',
      maxMicro: 1_000_000, maxTokens, rates: { inputMicro: 0, outputMicro: 0 },
      routing: { require_parameters: true,
        ...(providerOnly?.length ? { only: [...providerOnly] } : {}),
        ...(ignore?.length ? { ignore: [...ignore] } : {}),
        // verified live 2026-10-09: USD per MILLION tokens; enforced before dispatch.
        max_price: { prompt: price.prompt * 1_000_000, completion: price.completion * 1_000_000 } } });
  };
  return { prices, capMicro, reaction: binding(speechModel, maxTokens),
    understanding: binding(understandingModel, analysisMaxTokens, analysisProviderIgnore) };
}
