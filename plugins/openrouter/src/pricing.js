const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
  Number.isFinite(perMillion(value));

/** Operator ceilings in USD per token; never substitute catalog/seed prices. */
export function modelPrice(prices, model) {
  const price = prices && Object.hasOwn(prices, model) ? prices[model] : null;
  if (!price || Array.isArray(price) || !valid(price.prompt) || !valid(price.completion)) {
    throw new TypeError(`AITHEMA_OPENROUTER_PRICES requires valid prompt/completion USD per token for ${model}`);
  }
  return Object.freeze({ prompt: price.prompt, completion: price.completion });
}

// Evaluate the configured decimal rates exactly, including JSON exponent notation.
// Integer arithmetic prevents a floating-point round-down at a microdollar boundary.
function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? [BigInt(whole + fraction), 10n ** BigInt(scale)]
    : [BigInt(whole + fraction) * 10n ** BigInt(-scale), 1n];
}

function perMillion(value) {
  const [amount, scale] = decimal(value), numerator = amount * 1_000_000n;
  const fraction = (numerator % scale).toString().padStart(scale.toString().length - 1, '0');
  // Shift the configured decimal exactly; convert to a JSON number only at the boundary.
  return Number(`${numerator / scale}.${fraction}`);
}

/** OpenRouter max_price is USD per million tokens, not per token. */
export function providerMaxPrice(price) {
  return { prompt: perMillion(price.prompt), completion: perMillion(price.completion) };
}

// A conservative token bound, independent of the configured prompt price.
export const requestInputTokens = body => new TextEncoder().encode(JSON.stringify(body.messages)).byteLength;
export const requestCeilingMicro = (body, price) => tokenCeilingMicro(requestInputTokens(body), body.max_tokens, price);

export function tokenCeilingMicro(inputTokens, outputTokens, price) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new TypeError('Invalid input token ceiling');
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) throw new TypeError('Invalid output token ceiling');
  const [prompt, promptScale] = decimal(price.prompt), [completion, completionScale] = decimal(price.completion);
  const denominator = promptScale * completionScale;
  const numerator = (BigInt(inputTokens) * prompt * completionScale + BigInt(outputTokens) * completion * promptScale) * 1_000_000n;
  const micro = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(micro)) throw new TypeError('OpenRouter request ceiling is too large');
  return micro;
}
