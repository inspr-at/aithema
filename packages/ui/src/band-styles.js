import { FOOTER_WIDTHS } from './layout.js';

// AIT-131, approved round 2: edge-to-edge band, one edge column and three footer zones.
export const bandStyles = `
.workspace { position:relative; max-width:none; padding-bottom:68px; }
.band { grid-area:top; position:sticky; top:0; z-index:10; display:grid; grid-template-columns:40px minmax(0,1fr) auto;
  align-items:center; gap:12px 24px; margin-inline:calc(-1 * var(--aithema-gutter));
  padding:12px var(--aithema-gutter) 18px 54px; min-height:90px;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-paper)),color-mix(in srgb,var(--aithema-accent) 4%,transparent) 70%,transparent); }
.band::after { content:''; position:absolute; inset:auto 0 0; height:1px;
  background:linear-gradient(to right,transparent,var(--aithema-line-strong) 18%,var(--aithema-line-strong) 82%,transparent); }
.band-orb { width:40px; height:44px; display:grid; place-items:center; }
.band-orb .orb { --orb-size:40px; width:40px; height:40px; }
.band .audio-rail { justify-self:center; width:min(100%,720px); display:grid; grid-template-columns:44px minmax(0,1fr) 44px 44px 44px; }
.audio-rail button { background:color-mix(in srgb,var(--aithema-surface) 50%,transparent); }
.audio-rail button:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-surface) 50%,transparent); }
.audio-rail .pause, .audio-rail .pause:hover:not(:disabled) { background:var(--aithema-ink); }
.audio-rail .voice-pause { visibility:hidden; }
.voice-signal { height:44px; }
.voice-wave { height:30px; }
.voice-state, .voice-caption { padding:3px 8px; border-radius:0; font-size:12px;
  background:linear-gradient(to right,transparent,var(--aithema-paper) 10%,var(--aithema-paper) 90%,transparent); box-shadow:none; }
.audio-rail[data-message] .voice-state { left:0; }
.workspace:not([data-stage="live"]) .band .audio-rail { display:grid; }
.workspace:not([data-stage="live"]) .band .audio-rail { opacity:.65; }
.header-actions { justify-self:end; }
.conversations-toggle { width:auto; white-space:nowrap; }
.conversations-toggle > svg:first-child { display:none; }
.conversations-menu { max-height:min(440px,70dvh); overflow-y:auto; }
.host-extras { position:absolute; top:calc(var(--band-height,90px) + 8px); right:var(--aithema-gutter); z-index:2; width:auto; }
.host-extras:has(.host-verify:empty):has(.host-account slot:only-child) { min-height:0; }
.conversation > .head { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); }
.conversation > :not(.head) :is(button,textarea) { scroll-margin-top:160px; scroll-margin-bottom:80px; }
.edge-column { position:absolute; top:28px; left:6px; z-index:11; width:44px; pointer-events:none; }
.edge-column button { display:grid; place-items:center; position:absolute; width:44px; height:44px; padding:8px; background:none; pointer-events:auto; }
.edge-column button svg { width:28px; height:28px; }
.motion-toggle { top:0; color:#fff; }
.motion-toggle svg { fill:currentColor; stroke:currentColor; stroke-width:1.2; opacity:.62;
  filter:drop-shadow(0 0 1px rgba(16,43,66,.45)) drop-shadow(0 1px 2px rgba(16,43,66,.18)); }
.motion-toggle[aria-pressed="false"] svg { fill:none; }
.edge-column button:hover svg, .edge-column button:focus-visible svg { opacity:1; }
.fold { top:calc(var(--band-height,90px) - 28px + 8px); color:var(--aithema-ink); }
.fold svg { opacity:.32; }
.fold[aria-expanded="false"] svg { transform:scaleY(-1); }
.edge-column button:focus-visible { outline:2px solid var(--aithema-accent); outline-offset:0; }
.fold-view { grid-column:1/-1; min-width:0; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr); gap:14px; }
.fold-strip { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:14px;
  min-height:64px; width:100%; text-align:left; font-size:14px; line-height:1.4; padding:8px 16px;
  border-radius:14px; background:color-mix(in srgb,var(--aithema-surface) 75%,transparent); box-shadow:0 0 0 1px var(--aithema-line); }
.fold-strip:hover { background:color-mix(in srgb,var(--aithema-surface) 75%,transparent); box-shadow:0 0 0 1px var(--aithema-line-strong); }
.fold-identity { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--aithema-muted); white-space:nowrap; }
.fold-text { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.fold-question { color:var(--aithema-accent); font-size:12.5px; font-weight:600; }
.drafts-canvas { position:relative; display:grid; min-width:0; min-height:300px; padding:16px;
  border-radius:16px; box-shadow:0 0 0 1px var(--aithema-line); background:color-mix(in srgb,var(--aithema-surface) 60%,transparent); }
.drafts-canvas > * { grid-area:1/1; min-width:0; min-height:0; }
.canvas-empty { display:grid; align-content:center; justify-items:center; gap:10px; color:var(--aithema-muted); font-size:13.5px; }
.canvas-empty svg { width:34px; height:34px; color:var(--aithema-line-strong); }
.canvas-image { width:100%; height:100%; object-fit:contain; }
.canvas-html { width:100%; height:100%; min-height:300px; }
.canvas-status { align-self:end; color:var(--aithema-muted); font-size:12.5px; margin:0; }
.workspace[data-folded] { grid-template-columns:minmax(0,1fr); column-gap:0; }
.workspace[data-stage="live"] .conversation { grid-template-rows:auto minmax(0,1fr) auto; }
.display-foot { position:fixed; z-index:12; bottom:0; left:0; right:0; padding:6px clamp(12px,2vw,28px);
  background:color-mix(in srgb,var(--aithema-paper) 94%,transparent); border-top:1px solid var(--aithema-line);
  color:var(--aithema-muted); font-size:12.5px; container:foot / inline-size; }
.display-foot__row { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); gap:16px; align-items:center; white-space:nowrap; min-height:44px; }
.footer-info { justify-self:start; min-width:0; }
.ai-notice { border-radius:0; display:flex; align-items:center; gap:7px; min-height:44px; padding:0; font-size:12.5px; color:var(--aithema-muted); background:none; }
.ai-notice:hover { background:none; color:var(--aithema-ink); }
.ai-notice .speaker-sign { width:12px; height:12px; }
.ai-notice__label::before, .ai-notice__voice::before { content:'·'; margin-right:7px; }
.ai-notice__short { display:none; }
.display-version { cursor:help; }
.footer-right { display:flex; align-items:center; justify-self:end; gap:8px; }
.engine { position:relative; }
.engine-info { width:44px; height:44px; padding:0; display:grid; place-items:center; position:relative; }
.engine-info .engine__value { position:absolute; right:calc(100% + 2px); white-space:nowrap; opacity:0; transform:translateX(8px); pointer-events:none;
  background:var(--aithema-paper); transition:opacity .18s,transform .18s; }
.engine-info:hover .engine__value, .engine-info:focus-visible .engine__value { opacity:1; transform:translateX(0); }
.status { display:flex; align-items:center; gap:8px; flex:none; width:auto; height:44px; overflow:visible; font-size:12.5px; line-height:1.4; visibility:visible !important; }
.status[data-connected]::before { content:none; }
.status__label { display:block; max-width:8em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.connection-timer { display:inline-block; width:8ch; flex:none; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.host-credits { position:relative; justify-self:center; display:flex; flex-wrap:nowrap; align-items:center; gap:8px; min-height:44px; padding:0; font-size:12.5px; }
.host-credits__track { display:inline-block; flex:none; width:90px; height:4px; border-radius:4px; background:var(--aithema-line); overflow:hidden; }
.host-credits__track i { display:block; height:100%; background:var(--aithema-accent); border-radius:inherit; }
.host-credits__text { color:var(--aithema-ink); font-weight:600; white-space:nowrap; }
.footer-popup { display:block; position:fixed; z-index:15; width:max-content; max-width:min(320px,calc(100vw - 24px));
  max-height:calc(100dvh - 100px); overflow-y:auto; white-space:pre-line; overflow-wrap:anywhere; padding:10px 12px;
  border-radius:10px; background:var(--aithema-ink); color:var(--aithema-paper); font-size:12.5px; line-height:1.5;
  text-align:left; visibility:hidden; opacity:0; pointer-events:none; transition:opacity .12s; transform:none; }
.footer-popup p { margin:0; } .footer-popup p + p { margin-top:6px; }
.footer-popup .host-foot { display:grid; white-space:normal; color:inherit; }
.host-credits__deadline { display:block; margin-top:4px; }
[data-footer-popup]:not([data-dismissed]):is(:hover,:focus-within) .footer-popup { visibility:visible; opacity:1; pointer-events:auto; }
[data-footer-popup][data-dismissed] .footer-popup { visibility:hidden; opacity:0; pointer-events:none; }
@media(max-width:1099px) {
  .band { grid-template-columns:40px minmax(0,1fr); gap:8px 16px; }
  .band .audio-rail { grid-column:1/-1; grid-row:2; width:min(100%,720px); }
  .header-actions { grid-column:2; grid-row:1; }
  .edge-column { --band-height:142px; }
}
@container foot (width < ${FOOTER_WIDTHS.voice}px) { .ai-notice__voice { display:none; } }
@container foot (width < ${FOOTER_WIDTHS.compact}px) {
  .display-version, .ai-notice__label, .ai-notice__voice, .status__label, .host-credits__total { display:none; }
  .ai-notice__short { display:inline; }
  .host-credits__track { width:60px; }
  .display-foot__row { gap:8px; }
  .footer-right { gap:0; }
}
@container foot (width < ${FOOTER_WIDTHS.number}px) { .host-credits__unit { display:none; } .host-credits__track { width:48px; } }
@media(max-width:599px) {
  .band { gap:6px 8px; padding-right:8px; }
  .header-actions { gap:0; } .conversations-toggle { font-size:12px; padding:0 4px; min-width:88px; }
  .band .audio-rail { gap:4px; margin-left:-4px; width:100%; }
  .voice-state,.voice-caption { font-size:10px; padding-inline:4px; }
  .fold-strip { gap:8px; padding-inline:12px; grid-template-columns:auto minmax(0,1fr); }
  .fold-question { grid-column:2; }
  .composer { margin-bottom:0; }
  .drafts-canvas { min-height:60svh; }
}
@media(max-width:359px) {
  .conversations-toggle { min-width:44px; width:44px; padding:0; justify-content:center; }
  .conversations-toggle > svg:first-child { display:block; }
  .conversations-toggle span, .conversations-toggle > svg:last-child { display:none; }
}
:host([motion="off"]) :is(.orb *, .concept-scene *, .understanding) { animation:none !important; transition:none !important; }
:host([motion="off"]) .engine__value { transition:none; }
`;
