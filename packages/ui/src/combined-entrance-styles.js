// The opt-in entrance and live call share one bottom-anchored composer.
export const combinedEntranceStyles = `
.workspace[data-entrance="combined"] { height:var(--aithema-height); min-height:40rem; grid-template-rows:auto minmax(0,1fr) auto; padding-bottom:1rem; }
.workspace[data-entrance="combined"] .conversation { display:flex; flex-direction:column; min-height:0; }
.workspace[data-entrance="combined"] .intro { flex:0 1 auto; min-height:0; max-height:45%; overflow:auto; grid-template-columns:minmax(0,1fr); padding:.5rem 0; gap:.5rem; }
.workspace[data-entrance="combined"] .intro[hidden] { display:none; }
.workspace[data-entrance="combined"] .intro__prompt { display:none; }
.workspace[data-entrance="combined"] .intro__card { width:100%; }
.workspace[data-entrance="combined"] .ready { width:100%; padding:1rem; gap:.5rem; }
.workspace[data-entrance="combined"] .concept-thread { flex:1 1 0; min-height:0; }
.workspace[data-entrance="combined"] .transcript-shell { display:block; height:100%; min-height:0; }
.workspace[data-entrance="combined"] .composer-dock { display:block; flex:none; }
.workspace[data-entrance="combined"] .composer-shell { display:block; }
.workspace[data-entrance="combined"] .composer { display:grid; grid-template-columns:minmax(0,1fr) 44px 44px;
  grid-template-areas:"notice notice notice" "message mic send" "feedback feedback feedback"; gap:8px; }
.workspace[data-entrance="combined"] textarea { grid-area:message; height:4.5rem; min-height:4.5rem; padding:.25rem 0; }
.workspace[data-entrance="combined"] .composer-actions { display:contents; }
.workspace[data-entrance="combined"] .attach { display:none; }
.workspace[data-entrance="combined"] .send { grid-area:send; align-self:center; }
.workspace[data-entrance="combined"] .composer-feedback { grid-area:feedback; margin:0; height:2.6em; font-size:.72rem; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason { font-size:inherit; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason[data-shortcut] { position:static; visibility:visible; width:auto; }
.composer-notice { grid-area:notice; height:8.7em; overflow:auto; margin:0; color:var(--aithema-muted); font-size:.75rem; line-height:1.45; }
.composer-mic { grid-area:mic; align-self:center; display:grid; place-items:center; width:44px; height:44px; padding:0; border:1px solid var(--aithema-line); border-radius:50%; color:var(--aithema-accent); background:var(--aithema-surface); }
.composer-mic svg { width:20px; height:20px; }
.composer-mic[aria-pressed="true"] { background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-surface)); }
.composer-status { grid-area:feedback; align-self:center; min-width:0; height:2.6em; overflow:auto; color:var(--aithema-muted); font-size:.72rem; line-height:1.3; }
.composer-status:empty { visibility:hidden; }
.composer-actions:has(.composer-status:not(:empty)) .composer-feedback { visibility:hidden; }
@media(min-width:60rem) {
  /* Reserve the conversation width before the overview reveals. */
  .workspace[data-entrance="combined"][data-understanding="absent"] { grid-template-columns:minmax(0,1.55fr) minmax(22rem,.88fr); column-gap:clamp(1rem,2.5vw,2rem); }
}
@media(max-width:600px) {
  .workspace[data-entrance="combined"] { height:auto; padding-bottom:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-entrance="combined"] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 32px); min-height:12rem; }
  .workspace[data-entrance="combined"] .composer-dock { position:fixed; z-index:9; left:var(--aithema-gutter); right:var(--aithema-gutter); bottom:calc(var(--phone-bottom,0px) + var(--phone-footer,57px) + 12px); }
  .workspace[data-entrance="combined"] .phone-dock-backdrop { display:block; position:fixed; z-index:8; left:0; right:0; bottom:var(--phone-bottom,0px); height:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); background:var(--aithema-paper); mask-image:linear-gradient(to bottom,transparent,#000 12px); }
}
`;
