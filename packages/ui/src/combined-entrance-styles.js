// The opt-in entrance and live call share one bottom-anchored composer.
export const combinedEntranceStyles = `
.workspace[data-entrance="combined"] { height:var(--aithema-height); min-height:40rem; grid-template-rows:auto minmax(0,1fr) auto; padding-bottom:1rem; }
.workspace[data-entrance="combined"] .conversation { display:flex; flex-direction:column; min-height:0; gap:8px; }
/* The whole entrance/transcript surface scrolls above the reserved input row. */
.workspace[data-entrance="combined"] .conversation-scroll { display:flex; flex-direction:column; flex:1 1 0; min-height:0; overflow:auto; scrollbar-gutter:stable; gap:.85rem; }
.workspace[data-entrance="combined"] .intro { flex:none; min-height:0; grid-template-columns:minmax(0,1fr); padding:.5rem 0; gap:.5rem; }
.workspace[data-entrance="combined"] .intro[hidden] { display:none; }
.workspace[data-entrance="combined"] .intro__prompt { display:none; }
.workspace[data-entrance="combined"] .intro__card { width:100%; }
.workspace[data-entrance="combined"] .ready { width:100%; padding:1rem; gap:.5rem; }
.workspace[data-entrance="combined"] .concept-thread { display:block; flex:1 1 0; min-height:0; }
/* Keep the welcome first and its coordinates stable when readiness gives way
   to the conversation. Processing choices remain on the same scroll surface. */
.workspace[data-entrance="combined"] .concept-thread:has([data-host-opener]) { order:-1; min-height:6rem; }
/* Before input, the full welcome owns its intrinsic height above readiness. */
.workspace[data-entrance="combined"]:not([data-stage="live"]) .concept-thread:has([data-host-opener]) { flex:none; }
.workspace[data-entrance="combined"]:not([data-stage="live"]) .concept-thread:not(:has(ol > li)) { display:none; }
/* The sticky-header guard adds a top margin after page scroll. Deduct that
   inset from the pane height so native focus cannot scroll a second container. */
.workspace[data-entrance="combined"] .transcript-shell { display:block; height:calc(100% - var(--transcript-top-inset,0px)); min-height:0; }
/* This pane already clears the sticky band and fixed input/footer. The page's
   dock-sized focus margin would scroll an inline field out of this smaller pane. */
.workspace[data-entrance="combined"] .transcript-shell :is(button,a,input,textarea,select,[tabindex]) { scroll-margin:2px; }
/* The saved address replaces the input in the same reserved row. Retain its
   full accessible text while keeping long addresses beside localized Resend. */
.workspace[data-entrance="combined"] .email-offer__address { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* Canonical replies gain playback controls. Reserve their row before input so
   persistence cannot resize the welcome bubble or shift the content below it. */
.workspace[data-entrance="combined"] [data-host-opener]:not(:has(.reply-actions))::after { content:''; display:block; height:44px; }
.workspace[data-entrance="combined"] .composer-dock { display:block; flex:none; }
.workspace[data-entrance="combined"] .composer-shell { display:grid; }
.workspace[data-entrance="combined"] .composer { display:grid; grid-template-columns:minmax(0,1fr) 44px 44px;
  grid-template-areas:"notice notice notice" "message mic send" "feedback feedback feedback" "status status status"; gap:8px; }
/* Staging grows above the controls, keeping their bottom reservation intact. */
.workspace[data-entrance="combined"] .composer:has(.staged-images:not([hidden])) {
  grid-template-areas:"images images images" "notice notice notice" "message mic send" "feedback feedback feedback" "status status status"; }
.workspace[data-entrance="combined"] .staged-images { grid-area:images; }
.workspace[data-entrance="combined"] textarea { grid-area:message; height:4.5rem; min-height:4.5rem; padding:.25rem 0; }
.workspace[data-entrance="combined"] .composer-actions { display:contents; }
.workspace[data-entrance="combined"] .attach { display:none; }
.workspace[data-entrance="combined"] .send { grid-area:send; align-self:center; }
.workspace[data-entrance="combined"] .composer-feedback { grid-area:feedback; margin:0; height:44px; font-size:.72rem; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason { font-size:inherit; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason[data-shortcut] { position:static; visibility:visible; width:auto; }
.composer-notice { grid-area:notice; height:8.7em; overflow:auto; margin:0; color:var(--aithema-muted); font-size:.75rem; line-height:1.45; }
.composer-mic { grid-area:mic; align-self:center; display:grid; place-items:center; width:44px; height:44px; padding:0; border:1px solid var(--aithema-line); border-radius:50%; color:var(--aithema-accent); background:var(--aithema-surface); }
.composer-mic svg { width:20px; height:20px; }
.composer-mic[aria-pressed="true"] { background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-surface)); }
.composer-status { grid-area:status; align-self:center; min-width:0; height:2.6em; overflow:auto; color:var(--aithema-muted); font-size:.72rem; line-height:1.3; }
@media(min-width:60rem) {
  /* Reserve the conversation width before the overview reveals. */
  .workspace[data-entrance="combined"][data-understanding="absent"] { grid-template-columns:minmax(0,1.55fr) minmax(22rem,.88fr); column-gap:clamp(1rem,2.5vw,2rem); }
}
@media(max-width:600px) {
  .workspace[data-entrance="combined"] { height:auto; padding-bottom:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-entrance="combined"] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 32px); min-height:0; }
  .workspace[data-entrance="combined"] [data-host-opener] { --turn-max-width:100%; padding-block:6px; }
  .workspace[data-entrance="combined"] [data-host-opener] > strong { margin-bottom:0; }
  /* Short phones share one reserved feedback/status row. Each has its own
     column; the complete notice and long status remain internally scrollable. */
  .workspace[data-entrance="combined"][data-phone-short] .composer-notice { height:5em; }
  .workspace[data-entrance="combined"][data-phone-short] .composer { grid-template-columns:minmax(0,1fr) 44px 44px;
    grid-template-areas:"notice notice notice" "message mic send" "feedback status status"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer:has(.staged-images:not([hidden])) {
    grid-template-areas:"images images images" "notice notice notice" "message mic send" "feedback status status"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer[data-image-input] .composer-feedback { grid-area:auto; }
  .workspace[data-entrance="combined"][data-phone-short] .composer-status { height:44px; }
  .workspace[data-entrance="combined"][data-phone-short] .concept-bar[data-no-drafts] { display:none; }
  .workspace[data-entrance="combined"][data-phone-short] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 26px); }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-shell { padding-bottom:2px; }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-shell > .voice-notices { margin-top:0; }
  .workspace[data-entrance="combined"][data-phone-short] .turn.user { padding-block:0; min-height:44px; }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-latest { position:absolute; right:0; bottom:0; margin:0; }
  .workspace[data-entrance="combined"][data-phone-short] textarea { height:44px; min-height:44px; }
  .workspace[data-entrance="combined"][data-phone-short] .composer-reason { position:static; width:auto; height:auto; clip-path:none; }
  .workspace[data-entrance="combined"] .composer-dock { position:fixed; z-index:9; left:var(--aithema-gutter); right:var(--aithema-gutter); bottom:calc(var(--phone-bottom,0px) + var(--phone-footer,57px) + 12px); }
  .workspace[data-entrance="combined"] .phone-dock-backdrop { display:block; position:fixed; z-index:8; left:0; right:0; bottom:var(--phone-bottom,0px); height:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); background:var(--aithema-paper); mask-image:linear-gradient(to bottom,transparent,#000 12px); }
}
`;
