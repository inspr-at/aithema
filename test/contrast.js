// WCAG 2.x contrast for hex colours, plus CSS `color-mix(in srgb, …)` over gamma-encoded sRGB.
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = hex => {
  const [r, g, b] = channels(hex).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
};
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
}
export function mix(a, b, share) {
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((value, i) => Math.round(value * share + y[i] * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}
/** Custom properties (`--name: #hex`) declared in a CSS fragment. */
export function tokens(css, prefix) {
  return Object.fromEntries([...css.matchAll(new RegExp(`--${prefix}([a-z-]+):\\s*(#[0-9a-f]{6})`, 'giu'))].map(([, name, value]) => [name, value.toLowerCase()]));
}
