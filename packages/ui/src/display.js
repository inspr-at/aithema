import { isConsentReason } from '../../core/src/settings.js';
import { featureConsentText, reasonSeparator } from './consent-line.js';

// Shared with native browser hosts through the public display entrypoint.
export { reasonSeparator };

// Public names take precedence; unknown routes may use only a curated, localized host label.
export const MODEL_DISPLAY_NAMES = Object.freeze({
  'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5',
  'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
  'anthropic/claude-sonnet-5.5': 'Claude Sonnet 5.5',
  '~anthropic/claude-haiku-latest': 'Claude Haiku',
  '~anthropic/claude-opus-latest': 'Claude Opus',
  '~anthropic/claude-sonnet-latest': 'Claude Sonnet',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'anthropic/claude-opus-4.6': 'Claude Opus 4.6',
  'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'openai/gpt-4.1-mini': 'GPT-4.1 mini',
  'openrouter/openai/gpt-4.1-mini': 'GPT-4.1 mini',
  'openai/gpt-4.1': 'GPT-4.1',
  'openai/gpt-5.4': 'GPT-5.4',
  'mistralai/mistral-small-latest': 'Mistral Small',
  'mistral-small-latest': 'Mistral Small',
  mock: 'Mock reasoning', swift: 'Swift (mock)', deep: 'Deep (mock)',
  'mock/swift': 'Swift (mock)', 'mock/deep': 'Deep (mock)',
});
export function modelDisplayName(id, copy, label) {
  const name = Object.hasOwn(MODEL_DISPLAY_NAMES, id ?? '') ? MODEL_DISPLAY_NAMES[id] : null;
  if (name) return copy.catalogLabels?.[name] ?? name;
  return typeof label === 'string' && label !== '' && Object.hasOwn(copy.catalogLabels ?? {}, label)
    ? copy.catalogLabels[label] : copy.display.modelUnknown;
}

