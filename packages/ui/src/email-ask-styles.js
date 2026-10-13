// AIT-164: the assessment and ask share one fixed cell; the dock grows upward.
export const emailAskStyles = `
.analysis-stack { position:relative; display:grid; min-height:0; min-width:0; }
/* Retry can wrap to two lines, then disappear when a call pauses. Keep its
   maximum row height so the neighboring Export target stays in place. */
.workspace[data-host] .understanding > .foot { height:calc(4.15rem + 1px); min-height:calc(4.15rem + 1px); }
.analysis-stack > :is(.analysis-content,.email-ask-pane) { grid-area:1/1; min-height:0; min-width:0; }
.email-ask-pane { visibility:hidden; opacity:0; overflow:auto; scrollbar-width:thin; padding:18px 0; transition:opacity .24s; }
.workspace[data-email-ask="pane"] .email-ask-pane { visibility:visible; opacity:1; }
.workspace[data-email-ask="pane"] .analysis-content { visibility:hidden; opacity:0; }
.analysis-content { transition:opacity .2s; }
.email-ask-fold { position:absolute; top:0; left:0; right:0; min-height:44px; padding:0; text-align:left; color:var(--aithema-accent); font-size:13px; visibility:hidden; }
.email-ask { display:grid; gap:12px; align-content:start; min-width:0; color:var(--aithema-ink); font:15px/1.5 var(--aithema-font); }
.email-ask :is(p,h2,ul) { margin:0; }
.email-ask__context { display:grid; gap:1px; font-size:13px; line-height:1.4; color:var(--aithema-muted); }
.email-ask__kickers { display:grid; }
.email-ask__kickers > * { grid-area:1/1; }
.email-ask__kicklow { visibility:hidden; }
.email-ask[data-why="low"] .email-ask__kick5 { visibility:hidden; }
.email-ask[data-why="low"] .email-ask__kicklow { visibility:inherit; }
.email-ask__balance { white-space:nowrap; font-variant-numeric:tabular-nums; }
:is(.email-ask__balance,.voice-state).low { color:var(--aithema-warning); font-weight:600; }
.email-ask h2 { font:400 24px/1.18 var(--aithema-display); letter-spacing:-.01em; text-transform:none; color:var(--aithema-ink); text-wrap:balance; }
.email-ask__benefits { display:grid; gap:6px; padding:0; list-style:none; font-size:14px; line-height:1.4; }
.email-ask__benefits li { display:grid; grid-template-columns:16px minmax(0,1fr); gap:9px; align-items:start; }
.email-ask__benefits svg { width:16px; height:16px; margin-top:2px; color:var(--aithema-accent); }
.email-ask__stack { display:grid; }
.email-ask__stack > * { grid-area:1/1; min-width:0; }
.email-ask__form { display:grid; gap:6px; margin:0; }
.email-ask__form > * { grid-area:auto; }
.email-ask .m-msg { align-items:start; min-height:2.6em; }
.email-ask__done { visibility:hidden; display:grid; gap:4px; align-content:start; padding-top:2px; }
.email-ask[data-step="done"] .email-ask__form { visibility:hidden; }
.email-ask[data-step="done"] .email-ask__done { visibility:inherit; }
.email-ask__done .m-tier { color:var(--aithema-ink); }
.email-ask__hint { font-size:12.5px; line-height:1.45; color:var(--aithema-muted); }
.email-ask__actions { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; }
.email-ask__save { grid-column:2; grid-row:1; min-height:44px; padding:0 1.15rem; border-radius:.55rem; background:var(--aithema-accent); color:var(--aithema-on-accent); font-size:14px; font-weight:600; }
.email-ask__skip { grid-column:1; grid-row:1; justify-self:start; min-height:44px; margin-left:-.7rem; padding:.3rem .7rem; border-radius:.6rem; color:var(--aithema-accent); font-size:14px; line-height:1.25; text-align:left; }
.email-ask__skip:hover { background:color-mix(in srgb,var(--aithema-accent) 8%,transparent); }
.email-ask[data-step="done"] .email-ask__save { visibility:hidden; }
.email-ask-dock { position:absolute; inset:auto 0 0; height:0; z-index:6; pointer-events:none; filter:drop-shadow(0 14px 22px color-mix(in srgb,var(--aithema-ink) 16%,transparent)); }
.email-ask-dock > .email-ask { position:absolute; inset:auto 0 0; padding:18px 16px 10px 18px; border-radius:18px; background:var(--aithema-surface); box-shadow:inset 0 0 0 1px var(--aithema-line);
  visibility:hidden; pointer-events:none; transform:translateY(0); clip-path:inset(calc(100% - var(--email-composer-height,118px)) 0 0 0 round 18px);
  max-height:calc(100dvh - 180px); overflow:auto; scrollbar-width:thin;
  transition:clip-path .42s cubic-bezier(.2,.8,.2,1),transform .42s cubic-bezier(.2,.8,.2,1),visibility 0s .42s; }
.email-ask-dock > .email-ask > * { opacity:0; transition:opacity .16s; }
.workspace[data-email-ask="dock"] .email-ask-dock > .email-ask { visibility:visible; pointer-events:auto; transform:translateY(-20px); clip-path:inset(0 0 0 0 round 18px); transition:clip-path .42s cubic-bezier(.2,.8,.2,1),transform .42s cubic-bezier(.2,.8,.2,1); }
.workspace[data-email-ask="dock"] .email-ask-dock > .email-ask > * { opacity:1; transition:opacity .22s .16s; }
.workspace[data-email-ask="dock"] :is(.transcript-shell,.concept-bar,.qcard) { filter:blur(2.5px); opacity:.5; }
.workspace[data-email-ask="dock"] .composer-shell { visibility:hidden; }
:is(.transcript-shell,.concept-bar,.qcard) { transition:filter .32s,opacity .32s; }
.email-low-line { display:grid; grid-template-columns:16px minmax(0,1fr); gap:9px; align-items:start; padding:4px .8rem 2px; font-size:13.5px; line-height:1.5; color:var(--aithema-ink); }
.email-low-line__icon { display:grid; height:20px; color:var(--aithema-warning); }
.email-low-line__icon svg { width:16px; height:16px; }
.email-low-line__action { position:relative; padding:0; color:var(--aithema-accent); font:600 13.5px/1.5 var(--aithema-font); text-decoration:underline; text-underline-offset:3px; }
.email-low-line__action::after { content:""; position:absolute; inset:-12px -6px; }
.host-credits__stack { font-variant-numeric:tabular-nums; }
.host-credits__measure { visibility:hidden; white-space:nowrap; }
.host-credits__measure-low { visibility:hidden; white-space:nowrap; }
.host-credits__measure-low-short { display:none; }
.host-credits__low { visibility:hidden; white-space:nowrap; color:var(--aithema-warning); }
.host-credits__low-short { display:none; }
.host-credits[data-low="true"]:not([data-ended="true"]) .host-credits__text { visibility:hidden; }
.host-credits[data-low="true"]:not([data-ended="true"]) .host-credits__low { visibility:visible; }
.host-credits[data-low="true"]:not([data-ended="true"]) .host-credits__track i { background:var(--aithema-amber); }
@media(width < 600px) { .host-credits__measure-total { display:none; } }
@media(width < 360px) { .host-credits__measure-unit { display:none; } .host-credits__low-full,.host-credits__measure-low-full { display:none; } .host-credits__low-short,.host-credits__measure-low-short { display:inline; } }
@media(max-width:600px) { .email-ask h2 { font-size:22px; } .email-ask { gap:11px; } }
:host([motion="off"]) :is(.email-ask,.email-ask > *,.analysis-content,.email-ask-pane,.transcript-shell,.concept-bar,.qcard) { transition:none !important; }
:host([motion="off"]) .workspace[data-email-ask="dock"] .email-ask { transform:none; }
@media(prefers-reduced-motion:reduce) {
  :is(.email-ask,.email-ask > *,.analysis-content,.email-ask-pane,.transcript-shell,.concept-bar,.qcard) { transition:none !important; }
  .workspace[data-email-ask="dock"] .email-ask { transform:none; }
}
`;
