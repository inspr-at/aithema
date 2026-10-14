import { renderVersion, disposeVersion, parts, utcLabel } from './versioning/version.js';
import config from './versioning/display.json' with { type: 'json' };
// One product adapter: the product name stays at rest, the coordinate lives in the existing hover/focus popup.
export function mountVersionDetails(element, version) {
  for (const child of element.querySelectorAll('.coordinate')) disposeVersion(child);
  element.replaceChildren();
  const document = element.ownerDocument, label = document.createElement('span');
  label.textContent = [version.product, version.commit, version.date].filter(Boolean).join(' · ');
  element.append(label);
  if (!version.version || !version.version_scheme) return;
  if (!['legacy', 'legacy-semver-public', 'legacy-semver-private', 'inspr-calendar-v1', 'inspr-calendar-v2', 'inspr-calver-3'].includes(version.version_scheme)) throw new TypeError('Unknown version scheme');
  if (['inspr-calendar-v2', 'inspr-calver-3'].includes(version.version_scheme) && (!parts(version.version, version.version_scheme) || version.version.startsWith('v'))) throw new TypeError('Invalid canonical calendar version');
  const coordinate = document.createElement('span'); coordinate.style.display = 'block';
  renderVersion(coordinate, version.version, version.version_scheme, { config, mode: 'pretty', brand: '#d69b31' });
  element.append(coordinate);
  const parsed = parts(version.version, version.version_scheme);
  element.title = [version.version, parsed && utcLabel(parsed)].filter(Boolean).join(' · ');
}