// The existing wallet stores USD millionths: one credit is one US cent. Never overstate spendable credit.
export const wholeCredits = micro => Number.isFinite(micro) ? Math.max(0, Math.floor(micro / 10_000)) : 0;
export const formatCredits = (micro, locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(wholeCredits(micro));

// Quotes are upper bounds: round up whole credits, without hiding a positive sub-credit cost.
export function creditCost(micro, copy) {
  if (!Number.isSafeInteger(micro) || micro <= 0) return '';
  const amount = micro < 10_000 ? '< 1' : new Intl.NumberFormat(copy.display.locale).format(Math.ceil(micro / 10_000));
  const cost = `${amount} ${micro <= 10_000 ? copy.display.credit : copy.display.credits}`;
  return (micro < 10_000 ? cost : copy.display.creditUpperBound.replace('{cost}', cost)).replaceAll(' ', '\u00a0');
}

/** One sentence in the rail. A missing quote cannot offer paid work; feature verdicts still gate consent. */
export function draftsLine({ copy, cost, feature, kind = 'html' }) {
  if (feature.dailyCapped) return { state: 'low', text: copy.hostSurface.credits.dailyCap, action: false };
  const reason = feature.rawReason ?? feature.reason ?? '';
  if (!feature.available && reason === 'visuals off') return { state: 'off',
    text: `${copy.display.draftsDisabled}${reasonSeparator}${copy.display.draftsEnable}`, action: false };
  if (!feature.available && isConsentReason(reason)) return { state: 'off',
    text: `${featureConsentText(copy, kind)}${reasonSeparator}${copy.featureConsent.action}`, action: false };
  const low = /(?:credit|spend cap|budget|Ausgabenlimit)/iu.test(reason);
  const known = Number.isSafeInteger(cost?.maxMicro) && cost.maxMicro >= 0;
  if (low) return { state: 'low', text: copy.display.draftsLow, action: false };
  if (!feature.available && reason === 'not configured') return { state: 'off', text: copy.display.draftsOff, action: false };
  const blocked = !feature.available && ({
    'visuals not offered': 'draftsUnoffered', 'not offered': 'draftsUnoffered',
    'preset not configured': 'draftsPreset', 'plugin not in preset': 'draftsPreset', 'unavailable on device': 'draftsDevice',
    'admission deadline': 'draftsTimeout',
  })[reason];
  const recovery = blocked === 'draftsPreset' || blocked === 'draftsDevice' ? 'settings'
    : blocked === 'draftsTimeout' || !blocked && !known && feature.available ? 'retry' : null;
  if (blocked || recovery) {
    const message = copy.display[blocked || 'draftsQuote'], label = recovery === 'settings' ? copy.display.draftsChoose : copy.display.draftsRetry;
    return { state: 'off', text: recovery ? `${message}${reasonSeparator}${label}` : message, action: false,
      ...(recovery ? { recovery, message, label } : {}) };
  }
  if (!known || !feature.available) return { state: 'off', text: copy.display.draftsUnavailable, action: false };
  return { state: 'on', text: [copy.display.draftsOn, creditCost(cost.maxMicro, copy)].filter(Boolean).join(reasonSeparator), action: true };
}

// START's SettingsFlag. The flags and machine paths are ported from its AGPL-3.0-only component.
const STAR = '0,-1 .224,-.309 .951,-.309 .363,.118 .588,.809 0,.382 -.588,.809 -.363,.118 -.951,-.309 -.224,-.309';
const star = (x, y, scale) => `<polygon points="${STAR}" transform="translate(${x} ${y}) scale(${scale})" fill="${scale === 2 ? '#ffdc35' : '#fff'}"/>`;
export function settingsFlag(kind) {
  const wrap = inner => `<span class="settings-flag" aria-hidden="true">${inner}</span>`;
  if (kind === 'quality') return wrap(`<svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#fff"/>${Array.from({ length: 7 }, (_, i) => `<rect y="${i * 80 / 13}" width="60" height="${40 / 13}" fill="#bd2940"/>`).join('')}<rect width="25" height="${280 / 13}" fill="#173e7e"/>${Array.from({ length: 9 }, (_, r) => Array.from({ length: r % 2 ? 5 : 6 }, (_, c) => star(2.1 + c * 4.15 + (r % 2 ? 2.07 : 0), 2 + r * 2.2, .85)).join('')).join('')}</svg>`);
  if (kind === 'eu') return wrap(`<svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#0646aa"/>${Array.from({ length: 12 }, (_, i) => star(30 + 12 * Math.sin(i * Math.PI / 6), 20 - 12 * Math.cos(i * Math.PI / 6), 2)).join('')}</svg>`);
  return wrap(`<svg viewBox="0 0 60 40"><path d="M10 36V4" stroke="#758087" stroke-width="2"/><path d="M11 5c12-7 24 8 38 0v22c-14 8-26-7-38 0Z" fill="#fff" stroke="#b9b9b1"/></svg><svg class="settings-flag__machine" viewBox="0 0 32 28" fill="none" stroke="#102945" stroke-width="1.5">${kind === 'device' ? '<rect x="5" y="3" width="22" height="16" rx="1.5" fill="#d8e9ed"/><path d="m5 19-3 5h28l-3-5Z" fill="#8eacba"/>' : [3, 11, 19].map(y => `<rect x="4" y="${y}" width="24" height="6" rx="1.5" fill="#23475a"/><path d="M8 ${y + 3}h2m11 0h3" stroke="#d5f0ec"/>`).join('')}</svg>`);
}

/** The footer marks the UI language; processing scope is named in its model details. */
export function languageFlag(locale) {
  if (locale !== 'de') return settingsFlag('quality');
  return '<span class="settings-flag" aria-hidden="true"><svg viewBox="0 0 60 40"><path fill="#111" d="M0 0h60v14H0z"/><path fill="#d00" d="M0 13h60v14H0z"/><path fill="#ffce00" d="M0 26h60v14H0z"/></svg></span>';
}

/** A missing measurement has no numeric level; a measured zero remains a zero. */
export function gaugeVialState(kind, gauge) {
  const measured = ({ quality: () => gauge.state === 'rated', speed: () => gauge.state === 'index',
    cost: () => ['free', 'reviewed'].includes(gauge.state), privacy: () => gauge.state !== 'unverified',
    voice: () => gauge.total > 0, images: () => Array.isArray(gauge.operations) })[kind]?.();
  return measured ? 'gauge--measured' : 'gauge--unrated';
}
