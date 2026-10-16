// Shared by the shadow header and the render-blocking host stylesheet. Keep
// geometry independent of copy, fonts, account reads and conversation stage.
export function headerGeometry(selector) {
  return `
${selector} { --band-height:90px; box-sizing:border-box; display:grid; grid-template-columns:192px minmax(0,1fr) var(--aithema-header-actions-width,96px);
  grid-template-rows:60px; align-items:center; gap:12px 24px;
  padding:12px var(--aithema-gutter,clamp(1.25rem,4vw,3.5rem)) 18px 54px; min-height:90px; }
${selector} > .band-orb { width:44px; height:44px; }
${selector} > .audio-rail { box-sizing:border-box; justify-self:center; width:min(100%,720px); height:48px; min-height:48px;
  display:grid; grid-template-columns:44px minmax(0,1fr) 44px 44px 44px; align-items:center; gap:8px; }
${selector} > .header-actions { min-width:0; height:44px; }
@media(max-width:1099px) {
  ${selector} { --band-height:130px; grid-template-columns:minmax(0,1fr) var(--aithema-header-actions-width,96px); grid-template-rows:44px 48px; gap:8px 16px; }
  ${selector} > .audio-rail { grid-column:1/-1; grid-row:2; }
  ${selector} > .header-actions { grid-column:2; grid-row:1; justify-self:end; }
}
@media(max-width:599px) {
  ${selector} { --band-height:128px; gap:6px 8px; padding-right:8px; }
  ${selector} > .audio-rail { gap:4px; margin-left:-4px; width:100%; }
}
`;
}

// Hosts serve this as render-blocking CSS in <head>, alongside their palette.
// data-aithema-mounted is set synchronously after configure has mounted the UI;
// :defined alone is too early because session loading may still be pending.
export const firstPaintStyles = `${headerGeometry('.aithema-first-paint')}
.aithema-shell > aithema-session:not([data-aithema-mounted]) { display:none; }
.aithema-shell:has(> aithema-session[data-aithema-mounted]) > .aithema-first-paint { display:none; }
.aithema-first-paint { position:sticky; top:0; max-width:var(--aithema-shell-max,1520px); margin-inline:auto;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--accent,#0e6f6c) 7%,var(--paper,#fbf7ef)),color-mix(in srgb,var(--accent,#0e6f6c) 4%,transparent) 70%,transparent); }
.aithema-first-paint::after { content:''; position:absolute; inset:auto 0 0; height:1px;
  background:linear-gradient(to right,transparent,var(--line,rgba(16,43,66,.24)) 18%,var(--line,rgba(16,43,66,.24)) 82%,transparent); }
.aithema-first-paint .band-orb { display:grid; place-items:center; }
.aithema-first-paint .band-orb::before { content:''; width:40px; height:40px; border-radius:50%; background:var(--accent,#0e6f6c); opacity:.25; }
.aithema-first-paint [data-placeholder] { box-sizing:border-box; width:44px; height:44px; border-radius:50%; border:1px solid var(--line,rgba(16,43,66,.13)); background:var(--surface,#fffcf8); opacity:.5; }
.aithema-first-paint .header-actions { display:flex; gap:4px; }
.aithema-first-paint .header-actions > span { width:44px; height:44px; border-radius:10px; background:var(--line,rgba(16,43,66,.13)); }
@media(max-width:599px) { .aithema-first-paint .header-actions { gap:0; } }
`;

// Decorative, static boxes: no duplicate buttons, focus targets or live text.
export const firstPaintMarkup = `<div class="aithema-first-paint" aria-hidden="true" inert>
  <div class="band-orb"></div><div class="audio-rail"><span data-placeholder="output"></span><span></span><span data-placeholder="pause"></span><span data-placeholder="input"></span><span data-placeholder="close"></span></div>
  <div class="header-actions"><span></span><span></span></div>
</div>`;
