// Keep the existing viewport reservation; the shell query below additionally
// budgets the content width lost to classic scrollbars and host action columns.
export const voiceSingleRowMinWidth = 768;
// Four 44px controls + four 8px gaps + the longest DE/EN status at 12px,
// including its padding and room for baseline font differences. Share this
// content floor with the pre-upgrade shell; the mounted fit also measures text.
export const voiceRailMinWidth = 544;

// Emit this into the host's render-blocking CSS after firstPaintStyles when
// overriding geometry. Query conditions cannot resolve CSS custom properties.
// The shell and header must have the same inline size; brandWidth is an upper
// bound, so copy/fonts never change the reserved row. The extra pixel covers
// grid-track rounding before the status-inclusive rail floor is reached.
export function headerRailReservation({
  selector = '.aithema-shell > :is(aithema-session,.aithema-first-paint)',
  actionsWidth = '216px', gutter = 'clamp(1.25rem,4vw,3.5rem)', brandWidth = '27vw',
} = {}) {
  return `
${selector} { --aithema-header-rail-height:90px; --aithema-header-rail-tracks:60px;
  --aithema-header-rail-row:1; --aithema-header-rail-column:2; }
@container aithema-shell (width < calc(54px + ${gutter} + ${brandWidth} + ${actionsWidth} + 48px + ${voiceRailMinWidth + 1}px)) {
  ${selector} { --aithema-header-rail-height:150px; --aithema-header-rail-tracks:60px 48px;
    --aithema-header-rail-row:2; --aithema-header-rail-column:1 / -1; }
}
`;
}

// Shared by the shadow header and the render-blocking host stylesheet. Keep
// geometry independent of copy, fonts, account reads and conversation stage.
export function headerGeometry(selector) {
  return `
${selector} { --band-height:90px; box-sizing:border-box; display:grid; grid-template-columns:minmax(44px,max-content) minmax(0,1fr) var(--aithema-header-actions-width,216px);
  grid-template-rows:60px; align-items:center; gap:12px 24px;
  padding:12px var(--aithema-gutter,clamp(1.25rem,4vw,3.5rem)) 18px 54px; min-height:90px; }
${selector} > .band-orb { width:44px; height:44px; }
${selector} > .audio-rail { box-sizing:border-box; justify-self:center; width:min(100%,720px); height:48px; min-height:48px;
  display:grid; grid-template-columns:44px minmax(0,1fr) 44px 44px 44px; align-items:center; gap:8px; }
${selector} > .header-actions { grid-column:3; grid-row:1; min-width:0; height:44px; }
${selector} > .audio-rail { grid-column:2; grid-row:1; }
@media(min-width:600px) {
  ${selector}:has(> .audio-rail) { --band-height:var(--aithema-header-rail-height,90px);
    grid-template-rows:var(--aithema-header-rail-tracks,60px); }
  ${selector} > .audio-rail { grid-column:var(--aithema-header-rail-column,2); grid-row:var(--aithema-header-rail-row,1); }
}
@media(min-width:600px) and (max-width:${voiceSingleRowMinWidth - 1}px) {
  ${selector}:has(> .audio-rail) { --band-height:150px; grid-template-rows:60px 48px; }
  ${selector} > .audio-rail { grid-column:1/-1; grid-row:2; }
}
@media(max-width:599px) {
  ${selector} { --band-height:124px; grid-template-columns:minmax(0,1fr) var(--aithema-header-actions-width,88px); grid-template-rows:44px 44px; gap:6px 8px; padding:12px 8px 18px 54px; }
  ${selector} > .audio-rail { grid-column:1/-1; grid-row:2; }
  ${selector} > .header-actions { grid-column:2; grid-row:1; justify-self:end; }
}
@media(max-width:599px) {
  ${selector} { --band-height:124px; }
  ${selector} > .audio-rail { gap:4px; margin-left:-4px; width:100%; height:44px; min-height:44px; }
  ${selector}:not(:has(> .audio-rail)) { --band-height:68px; min-height:68px; grid-template-rows:44px; padding-bottom:12px; }
}
`;
}

// Hosts serve this as render-blocking CSS in <head>, alongside their palette.
// data-aithema-mounted is set synchronously after configure has mounted the UI;
// :defined alone is too early because session loading may still be pending.
export const firstPaintStyles = `
.aithema-shell { container:aithema-shell / inline-size; }
${headerRailReservation()}
${headerGeometry('.aithema-first-paint')}
.aithema-shell > aithema-session:not([data-aithema-mounted]) { display:none; }
.aithema-shell:has(> aithema-session[data-aithema-mounted]) > .aithema-first-paint { display:none; }
.aithema-first-paint { position:sticky; top:0; max-width:var(--aithema-shell-max,1520px); margin-inline:auto;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--accent,#0e6f6c) 7%,var(--paper,#fbf7ef)),color-mix(in srgb,var(--accent,#0e6f6c) 4%,transparent) 70%,transparent); }
.aithema-first-paint::after { content:''; position:absolute; inset:auto 0 0; height:1px;
  background:linear-gradient(to right,transparent,var(--line,rgba(16,43,66,.24)) 18%,var(--line,rgba(16,43,66,.24)) 82%,transparent); }
.aithema-first-paint .band-orb { display:grid; place-items:center; }
.aithema-first-paint .band-orb::before { content:''; width:40px; height:40px; border-radius:50%; background:var(--accent,#0e6f6c); opacity:.25; }
.aithema-first-paint [data-placeholder] { box-sizing:border-box; width:44px; height:44px; border-radius:50%; border:1px solid var(--line,rgba(16,43,66,.13)); background:var(--surface,#fffcf8); opacity:.5; }
.aithema-first-paint .band-identity { display:flex; align-items:center; gap:12px; min-width:0; max-width:27vw; }
.aithema-first-paint .band-identity .band-orb { flex:none; width:44px; height:44px; }
.aithema-first-paint .wordmark { visibility:hidden; font:400 18px/1.25 var(--aithema-display,var(--display,Georgia)); letter-spacing:.005em; margin:0; }
.aithema-first-paint .header-actions { display:flex; gap:4px; }
.aithema-first-paint .header-actions > span { width:44px; height:44px; border-radius:10px; background:var(--line,rgba(16,43,66,.13)); }
@media(min-width:600px) { .aithema-first-paint .header-actions > span:first-child { width:168px; } }
@media(max-width:599px) { .aithema-first-paint .header-actions { gap:0; } .aithema-first-paint .band-identity { max-width:none; gap:10px; } .aithema-first-paint .wordmark { font-size:16.5px; } }
`;

// Decorative, static boxes: no duplicate buttons, focus targets or live text.
// Hosts know their binding before serving HTML; omit voice placeholders as well
// as the mounted rail when it is off. Keep the original export for bound hosts.
export function firstPaintMarkupFor({ voice = true } = {}) {
  return `<div class="aithema-first-paint" aria-hidden="true" inert>
  <div class="band-identity"><div class="band-orb"></div><span class="wordmark">Aithema</span></div>${voice ? '<div class="audio-rail"><span data-placeholder="output"></span><span></span><span data-placeholder="pause"></span><span data-placeholder="input"></span><span data-placeholder="close"></span></div>' : ''}
  <div class="header-actions"><span></span><span></span></div>
</div>`;
}
export const firstPaintMarkup = firstPaintMarkupFor();
