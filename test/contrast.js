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
/**
 * Every text-on-background pair the session component draws, for one theme's tokens (AIT-118):
 * each text token on paper, surface, both bubbles and every tint a control or notice sits on,
 * plus the filled primaries. Translucent layers are composited the way the browser paints them
 * (source-over in sRGB): a hover tint over a notice tint, the 85 % legend ink and the 0.85-opacity
 * gauge value over each stop of the gauge panel. `primaryText` is the text colour on the ink-filled
 * Done/Continue; `gaugePanel` lists the panel's gradient stops.
 */
export function textPairs(t, { primaryText, backgrounds: extra = {}, gaugePanel = [t.surface, t.paper] }) {
  const hover = background => mix(t.accent, background, .08), notice = background => mix(t.amber, background, .09);
  const backgrounds = { paper: t.paper, surface: t.surface, 'assistant bubble': mix(t.ink, t.paper, .07), 'own bubble': mix(t.accent, t.paper, .12),
    'hover tint on surface': hover(t.surface), 'hover tint on paper': hover(t.paper), 'option hover tint': mix(t.accent, t.surface, .1),
    'selected option': mix(t.accent, t.surface, .14), 'notice tint on surface': notice(t.surface), 'notice tint on paper': notice(t.paper),
    'hover tint over notice tint on surface': hover(notice(t.surface)), 'hover tint over notice tint on paper': hover(notice(t.paper)),
    'code block': mix(t.ink, t.surface, .07), 'Reject hover tint': mix(t.error, t.paper, .08),
    ...Object.fromEntries(gaugePanel.map(stop => [`gauge panel ${stop}`, stop])), ...extra };
  const pairs = {};
  for (const text of ['ink', 'muted', 'accent', 'warning', 'error']) {
    for (const [name, background] of Object.entries(backgrounds)) pairs[`${text} on ${name}`] = [t[text], background];
  }
  for (const background of [t.surface, t.paper]) pairs[`legend (ink 85 %) on ${background}`] = [mix(t.ink, background, .85), background];
  for (const stop of gaugePanel) pairs[`gauge value (ink at 0.85 opacity) on ${stop}`] = [mix(t.ink, stop, .85), stop];
  return { ...pairs, 'on-accent on accent': [t['on-accent'], t.accent], 'on-accent on hovered accent': [t['on-accent'], mix(t.accent, t.ink, .84)],
    'primary text on ink': [primaryText, t.ink], 'primary text on its ink fill': [primaryText, mix(t.ink, t.accent, .85)] };
}
/**
 * The backgrounds under the text of START's glass processing cards (entrance-styles .chooser-option, AIT-128),
 * sampled every 4 px over the content box of three card shapes (four columns, two wide, two narrow). Over `page`
 * lie the selected tint when `selected`, the 125° glass, the two corner glows (farthest-corner ellipses at 0 105 %
 * and 100 % 110 %, gone at 45 % and 55 %) and the 135° highlight of the inner edge (inset 5px), composited
 * source-over in sRGB. `card` holds one theme's [hex, alpha] layers: { glass: [[at, hex, alpha] × 3], apricot,
 * teal, selected, highlight: [[at, hex, alpha] × 4] }.
 */
export function glassCard(card, page, { selected = false } = {}) {
  const glow = (x, y, w, h, cx, cy, end) => Math.max(0, 1 - Math.hypot((x - cx) / (Math.max(cx, w - cx) * Math.SQRT2), (y - cy) / (Math.max(cy, h - cy) * Math.SQRT2)) / end);
  const along = (x, y, w, h, deg) => {
    const a = deg * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
    return Math.min(1, Math.max(0, ((x - w / 2) * dx + (y - h / 2) * dy) / (Math.abs(w * dx) + Math.abs(h * dy)) + .5));
  };
  // A transparent stop keeps its neighbour's colour (premultiplied interpolation); only the alpha fades.
  const between = (stops, t) => {
    const i = Math.max(1, stops.findIndex(([at]) => at >= t)), [[p0, c0, a0], [p1, c1, a1]] = [stops[i - 1], stops[i]], k = (t - p0) / (p1 - p0);
    return [a0 && a1 ? mix(c1, c0, k) : a0 ? c0 : c1, a0 + (a1 - a0) * k];
  };
  const over = (base, layers) => layers.reduce((under, [hex, alpha]) => alpha > 0 ? mix(hex, under, alpha) : under, base);
  const samples = new Set();
  for (const [w, h] of [[284, 230], [330, 200], [170, 300]]) {
    for (let x = 27; x <= w - 27; x += 4) for (let y = 26; y <= h - 25; y += 4) {
      samples.add(over(page, [...selected ? [card.selected] : [], between(card.glass, along(x, y, w, h, 125)),
        [card.apricot[0], card.apricot[1] * glow(x, y, w, h, 0, 1.05 * h, .45)], [card.teal[0], card.teal[1] * glow(x, y, w, h, w, 1.1 * h, .55)],
        between(card.highlight, along(x - 5, y - 5, w - 10, h - 10, 135))]));
    }
  }
  return [...samples];
}
