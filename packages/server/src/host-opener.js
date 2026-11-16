/** Server-only host copy; missing locales deliberately have no fallback. */
export function normalizeOpener(value) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['en', 'de'].includes(key))) {
    throw new TypeError('Invalid host opener');
  }
  const result = {};
  for (const [locale, text] of Object.entries(value)) {
    if (text === undefined) continue;
    if (typeof text !== 'string' || text.length > 1000) throw new TypeError('Invalid host opener');
    if (text.trim()) result[locale] = text;
  }
  return Object.freeze(result);
}
export const resolveOpener = (opener, locale) => opener[locale] ? { text: opener[locale], locale } : null;
