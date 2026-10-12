// Provider USD amounts are decimal values. Round once, upwards, to microUSD.
export function usdCostMicro(value, units = 1) {
  if (![value, units].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  const decimal = n => {
    const [digits, exponent = '0'] = String(n).split('e'), [whole, fraction = ''] = digits.split('.');
    const scale = fraction.length - Number(exponent);
    return [BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale)), 10n ** BigInt(Math.max(0, scale))];
  };
  const [price, priceScale] = decimal(value), [count, countScale] = decimal(units);
  const denominator = priceScale * countScale, numerator = price * count * 1_000_000n;
  const result = Number((numerator + denominator - 1n) / denominator);
  return Number.isSafeInteger(result) ? result : null;
}

export const generationId = value => typeof value === 'string' && /^gen-[A-Za-z0-9-]{1,124}$/u.test(value) ? value : null;
