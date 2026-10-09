import { modelPrice } from '../plugins/openrouter/src/pricing.js';
import { usdMicro } from '../packages/server/src/spend-cap.js';
import { qualifyStartBinding } from './processing-consent.js';

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
  const binding = (model, maxTokens) => {
    const price = modelPrice(prices, model);
    return qualifyStartBinding({ plugin: 'openrouter', model, effort: 'none',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', accountRef: 'start2-openrouter', secretRef: 'OPENROUTER_API_KEY',
      maxMicro: 1_000_000, maxTokens, rates: { inputMicro: 0, outputMicro: 0 },
      // UNVERIFIED API SHAPE: provider.max_price uses USD per million tokens.
      routing: { max_price: { prompt: price.prompt * 1_000_000, completion: price.completion * 1_000_000 } } });
  };
  return { prices, capMicro, reaction: binding(speechModel, 600), understanding: binding(understandingModel, 4096) };
}
