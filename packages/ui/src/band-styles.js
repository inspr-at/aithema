import { headerGeometry } from './first-paint.js';
import { FOOTER_WIDTHS } from './layout.js';
import { palette } from './styles.js';
import { reasonSeparator } from './consent-line.js';

// AIT-131, approved round 2: edge-to-edge band, one edge column and three footer zones.
export const bandStyles = `
.consent-action, .audio-rail .consent-action, .audio-rail .consent-action:hover:not(:disabled) {
  position:relative; display:inline; width:auto; height:auto; min-height:0; min-width:0; padding:0; white-space:nowrap; margin:0; border:0; border-radius:0;
  background:none; box-shadow:none; color:inherit; font:inherit; font-style:normal; text-decoration:underline;
  text-underline-offset:3px; cursor:pointer; transform:none; }
/* Extend toward the sentence: negative overflow leaves the inline text's scroll box unchanged. */
.consent-action::after { content:''; position:absolute; top:50%; left:-9px; width:calc(100% + 9px); height:max(100%,24px); transform:translateY(-50%); }
.consent-action[hidden] { display:none; }
.voice-state:has(.consent-action:not([hidden])) { max-width:100%; text-wrap:initial; }
.workspace { position:relative; max-width:none; padding-bottom:68px; }
.band { grid-area:top; position:sticky; top:0; z-index:10; display:grid; grid-template-columns:44px minmax(0,1fr) auto;
  align-items:center; gap:12px 24px; margin-inline:calc(-1 * var(--aithema-gutter));
  padding:12px var(--aithema-gutter) 18px 54px; min-height:90px;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)),color-mix(in srgb,var(--aithema-accent) 4%,transparent) 70%,transparent); }
.band[data-scrolled] { background:color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)); }
/* The fade starts below the unchanged hairline and never occupies a grid row. */
.band[data-scrolled]::before { content:''; position:absolute; inset:100% 0 auto; height:12px; pointer-events:none;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)),transparent); }
.band::after { content:''; position:absolute; inset:auto 0 0; height:1px;
  background:linear-gradient(to right,transparent,var(--aithema-line-strong) 18%,var(--aithema-line-strong) 82%,transparent); }
.band-orb { position:relative; z-index:4; width:44px; height:44px; display:grid; place-items:center; }
.band-orb .orb { --orb-size:40px; width:44px; height:44px; }
.band-orb .orb[role="button"] { cursor:pointer; }
.band .audio-rail { justify-self:center; width:min(100%,720px); display:grid; grid-template-columns:44px minmax(0,1fr) 44px 44px 44px; }
.audio-rail button { background:color-mix(in srgb,var(--aithema-surface) 50%,transparent); }
.audio-rail button:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-surface) 50%,transparent); }
.audio-rail .pause, .audio-rail .pause:hover:not(:disabled) { background:var(--aithema-ink); }
/* Ownership stays a rail status, with Resume's ink fill during takeover. */
.band .audio-rail:focus-visible { outline:none; }
.audio-rail[data-moved] .pause:disabled { opacity:1; }
.audio-rail .voice-pause { visibility:hidden; }
.voice-signal { height:44px; container-type:inline-size; }
/* Leave 8px of fully clear space outside the text before each 8px fade.
   The measured centre also follows off-centre consent and reconciliation copy. */
.voice-wave { height:30px; --voice-label-half:0px; --voice-label-center:0px;
  mask-image:linear-gradient(to right,#000 calc(50% + var(--voice-label-center) - var(--voice-label-half) - 16px),transparent calc(50% + var(--voice-label-center) - var(--voice-label-half) - 8px),transparent calc(50% + var(--voice-label-center) + var(--voice-label-half) + 8px),#000 calc(50% + var(--voice-label-center) + var(--voice-label-half) + 16px)); }
.voice-wave[data-short-flanks] { visibility:hidden; }
/* Keep the accepted phone baseline hidden; the observer also hides short flanks at wider sizes. */
@container (width < 184px) { .voice-wave { visibility:hidden; } }
/* An empty status has no label or flanks: show the continuous calm baseline. */
.voice-state:empty, .voice-caption:empty { display:none; }
.voice-signal:has(.voice-state:empty):has(.voice-caption:empty) .voice-wave { mask-image:none; visibility:visible; }
.voice-state, .voice-caption { padding:3px 8px; border-radius:0; font-size:12px;
  background:none; box-shadow:none; }
.voice-state { max-width:100%; white-space:nowrap; overflow-wrap:normal; word-break:normal; }
/* At 600px the CI baseline's longest DE status needs 306px of the 314px signal. */
@media(600px <= width < 640px) { .voice-state { padding-inline:2px; } }
/* Waiting borrows space from the measured waveform flanks without moving the rail or its controls. */
@media (min-width:1024px) { .audio-rail[data-state="waiting"] .voice-state { max-width:100%; white-space:nowrap; }
  .audio-rail[data-call-reconciling] .voice-state { max-width:100%; } }
.audio-rail[data-message] .voice-state { width:var(--voice-message-width,min(280px,calc(100vw - 32px))); top:var(--voice-message-top,calc(100% + 8px)); max-width:none;
  left:var(--voice-message-left,0px); right:auto; white-space:normal; overflow-wrap:normal; word-break:normal; hyphens:auto; }
/* Reuse the consent variants without adding short copy to polite announcements. */
.voice-state .consent-narrow { display:none; }
.voice-state .consent-narrow::before { content:attr(data-copy); }
@media(width < 600px) {
  /* A permanent two-line row below the 44px controls also fits at 320px. */
  .voice-signal { height:44px; }
  .voice-wave { align-self:start; margin-top:7px; }
  .band .audio-rail .voice-state, .audio-rail[data-message] .voice-state {
    position:absolute; top:44px; left:-48px; right:auto; width:calc(100% + 192px); max-width:none; height:36px;
    display:flex; flex-wrap:wrap; align-content:center; justify-content:center; column-gap:.35em;
    padding:3px 8px; border:0; border-radius:0; background:none; box-shadow:none;
    font-size:10px; line-height:1.25; text-align:center; white-space:normal; text-wrap:initial;
  }
  .audio-rail .voice-state:empty { display:none; }
  .voice-state .consent-line-copy { display:contents; }
  /* Keep the full sentence in the accessibility tree and the live region. */
  .voice-state .consent-wide { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .voice-state .consent-narrow { display:inline-block; white-space:nowrap; }
  .voice-state .consent-action { flex:none; white-space:nowrap; }
}
.workspace:not([data-stage="live"]) .band .audio-rail { display:grid; }
.header-actions { justify-self:end; justify-content:flex-end; }
.header-actions > .settings-open { flex:none; }
.conversations-toggle { width:44px; min-width:44px; padding:0; justify-content:center; }
.conversations-toggle span { display:none; }
.conversations-toggle > svg:first-child { display:block; width:16px; height:16px; flex:none; }
.conversations-menu { z-index:12; max-height:min(440px,70dvh); overflow-y:auto; }
.header-actions > .host-account { flex:none; }
.conversation > .head { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); }
.conversation > :not(.head) :is(button,textarea) { scroll-margin-top:160px; scroll-margin-bottom:80px; }
.edge-column { position:absolute; top:calc(var(--band-height,90px) * .5 - 25px); left:6px; z-index:11; width:44px; pointer-events:none; }
.edge-column button { display:grid; place-items:center; position:absolute; width:44px; height:44px; padding:8px; background:none; pointer-events:auto; }
.edge-column button svg { width:14px; height:14px; }
.motion-toggle { top:0; color:#fff; }
.motion-toggle svg { fill:currentColor; stroke:currentColor; stroke-width:1.2; opacity:.62;
  filter:drop-shadow(0 0 1px rgba(16,43,66,.45)) drop-shadow(0 1px 2px rgba(16,43,66,.18)); }
.motion-toggle[aria-pressed="false"] svg { fill:none; }
.edge-column button:hover svg, .edge-column button:focus-visible svg { opacity:1; }
.fold { top:calc(var(--band-height,90px) * .5 + 31px); color:var(--aithema-ink); }
.fold svg { opacity:.32; }
.fold[aria-disabled="true"] svg { opacity:.16; }
.fold[aria-expanded="false"] svg { transform:scaleY(-1); }
.edge-column button:focus-visible { outline:2px solid var(--aithema-accent); outline-offset:0; }
.fold-view { grid-column:1/-1; min-width:0; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr); gap:14px; }
.fold-strip { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:14px;
  min-height:64px; width:100%; text-align:left; font-size:14px; line-height:1.4; padding:8px 16px;
  border-radius:14px; background:color-mix(in srgb,var(--aithema-surface) 75%,transparent); box-shadow:0 0 0 1px var(--aithema-line); }
.fold-strip:hover { background:color-mix(in srgb,var(--aithema-surface) 75%,transparent); box-shadow:0 0 0 1px var(--aithema-line-strong); }
.fold-identity { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--aithema-muted); white-space:nowrap; }
.fold-text { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.fold-strip { padding-left:max(16px,calc(54px - var(--aithema-gutter))); }
.fold-question { color:var(--aithema-accent); font-size:12.5px; font-weight:600; }
.drafts-canvas { position:relative; display:grid; min-width:0; min-height:300px; padding:16px;
  border-radius:16px; box-shadow:0 0 0 1px var(--aithema-line); background:color-mix(in srgb,var(--aithema-surface) 60%,transparent); }
.drafts-canvas > * { grid-area:1/1; min-width:0; min-height:0; }
.canvas-empty { display:grid; align-content:center; justify-items:center; gap:10px; color:var(--aithema-muted); font-size:13.5px; }
.canvas-empty > span { text-align:center; }
.canvas-empty svg { width:34px; height:34px; color:var(--aithema-line-strong); }
.canvas-image { width:100%; height:100%; object-fit:contain; }
.canvas-html { width:100%; height:100%; min-height:300px; }
.canvas-status { align-self:end; color:var(--aithema-muted); font-size:12.5px; margin:0; }
.workspace[data-folded] { grid-template-columns:minmax(0,1fr); column-gap:0; }
.workspace[data-stage="live"] .conversation { grid-template-rows:auto minmax(0,1fr) auto; }
.display-foot { position:fixed; z-index:12; bottom:0; left:0; right:0; padding:6px clamp(12px,2vw,28px); padding-bottom:calc(6px + env(safe-area-inset-bottom,0px));
  background:var(--aithema-paper); border-top:1px solid var(--aithema-line);
  color:var(--aithema-muted); font-size:12.5px; }
.display-foot__row { display:grid; grid-template-columns:minmax(max-content,1fr) auto minmax(max-content,1fr); gap:24px; align-items:center; white-space:nowrap; min-height:44px; }
.footer-info { justify-self:start; min-width:0; }
.ai-notice { border-radius:0; display:flex; align-items:center; gap:7px; min-height:44px; padding:0; font-size:12.5px; color:var(--aithema-muted); background:none; }
.ai-notice:hover { background:none; color:var(--aithema-ink); }
.ai-notice .speaker-sign { width:12px; height:12px; }
.ai-notice__label::before, .ai-notice__voice::before { content:'·'; margin-right:7px; }
.ai-notice__short { display:none; }
.display-version { cursor:help; }
.footer-right { display:flex; align-items:center; justify-self:end; gap:12px; }
.engine { position:relative; }
.engine-info { width:44px; height:44px; padding:0; display:grid; place-items:center end; position:relative; }
.engine-info:hover:not(:disabled) { background:none; }
.engine-info .engine__value { position:absolute; right:calc(100% + 2px); white-space:nowrap; opacity:0; transform:translateX(8px); pointer-events:none;
  font:400 12.5px/1.4 var(--aithema-font); color:var(--aithema-muted); background:var(--aithema-paper); transition:opacity .18s,transform .18s; }
.engine-info:hover .engine__value, .engine-info:focus-visible .engine__value { opacity:1; transform:translateX(0); }
.status { display:grid; grid-template-columns:6px auto minmax(8ch,max-content); align-items:center; gap:6px; flex:none; width:auto; height:44px; overflow:visible; font-size:12.5px; line-height:1.4; visibility:visible !important; }
.status__group { display:flex; grid-area:1/1/2/3; justify-self:end; align-items:center; gap:6px; }
.status__dot { width:6px; height:6px; flex:none; border-radius:50%; background:var(--aithema-warning); }
.status__dot[data-state="connected"] { background:var(--aithema-accent); }
.status__label, .status__placeholder { display:block; white-space:nowrap; }
.status__placeholder { visibility:hidden; }
.status__sizer { display:grid; grid-area:1/2; visibility:hidden; pointer-events:none; }
.status__sizer > span { grid-area:1/1; }
.connection-timer { grid-column:3; display:inline-block; min-width:8ch; flex:none; text-align:start; font-variant-numeric:tabular-nums; white-space:nowrap; }
.status[data-message] .status__label, .composer-dock > .status__label { display:block; position:absolute; right:12px; bottom:calc(100% + 6px); z-index:15;
  max-width:min(320px,calc(100vw - 24px)); padding:9px 12px; background:var(--aithema-ink); color:var(--aithema-paper);
  border-radius:10px; white-space:normal; overflow:visible; overflow-wrap:anywhere; }
.composer-dock > .status__label { right:0; bottom:calc(100% + var(--question-card-height,0px) + 8px); font:400 12.5px/1.4 var(--aithema-font); }
.host-credits { position:relative; justify-self:center; display:flex; flex-wrap:nowrap; align-items:center; gap:8px; min-height:44px; padding:0; font-size:12.5px; }
.host-credits__track { display:inline-block; flex:none; width:90px; height:4px; border-radius:4px; background:var(--aithema-line); overflow:hidden; }
.host-credits__track i { display:block; height:100%; background:var(--aithema-accent); border-radius:inherit; }
.concept-bar { padding-left:max(0px,calc(54px - var(--aithema-gutter))); }
.concept-preview-slot:has(.concept-preview:disabled) { display:none; }
.concept-bar:has(.concept-preview:disabled) { grid-template-columns:minmax(0,1fr); }
/* AIT-246: status and preview get independent, permanently reserved rows on phones. */
@media(width < 600px) {
  /* Keep the fold hit area above the rail without narrowing its two rows. */
  .fold { top:calc(var(--band-height,90px) * .5 - 13px); }
  .concept-bar, .concept-bar:has(.concept-preview:disabled) { padding-left:0; grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(44px,auto) 44px; row-gap:0; }
  .concept-rail { grid-area:1/1; }
  .concept-bar .concept-preview-slot { grid-area:2/1; display:grid; justify-items:start; }
  /* AIT-385: use the reserved second row, below the chevron’s 44px target. */
  .workspace:not([data-concept-layout="image"]) .concept-bar .concept-withdrawn { grid-area:2/1; }
  .concept-activity[hidden] { display:grid !important; visibility:hidden; }
  .concept-activity-text { align-self:center; }
  .concept-preview { padding-inline:0; gap:.5rem; white-space:nowrap; }
  .concept-preview-glyph { width:22px; height:22px; }
  /* A surviving image uses the draft's reserved phone slot after consent
     revalidation, so switching kinds cannot move the adjacent rail. */
  .workspace[data-concept-layout="html"] .concept-preview-thumbs { width:22px; height:22px; }
  .concept-preview-glyph svg { width:22px; }
}
.host-credits__text { color:var(--aithema-ink); font-weight:400; white-space:nowrap; }
.host-credits__amount { font-weight:600; }
.host-credits__total { display:inline-block; }
.footer-popup { display:block; position:fixed; z-index:15; width:max-content; max-width:min(320px,calc(100vw - 24px));
  max-height:calc(100dvh - 100px); overflow-y:auto; white-space:pre-line; overflow-wrap:anywhere; padding:10px 12px;
  border-radius:10px; background:var(--aithema-ink); color:var(--aithema-paper); font-size:12.5px; line-height:1.5;
  text-align:left; visibility:hidden; opacity:0; pointer-events:none; transition:opacity .12s; transform:none; }
/* The approved navy surface carries the dark text palette even in a light host.
   Plain aliases also reach the host-owned legal/footer slots through inheritance. */
.footer-info .footer-popup { --aithema-ink:${palette.dark.ink}; --aithema-muted:${palette.dark.muted}; --aithema-accent:${palette.dark.accent};
  --ink:var(--aithema-ink); --muted:var(--aithema-muted); --accent:var(--aithema-accent);
  display:grid; gap:8px; background:#102b42; color:var(--aithema-ink); }
.footer-info .footer-popup p + p { margin-top:0; }
.footer-info .host-foot { gap:8px; }
#build-info { display:grid; gap:2px; }
.version-row { grid-template-columns:minmax(0,1fr); grid-template-rows:1lh; min-width:0; border-radius:3px; }
.version-row:hover { background:color-mix(in srgb,var(--aithema-ink) 6%,transparent); }
/* The shared controller's inline outline must never survive a change to mouse input. */
.version-row:is(:not(:focus-visible),[data-pointer-focus]) { outline:none !important; }
.version-row:focus-visible { outline:2px solid currentColor; }
.version-value { grid-area:1/1; white-space:nowrap; }
.version-row:is([data-copy-state="copied"],[data-copy-state="error"]) .version-value { visibility:hidden; }
.version-row[data-copy-state="error"] .version-feedback { display:flex; align-items:center; gap:6px; min-width:0; white-space:nowrap !important; }
.version-row[data-copy-state="error"] input { flex:1; min-width:0; width:0; height:100%; box-sizing:border-box;
  margin:0 !important; font:inherit !important; padding:0 4px !important; }
.build-label { display:block; color:var(--aithema-muted); }
.engine__detail.footer-popup { height:auto; }
.footer-popup p { margin:0; } .footer-popup p + p { margin-top:6px; }
.footer-popup .host-foot { display:grid; white-space:normal; color:inherit; }
.host-credits__deadline { display:block; margin-top:4px; }
[data-footer-popup]:not([data-dismissed]):is(:hover,:focus-within) .footer-popup { visibility:visible; opacity:1; pointer-events:auto; }
[data-footer-popup][data-pinned]:not([data-dismissed]) .footer-popup { visibility:visible; opacity:1; pointer-events:auto; }
[data-footer-popup][data-dismissed] .footer-popup { visibility:hidden; opacity:0; pointer-events:none; }
@media(max-width:1099px) {
  .band { grid-template-columns:44px minmax(0,1fr); gap:8px 16px; }
  .band .audio-rail { grid-column:1/-1; grid-row:2; width:min(100%,720px); }
  .header-actions { grid-column:2; grid-row:1; }
}
@media(900px <= width < 1024px) {
  .ai-notice { font-size:11.5px; } .host-credits__track { width:44px; }
}
@media(600px <= width < 900px) {
  .ai-notice,.host-credits,.status { font-size:11px; }
  .host-credits__track { width:44px; }
}
@media(width < ${FOOTER_WIDTHS.voice}px) { .ai-notice__voice { display:none; } }
@media(width < ${FOOTER_WIDTHS.identity}px) {
  .display-version, .ai-notice__label, .ai-notice__voice { display:none; }
  .ai-notice__short { display:inline; }
}
@media(width < ${FOOTER_WIDTHS.compact}px) {
  .status__label, .status__placeholder, .status__sizer, .host-credits__total { display:none; }
  .host-credits__track { width:60px; }
  .status__group { grid-column:1; }
  .status { grid-template-columns:6px 8ch; gap:6px; } .connection-timer { grid-column:2; }
  .display-foot__row:has(.engine-info:is(:hover,:focus-visible)) :is(.host-credits__unit,.host-credits__track) { visibility:hidden; }
}
@media(width < ${FOOTER_WIDTHS.number}px) {
  .host-credits__unit, .engine-info .engine__value { display:none; }
  .host-credits__track { width:48px; }
}
@media(max-width:600px) {
  .display-foot { bottom:var(--phone-bottom,0px); }
}
/* Tablet labels yield only to a visible credit balance. */
@media(700px <= width < 900px) {
  .display-foot:has(.host-credits:not([hidden])) .status__group { grid-column:1; }
  .display-foot:has(.host-credits:not([hidden])) .status { grid-template-columns:6px 8ch; gap:6px; }
  .display-foot:has(.host-credits:not([hidden])) :is(.status__label,.status__placeholder,.status__sizer) { display:none; }
  .display-foot:has(.host-credits:not([hidden])) .connection-timer { grid-column:2; }
}
@media(max-width:599px) {
  .band { gap:6px 8px; padding-right:8px; }
  .header-actions { gap:0; }
  .conversations-wrap, .host-bar { min-width:0; }
  .conversations-wrap { position:static; }
  .conversations-menu { z-index:12; left:12px; right:12px; top:62px; width:auto; }
  .band:has(> .audio-rail) .conversations-menu { top:50px; }
  .band .audio-rail { gap:4px; margin-left:-4px; width:100%; }
  .voice-state,.voice-caption { font-size:10px; padding-inline:4px; }
  .voice-state { max-width:100%; }
  .fold-strip { gap:8px; padding-left:max(12px,calc(54px - var(--aithema-gutter))); padding-right:12px; grid-template-columns:auto minmax(0,1fr); }
  .fold-question { grid-column:2; }
  .composer { margin-bottom:0; }
  .drafts-canvas { min-height:60svh; }
}
${headerGeometry('.band')}
/* Beyond the shared first-paint reservation, measured host copy can add a row. */
@media(min-width:600px) {
  .band[data-rail-row] { --band-height:150px; grid-template-rows:60px 48px; }
  .band[data-rail-row] > .audio-rail { grid-column:1/-1; grid-row:2; }
}
/* AIT-260: approved host frame. Host text gets only its natural width, capped
   before it can squeeze the rail or the permanently reserved action targets. */
.band > .header-actions { grid-column:3; grid-row:1; }
.band-identity { display:flex; align-items:center; gap:12px; min-width:0; max-width:27vw; }
.band-identity .band-orb { flex:none; }
.band .wordmark { margin:0; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  font:400 18px/1.25 var(--aithema-display); letter-spacing:.005em; }
slot[name="brand"]::slotted(*) { display:block; margin:0; font:inherit !important; color:inherit !important; letter-spacing:inherit !important; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversations-toggle { width:168px; gap:8px; padding:0 12px; justify-content:center; font-size:15.5px; }
.conversations-toggle span { display:inline; }
.conversations-toggle > svg:first-child { display:block; }
.conversations-toggle > svg:last-child { display:block; width:10px; height:10px; color:var(--aithema-muted); }
.conversations-toggle:hover, .conversations-toggle[aria-expanded="true"] { background:color-mix(in srgb,var(--aithema-ink) 6%,transparent); }
.footer-right { grid-column:3; min-width:0; }
/* Host legal text yields before the preset button's existing 44 px target. */
.footer-right .preset-panel { flex:none; }
.display-foot:has(.host-credits[hidden]) .footer-right { gap:14px; }
.display-foot:has(.host-legal:not([hidden])):has(.host-credits:not([hidden])) .display-foot__row { grid-template-columns:auto auto minmax(0,1fr); }
.host-legal { display:flex; align-items:center; min-width:0; margin-left:10px; font:inherit; color:inherit; }
slot[name="legal"]::slotted(*) { min-width:0; margin:0; font:inherit; color:inherit; }
slot[name="legal"]::slotted(a) { display:inline-flex; align-items:center; min-height:44px; padding:0 8px; text-decoration:underline; text-underline-offset:3px; }
.version-details { display:grid; gap:2px; }
.version-details #build-info { display:contents; }
.version-details .version-row { order:1; }
.host-version { order:2; white-space:normal; }
.host-version__value::before { content:'${reasonSeparator}'; white-space:pre; }
.version-details .build-label { order:3; }
.footer-info .footer-popup { padding:11px 13px 12px; background:${palette.light.ink}; box-shadow:0 0 0 1px var(--aithema-line),0 12px 30px -14px rgba(0,0,0,.45); }
.footer-popup .phone-status { display:none; color:var(--aithema-muted); }
.connection-timer::before { content:'${reasonSeparator}'; }
/* Legal-host type stays the same in every fit, including tablet widths. */
@media(min-width:900px) {
  .display-foot:has(.host-legal:not([hidden])):has(.host-credits[hidden]) :is(.ai-notice,.status) { font-size:12.5px; }
}
/* Only full fit restores the approved legal-host visibility and grid.
   Compact fits yield to the shared rules below; credit hosts are unchanged. */
@media(min-width:900px) {
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) .ai-notice__label { display:inline; }
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) .status { grid-template-columns:6px auto minmax(8ch,max-content); gap:6px; }
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) .status__group { grid-column:1/3; }
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) .status__sizer,
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) :is(.status__label,.status__placeholder) { display:grid; }
  .display-foot:is(:not([data-fit]),[data-fit="full"]):has(.host-legal:not([hidden])):has(.host-credits[hidden]) .connection-timer { grid-column:3; }
}
@media(max-width:599px) {
  .band > .header-actions { grid-column:2; }
}
@media(600px <= width < 1100px) {
  .display-foot:has(.host-legal:not([hidden])):has(.host-credits:not([hidden])) :is(.ai-notice__label,.host-credits__total,.host-credits__measure-total) { display:none; }
}
@media(width < 600px) {
  .edge-column { top:12px; }
  .fold { top:calc(var(--band-height,68px) - 8px); }
  .concept-rail, .concept-bar .concept-preview-slot { padding-left:38px; }
  .band-identity { gap:10px; max-width:none; }
  .band .wordmark { font-size:16.5px; }
  .conversations-toggle { width:44px; min-width:44px; padding:0; }
  .conversations-toggle span, .conversations-toggle > svg:last-child { display:none; }
  .conversations-toggle > svg:first-child { display:block; }
  .display-foot__row { grid-template-columns:auto minmax(0,1fr) auto; gap:8px; }
  .footer-right, .display-foot:has(.host-credits[hidden]) .footer-right { gap:0; }
  .footer-right .status { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .ai-notice { min-width:44px; font-size:12.5px; }
  .ai-notice .speaker-sign { display:block; }
  .engine-info { width:44px; }
  .host-legal { margin-left:4px; }
  .footer-info .phone-status { display:block; }
  .footer-info .connection-timer { grid-column:auto; min-width:8ch; }
  .display-foot:has(.host-legal:not([hidden])) .host-credits__track { display:none; }
}
/* Credit-enabled hosts also fit the existing 320px embedding contract. The
   approved 390px frame retains its normal type and spacing. Targets stay 44px. */
@media(width < 360px) {
  /* At 320px Linux fallback fonts wrap the ready status at 13px, growing the
     rail. Keep this reservation and its status at 12px to prevent movement. */
  .concept-activity-text, .drafts-reason-reserve { font-size:12px; }
  .display-foot:has(.host-legal:not([hidden])):has(.host-credits:not([hidden])) .display-foot__row { gap:0; }
  .display-foot:has(.host-legal:not([hidden])):has(.host-credits:not([hidden])) :is(.host-credits,.host-legal) { font-size:11px; }
  .display-foot:has(.host-credits:not([hidden])) .host-legal { margin-left:0; }
  .display-foot:has(.host-legal:not([hidden])):has(.host-credits:not([hidden])) { padding-inline:4px; }
}
/* Tablet input ends above the measured footer, including the extra rail row.
   The overview remains scrollable below this bounded conversation. */
@media(600px < width < 960px) {
  .workspace[data-stage="live"] .conversation { min-height:0;
    height:calc(var(--phone-height,100dvh) - var(--phone-band,90px) - var(--phone-footer,57px) - 24px); }
  .workspace[data-stage="live"] :is(.concept-thread,.transcript-shell) { min-height:0; height:auto; }
}
/* Preserve the product identity; measured host content yields before legal,
   the preset flag or the named connection dot. Phones keep their AIT-281 frame. */
@media(min-width:600px) {
  .display-foot .footer-left { width:max-content; }
  .display-foot:has(.host-credits[hidden]) .display-foot__row { grid-template-columns:minmax(0,1fr) auto auto; }
  .display-foot .display-version { display:inline; }
  .display-foot .ai-notice__short { display:none; }
  .display-foot .ai-notice :is(.ai-notice__label,.ai-notice__voice) { display:inline; }
  .display-foot[data-fit]:not([data-fit="full"]) .ai-notice :is(.ai-notice__label,.ai-notice__voice) { display:none; }
  .display-foot:is([data-fit="timer"],[data-fit="role"]) .footer-right > .status { grid-template-columns:6px auto; }
  .display-foot:is([data-fit="timer"],[data-fit="role"]) .status .connection-timer { display:none; }
  .display-foot[data-fit="role"] .actor-role { display:none; }
  .display-foot[data-fit="role"] .footer-left { gap:0; }
  .display-foot[data-fit="role"] .host-credits__track { width:12px; }
}
/* Apply the baseline drop synchronously at the breakpoint; a compact marker
   from a phone must not survive the first desktop frame after resizing. */
@media(600px <= width < ${FOOTER_WIDTHS.voice}px) {
  .display-foot .ai-notice :is(.ai-notice__label,.ai-notice__voice) { display:none; }
}
:host([motion="off"]) * { animation:none !important; }
:host([motion="off"]) :is(.orb *, .concept-scene *, .understanding) { animation:none !important; transition:none !important; }
:host([motion="off"]) .engine__value { transition:none; }
`;
