import { renderVersion, disposeVersion, parts, utcLabel } from './versioning/version.js';
import { attachVersionInteraction, confirmation } from './versioning/version-interaction.js';
import config from './versioning/display.json' with { type: 'json' };
import { palette } from './styles.js';
const mounted = new WeakMap(), warned = new Set();
const schemes = ['legacy', 'legacy-semver-public', 'legacy-semver-private', 'inspr-calendar-v1', 'inspr-calendar-v2', 'inspr-calver-3'];
// Tick's approved popup separators; the pinned shared renderer owns their geometry.
const popupConfig = { ...config, weights: { ...config.weights, hh: 1, mi: 1 }, pretty: { ...config.pretty,
  colors: Object.fromEntries(config.segments.map(key => [key, palette.dark.ink])),
  separators: { ...Object.fromEntries(Object.entries(config.pretty.separators).map(([key, value]) => [key, { ...value, color: palette.dark.ink }])),
  yy: { ...config.pretty.separators.yy, text: '.', color: palette.dark.ink },
  mm: { ...config.pretty.separators.mm, text: '.', color: palette.dark.ink },
  dd: { ...config.pretty.separators.dd, text: ' · ', paddingLeft: 0, color: palette.dark.ink },
} } };
function warnOnce(reason) {
  if (warned.has(reason)) return;
  warned.add(reason); console.warn(`Aithema: ${reason}; version details hidden.`);
}
// One product adapter: product at rest, version/copy in one reserved popup slot.
export function mountVersionDetails(element, version, { locale = 'de' } = {}) {
  mounted.get(element)?.(); mounted.delete(element);
  element.replaceChildren(); element.removeAttribute('title');
  const document = element.ownerDocument, view = document.defaultView ?? globalThis;
  const build = () => {
    if (!version.commit && !version.date) return;
    const label = document.createElement('span'); label.className = 'build-label';
    const date = version.date && new Date(version.date);
    const utc = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : null;
    label.textContent = 'Build ' + [version.commit?.slice(0, 7), utc].filter(Boolean).join(' · ');
    element.append(label);
  };
  if (!version.version) { build(); return; }
  if (!schemes.includes(version.version_scheme)) { warnOnce('Unknown version scheme'); build(); return; }
  const parsed = parts(version.version, version.version_scheme);
  if (['inspr-calendar-v2', 'inspr-calver-3'].includes(version.version_scheme) && (!parsed || version.version.startsWith('v'))) {
    warnOnce('Invalid canonical calendar version'); build(); return;
  }
  const row = document.createElement('span'); row.className = 'version-row';
  const value = document.createElement('span'); value.className = 'version-value';
  const label = document.createElement('span'); label.className = 'version-label'; label.textContent = 'Version ';
  const coordinate = document.createElement('span');
  const brand = view.getComputedStyle?.(element).getPropertyValue('--aithema-accent').trim() || '#0e6f6c';
  renderVersion(coordinate, version.version, version.version_scheme, {
    config: popupConfig, mode: version.display === 'semver' ? 'reduced' : 'pretty', brand, interactive: false,
  });
  element.title = [version.version, parsed && utcLabel(parsed)].filter(Boolean).join(' · ');
  coordinate.setAttribute('aria-label', element.title); coordinate.title = element.title;
  value.append(label, coordinate); row.append(value); element.append(row); build();
  // The shared controller retains canonical clipboard/fallback and keyboard/touch behavior.
  // The product's specified acknowledgement lasts 1.2 s, within its own reserved slot.
  const controller = attachVersionInteraction(row, version.version, { label: element.title,
    text: locale === 'en' ? { copy: 'Copy version', copied: 'Copied', failed: 'Copy unavailable. Select the version and copy it with ⌘C or Ctrl+C.' } : undefined,
    view: { navigator: view.navigator, matchMedia: view.matchMedia?.bind(view),
      setTimeout: (fn, ms) => view.setTimeout(fn, ms === confirmation ? 1200 : ms), clearTimeout: view.clearTimeout.bind(view) },
  });
  row.style.display = 'grid';
  // Keep the keyboard ring inside the row, clear of the build text below.
  row.style.outlineOffset = '-2px';
  // Chromium can retain :focus-visible when the already focused row is clicked.
  // Pointer copies still have no ring; the next key restores keyboard styling.
  const pointerFocus = () => { row.dataset.pointerFocus = ''; };
  const keyboardFocus = () => { delete row.dataset.pointerFocus; };
  row.addEventListener('pointerdown', pointerFocus); row.addEventListener('keydown', keyboardFocus);
  row.addEventListener('blur', keyboardFocus);
  const feedback = row.lastChild; feedback.className = 'version-feedback';
  Object.assign(feedback.style, { position: 'static', gridArea: '1 / 1', padding: '0', borderRadius: '0',
    font: 'inherit', color: 'inherit', background: 'transparent', whiteSpace: 'normal', zIndex: 'auto' });
  // Keep the manual-copy field in the reserved line; its accessible description
  // retains the shared controller's full failure explanation.
  const observer = new view.MutationObserver(() => {
    if (row.dataset.copyState !== 'error') return;
    const field = feedback.querySelector('input');
    if (!field) return;
    const explanation = feedback.firstChild;
    field.setAttribute('aria-description', explanation.textContent);
    field.title = explanation.textContent;
    explanation.textContent = locale === 'en' ? 'Copy manually:' : 'Manuell kopieren:';
  });
  observer.observe(row, { attributes: true, attributeFilter: ['data-copy-state'] });
  const dispose = () => { observer.disconnect(); row.removeEventListener('pointerdown', pointerFocus);
    row.removeEventListener('keydown', keyboardFocus); row.removeEventListener('blur', keyboardFocus); controller.dispose(); disposeVersion(coordinate); mounted.delete(element); };
  mounted.set(element, dispose); return dispose;
}
