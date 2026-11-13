import { en } from './i18n/en.js';
import { de } from './i18n/de.js';

const bundles = { en, de };
const read = (copy, path) => path.split('.').reduce((value, key) =>
  value && Object.hasOwn(value, key) ? value[key] : undefined, copy);
const present = value => typeof value === 'string' ? Boolean(value.trim())
  : value && typeof value === 'object' && Object.keys(value).length > 0;
const same = (a, b) => a === b || Boolean(a && b && typeof a === 'object' && typeof b === 'object' &&
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])));
const value = copy => present(copy) ? copy : undefined;

/** Resolve additive copy keys without hiding a host's legacy override.
 * Dot paths also support nested copy, such as voiceMessagesNarrow.*.
 */
export function resolveCopy(copy, key, legacyKey) {
  const shipped = bundles[read(copy, 'display.locale')] ?? en;
  const fallback = value(read(shipped, key)) ?? value(read(en, key));
  const current = value(read(copy, key));
  if (current && !same(current, fallback)) return current;
  if (legacyKey) {
    const legacy = value(read(copy, legacyKey));
    const legacyDefault = value(read(shipped, legacyKey)) ?? value(read(en, legacyKey));
    if (legacy && !same(legacy, legacyDefault)) return legacy;
  }
  return fallback;
}
