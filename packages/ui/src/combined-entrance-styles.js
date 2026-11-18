// The opt-in entrance and live call share a top-anchored control frame.
// Its intrinsic notice follows the controls; disclosures cannot resize the frame.
// ComposerSize owns field growth; intrinsic slots and footer clearance stay here.
export const combinedEntranceStyles = `
/* The fixed footer is outside grid flow. Reserve its full 44px row, padding
   and border inside the host height so the notice can grow above it. */
.workspace[data-entrance="combined"] { height:var(--aithema-height); min-height:40rem; grid-template-rows:auto minmax(0,1fr) auto; padding-bottom:calc(57px + env(safe-area-inset-bottom,0px) + 1rem); }
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
   inset and the card-owned outside margin from the pane height. Neither
   reservation is additional transcript padding. */
.workspace[data-entrance="combined"] .transcript-shell { display:block; height:calc(100% - var(--transcript-top-inset,0px) - var(--question-card-height,0px)); min-height:0; }
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
  grid-template-areas:"message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; gap:8px; }
/* Staging grows above the controls without changing the disclosure flow. */
.workspace[data-entrance="combined"] .composer:has(.staged-images:not([hidden])) {
  grid-template-areas:"images images images" "message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; }
.workspace[data-entrance="combined"] .staged-images { grid-area:images; }
.workspace[data-entrance="combined"] textarea { grid-area:message; height:var(--composer-field-height,4.5rem); min-height:4.5rem; padding:.25rem 0; }
.workspace[data-entrance="combined"] .composer-actions { display:contents; }
.workspace[data-entrance="combined"] .attach { display:none; }
.workspace[data-entrance="combined"] .send { grid-area:send; align-self:end; }
.workspace[data-entrance="combined"] .composer-feedback { grid-area:feedback; margin:0; font-size:.72rem; }
/* Reserve wrapped document refusals only where document intake is configured. */
.workspace[data-entrance="combined"] .composer[data-document-input] .composer-feedback { min-height:2.6em; }
/* Image refusals reserve the longest real localized reason before intake. */
.workspace[data-entrance="combined"] .composer[data-image-input] .composer-feedback { min-height:44px; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason { font-size:inherit; }
.workspace[data-entrance="combined"] .composer-feedback .composer-reason[data-shortcut] { position:static; visibility:visible; width:auto; }
.composer-notice-slot { grid-area:notice; position:relative; min-width:0; }
.composer-notice-reserve { display:grid; visibility:hidden; pointer-events:none; font-size:.75rem; line-height:1.45; }
.composer-notice-reserve > * { grid-area:1/1; }
.composer-notice { position:absolute; top:0; left:0; right:0; height:auto; max-height:8.7em; margin:0; color:var(--aithema-muted); font-size:.75rem; line-height:1.45; }
.composer-mic { grid-area:mic; align-self:end; display:grid; place-items:center; width:44px; height:44px; padding:0; border:1px solid var(--aithema-line); border-radius:50%; color:var(--aithema-accent); background:var(--aithema-surface); }
.composer-mic svg { width:20px; height:20px; }
.composer-mic[aria-pressed="true"] { background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-surface)); }
.composer-status { align-self:stretch; min-width:0; color:var(--aithema-muted); font-size:.72rem; line-height:1.3; }
.composer-status-slot, .composer-status-reserve, .composer-feedback-reserve { display:grid; min-width:0; }
.composer-status-slot { grid-area:status; }
.composer-status-slot > *, .composer-status-reserve > *, .composer-feedback-reserve > * { grid-area:1/1; }
.composer-status-reserve, .composer-feedback-reserve { visibility:hidden; pointer-events:none; }
.composer-status-reserve { font-size:.72rem; line-height:1.3; }
.composer-feedback-reserve { align-items:center; }
.composer-reserve-line { font-size:inherit; line-height:1.3; overflow-wrap:anywhere; }
.composer-reserve-line kbd { font:inherit; padding:0 .2em; border:1px solid var(--aithema-line-strong); border-radius:3px; }
.composer-reserve-line .question-status { height:auto; white-space:nowrap; }
.composer-reserve-line .question-status svg { width:14px; height:14px; }
.composer-reserve-action { white-space:nowrap; }
.composer-reserve-phone { display:none; }
.composer-notice__phone { display:none; }
.composer-notice__more { display:inline; min-height:44px; padding:0 4px; text-decoration:underline; color:var(--aithema-accent); }
.composer-notice-dialog { width:min(36rem,calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; color:var(--aithema-ink); background:var(--aithema-surface); border:1px solid var(--aithema-line); border-radius:16px; }
.composer-notice-dialog h2 { margin:0 44px 16px 0; font-size:1rem; }
.composer-notice-dialog p { font-size:.875rem; line-height:1.5; }
.composer-notice-dialog button { position:absolute; top:8px; right:8px; width:44px; height:44px; }
.composer-notice-dialog svg { width:20px; height:20px; }
@media(min-width:60rem) {
  /* Reserve the conversation width before the overview reveals. */
  .workspace[data-entrance="combined"][data-understanding="absent"] { grid-template-columns:minmax(0,1.55fr) minmax(22rem,.88fr); column-gap:clamp(1rem,2.5vw,2rem); }
}
@media(min-width:960px) and (max-height:700px) {
  /* The same footer owner keeps its full 57px row plus a 4px gutter. Yield
     spare outer grid gaps before the 128px reply and 150px card floors.
     Notice, feedback and status still own their full intrinsic text rows. */
  .workspace[data-entrance="combined"] { row-gap:0; padding-bottom:calc(57px + env(safe-area-inset-bottom,0px) + 4px); }
  /* Keep the combined grid's row gaps compact, independent of card arrival.
     ComposerSize alone measures and caps growth. */
  .workspace[data-entrance="combined"] .composer { row-gap:0; }
  .workspace[data-entrance="combined"] textarea { min-height:44px; height:var(--composer-field-height,44px); }
}
@media(max-width:600px) {
  .workspace[data-entrance="combined"] { height:auto; padding-bottom:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-entrance="combined"] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 32px); min-height:0; }
  .workspace[data-entrance="combined"] [data-host-opener] { --turn-max-width:100%; padding-block:6px; }
  .workspace[data-entrance="combined"] [data-host-opener] > strong { margin-bottom:0; }
  /* A new offer can use the full conversation reading area. The rail above
     it stays in the same scroller and can scroll away; the input stays pinned. */
  .workspace[data-entrance="combined"] .conversation-scroll:has(.email-offer) .concept-thread { flex:0 0 100%; }
  .composer-notice { position:static; max-height:none; }
  .composer-notice-reserve { display:none; }
  .composer-notice__wide, .composer-reserve-wide { display:none; }
  .composer-reserve-phone { display:block; }
  .composer-notice__phone { display:inline; }
  .workspace[data-entrance="combined"][data-phone-short] .composer { grid-template-columns:minmax(0,1fr) 44px 44px;
    grid-template-areas:"message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer:has(.staged-images:not([hidden])) {
    grid-template-areas:"images images images" "message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer[data-image-input] .composer-feedback { grid-area:auto; }
  .workspace[data-entrance="combined"][data-phone-short] .concept-bar[data-no-drafts] { display:none; }
  .workspace[data-entrance="combined"][data-phone-short] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 26px); }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-shell { padding-bottom:8px; }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-shell > .voice-notices { margin-top:0; }
  .workspace[data-entrance="combined"][data-phone-short] .turn.user { padding-block:0; min-height:44px; }
  .workspace[data-entrance="combined"][data-phone-short] .transcript-latest { position:absolute; right:0; bottom:0; margin:0; }
  .workspace[data-entrance="combined"][data-phone-short] textarea { height:var(--composer-field-height,44px); min-height:44px; }
  .workspace[data-entrance="combined"][data-phone-short] .composer-reason { position:static; width:auto; height:auto; clip-path:none; }
  .workspace[data-entrance="combined"] .composer-dock { position:fixed; z-index:9; left:var(--aithema-gutter); right:var(--aithema-gutter); bottom:calc(var(--phone-bottom,0px) + var(--phone-footer,57px) + 12px); }
  .workspace[data-entrance="combined"] .phone-dock-backdrop { display:block; position:fixed; z-index:8; left:0; right:0; bottom:var(--phone-bottom,0px); height:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); background:var(--aithema-paper); mask-image:linear-gradient(to bottom,transparent,#000 12px); }
}
`;
