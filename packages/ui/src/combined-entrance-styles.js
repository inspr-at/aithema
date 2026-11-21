// The opt-in entrance and live call share a top-anchored control frame.
// Its intrinsic notice follows the controls; disclosures cannot resize the frame.
// ComposerSize owns field growth; intrinsic slots and footer clearance stay here.
import { reasonSeparator } from './consent-line.js';
export const combinedEntranceStyles = `
/* The fixed footer is outside grid flow. Reserve its full 44px row, padding
   and border inside the host height so the notice can grow above it. */
.workspace[data-entrance="combined"] { height:var(--aithema-height); min-height:40rem; grid-template-rows:auto minmax(0,1fr) auto; padding-bottom:calc(57px + env(safe-area-inset-bottom,0px) + 1rem); }
.workspace[data-entrance="combined"] .conversation { display:flex; flex-direction:column; min-height:0; gap:8px; }
/* The whole entrance/transcript surface scrolls above the reserved input row. */
.workspace[data-entrance="combined"] .conversation-scroll { display:flex; flex-direction:column; flex:1 1 0; min-height:0; overflow:auto; scrollbar-gutter:stable; gap:.85rem; }
.workspace[data-entrance="combined"] .intro { flex:none; width:100%; min-height:0; grid-template-columns:minmax(0,1fr); padding:.5rem 0; gap:.5rem; }
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
/* AIT-601: the image concept layout makes the thread a size container, whose
   content cannot size it. Before live, contain only the inline axis so the
   welcome owns its height above readiness; cqw stays thread-relative for the
   backdrop. Live keeps the size container. Phones already use normal. */
@media(min-width:601px) {
  .workspace[data-entrance="combined"][data-concept-layout="image"]:not([data-stage="live"]) .concept-thread:has([data-host-opener]) { container-type:inline-size; }
}
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
/* The render-only opener has no playback row. Intrinsic content scrolls above
   the pinned dock when persistence later adds canonical reply controls. */
/* Keep the idle mic cell reserved; the composer owns the entrance microphone. */
.workspace[data-entrance="combined"] .audio-rail[data-call="none"] .voice-start { visibility:hidden; }
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
.workspace[data-entrance="combined"] .composer[data-document-input] .composer-feedback { min-height:3.75em; }
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
/* r2 (Codex Low): one boundary; phones are ≤ 600 px and keep the route line. */
@media(width > 600px) {
  .workspace[data-entrance="combined"] .ready__route { display:none; }
}
/* AIT-553: short desktops (1366x768, 1280x720 under a host header) show
   readiness as one compact line, whole at first paint above the pinned
   composer: title, consent state and Change settings, joined by reasonSeparator. Model and visuals stay
   under Change settings; the full card returns at 861 px and taller.
   AIT-603: phones (≤ 600 px) always use this one-row form, never the card;
   there the processing route stays readable (RC26) as its own line below. */
@media(min-width:600px) and (max-height:860px), (max-width:600px) {
  .workspace[data-entrance="combined"] .ready { display:flex; flex-wrap:wrap; align-items:center; gap:0; padding:.125rem 1rem; }
  .workspace[data-entrance="combined"] .ready h3 { font-size:.85rem; }
  .workspace[data-entrance="combined"] .ready dl { display:contents; }
  .workspace[data-entrance="combined"] .ready__row:not([data-ready="consent"]) { display:none; }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] { display:flex; min-height:44px; gap:0; }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] dt { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] dd { display:flex; justify-content:flex-start; text-align:left; gap:.25rem; }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] dd > .ready__check { margin-inline-end:0; }
  /* A wrapped value keeps the check on its first line (AIT-587): both start at the top, and the shorter of
     check and first line is offset by half the difference, which is exactly where centring put it on one line. */
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] dd { align-items:flex-start; }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"] dd > .ready__check { margin-block-start:max(0px, (1lh - 1.1rem) / 2); }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"][data-state="confirmed"] dd > span:last-child { margin-block-start:max(0px, (1.1rem - 1lh) / 2); }
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"]::before,
  .workspace[data-entrance="combined"] .ready__actions::before { content:'${reasonSeparator}' / ''; white-space:pre; margin-inline:.25rem; color:var(--aithema-muted); }
  /* An unconfirmed state hides its check icon, so it keeps no empty slot. */
  .workspace[data-entrance="combined"] .ready__row[data-ready="consent"]:not([data-state="confirmed"]) .ready__check { display:none; }
  .workspace[data-entrance="combined"] .ready__actions { display:flex; flex-wrap:nowrap; align-items:center; justify-content:flex-start; gap:0; }
  /* TICK M1: an item that starts a wrapped line (session-element marks it) keeps
     its separator's space, so the wrap cannot change, but paints no separator
     and moves back by its width to start flush with the line. Intended for
     both scopes of this one-row form: phones and short desktops (where it
     rarely wraps; a wrap there gets the same flush start). */
  .workspace[data-entrance="combined"] .ready :is(.ready__row[data-ready="consent"], .ready__actions)[data-line-start] { position:relative; inset-inline-start:calc(-1 * var(--ready-separator,0px)); }
  .workspace[data-entrance="combined"] .ready :is(.ready__row[data-ready="consent"], .ready__actions)[data-line-start]::before { visibility:hidden; }
  /* Before the conversation the render-only welcome cannot scroll, so its
     hidden Latest control keeps no 54px end slot (as on short phones). */
  .workspace[data-entrance="combined"]:not([data-stage="live"]) .transcript-shell:has([data-host-opener]) > .transcript-latest { position:absolute; right:0; bottom:0; margin:0; }
}
@media(width < 600px) {
  .composer-notice { position:static; max-height:none; }
  .composer-notice-reserve { display:none; }
  .composer-notice__wide, .composer-reserve-wide { display:none; }
  .composer-reserve-phone { display:block; }
  .composer-notice__phone { display:inline; }
}
@media(340px < width <= 600px) {
  /* AIT-603: above 340 px phones show the wide text-consent line (styles.js);
     reserve it too, so a two-line wrap (DE) cannot make the dock shrink at the
     hand-off and move the controls. Both lines take the combined feedback row's
     size (.composer-feedback .composer-reason inherits it), so the reserve is
     the visible line's exact box. PR-A: flex, as the visible line (the CSS cap below). */
  .composer-reserve-line.composer-reserve-wide.composer-reserve-consent { display:flex; }
  .composer-reserve-line.composer-reserve-phone.composer-reserve-consent { display:none; }
}
@media(width <= 340px) {
  /* Codex M4: at 340 px and below the visible narrow line is set tighter
     (styles.js, letter-spacing -.03em; its action button keeps normal
     spacing); the narrow reserve matches it. */
  .composer-reserve-line.composer-reserve-phone.composer-reserve-consent { display:flex; letter-spacing:-.03em; }
  .composer-reserve-line.composer-reserve-phone.composer-reserve-consent .composer-reserve-action { letter-spacing:normal; }
}
@media(max-width:600px) {
  /* AIT-603 PR-A (TICK's cap, pure CSS: no measuring, no search, no cache).
     On phones the text-consent line and its reserve share one cap of two whole
     lines, so the dock never changes height at consent. Desktop keeps the r3
     uncapped line and reserve.
     - The host sentence has its own clamp box (.consent-line-copy): line-clamp 2
       paints the "…". The line is a flex row only so that box's height is
       definite for the spacer below.
     - The action is outside that box: it sits at the end of the box's last
       line (inset-inline-end, bottom), so the text clamps and the action never does.
     - The room it covers is the box's own: a zero-width float spacer of the
       box's height less one line, then a hidden float of the action's words
       (data-action, plus a small gap) that clears it, so it lands on the last
       line and the sentence (and its "…") wraps around it. A shorter sentence
       ends on line 1 with the action at its end. The layout follows any copy,
       locale or font change by itself. */
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] { display:flex; position:relative; }
  /* Codex gate2c M4 / r2 Codex CLAMP: the phone reserve drops the base
     .composer-reason cap for the shared two-row box; desktop keeps main's. */
  .composer-reserve-line.composer-reserve-consent { position:relative; max-height:none; overflow:visible; }
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy,
  .composer-reserve-line.composer-reserve-consent > .consent-line-copy {
    flex:1 1 auto; min-width:0; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; height:2lh; }
  /* r2, TICK decision (a): the box is ALWAYS two rows (height 2lh), so the
     spacer below is always one line and the action's room, and the action,
     always end row 2 at one spot, for short text too; the reserve is the
     same box, so the dock never depends on the text's length. No "·" ends
     row 1: on phones the separator (its own span) is not painted. */
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy .consent-separator,
  .composer-reserve-line.composer-reserve-consent > .consent-line-copy .consent-separator { display:none; }
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy::before,
  .composer-reserve-line.composer-reserve-consent > .consent-line-copy::before { content:''; float:inline-end; width:0; height:calc(100% - 1lh); }
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy > [data-action]::before,
  .composer-reserve-line.composer-reserve-consent > .consent-line-copy > [data-action]::before {
    content:attr(data-action); float:inline-end; clear:both; visibility:hidden; white-space:nowrap; letter-spacing:normal; padding-inline-start:.35em;
    /* r5: an over-wide action's spacer is capped at the row like the action. */
    max-width:100%; box-sizing:border-box; overflow:hidden; }
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action,
  .composer-reserve-line.composer-reserve-consent > .composer-reserve-action { position:absolute; inset-inline-end:0; bottom:0; }
  /* Its 44 px target grows from the line end back over the text, never past
     the text column toward Mic and Send (a short action, e.g. "OK"). */
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action::after { left:auto; right:auto; inset-inline-end:0; }
  /* r5 (Codex gatepra4, TICK M1 safety net): a host action label wider than
     the row is capped at the row and ends in "…" on its one line (never
     offscreen, never wrapping the dock taller). Only its visible variant span
     clips, so the button's 44 px target (::after) is not clipped; the
     accessible name stays the full label (the visible text is its prefix). */
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action { display:flex; max-width:100%; min-width:0; }
  .workspace[data-entrance="combined"] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action > * { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* A shorter line (granted, the send shortcut) sits top-aligned in that reserve. */
  .workspace[data-entrance="combined"] .composer:not([data-image-input]) .composer-feedback > .composer-reason:not([data-send-failed]) { align-self:start; }
  /* r5 (Codex gate4c Low): image-enabled docks too, for the consent line and the
     granted line that replaces it; image refusals keep their centred row. */
  .workspace[data-entrance="combined"] .composer[data-image-input] .composer-feedback > .composer-reason:is([data-consent-feature="text"],[data-shortcut]) { align-self:start; }
  /* r3, TICK k1: with the phone keyboard up typing is the task and the field's
     room comes first. Pending: ONE row, the stock short reason (textNarrow) at
     the start and its action (actionNarrow) at the inline end, never the action
     alone; the host text is hidden (the action's description, a separate hidden
     node, is unchanged). Granted or not needed: the row takes 0 px. Nothing is
     reserved while the keyboard is up, so the row changes only when the keyboard
     opens or closes. Keyboard down keeps r2's two rows (TICK (a)). */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > :is(.composer-feedback-reserve, .composer-saved-sizer) { display:none; }
  /* r4, TICK M1: the keyboard never changes the action's label or name; the
     action keeps the width rule's variant (the wide label above 340 px, as with
     the keyboard down). Only the reason is the short one. Safety net for a long
     host action: the reason yields first (one line, min-width 0, "…"; r5: down
     to 0), the action shrinks only past the row (its "…", rule above); the row is a plain flex row, no float spacer. */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy {
    display:block; -webkit-line-clamp:none; height:1lh; flex:1 1 0; min-width:0; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy::before,
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy > [data-action]::before { content:none; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy > .consent-wide { display:none; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-line-copy > .consent-narrow { display:inline; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action {
    position:relative; inset:auto; flex:0 1 auto; height:1lh; white-space:nowrap; margin-inline-start:.35em; }
  /* One row sits 8 px (the composer's row gap) under Send: its 44 px target
     starts at that gap and grows down over the status row, clear of Send and Mic. */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer-feedback > .composer-reason[data-consent-feature="text"] > .consent-action::after { top:-8px; transform:none; }
  /* r4 (Codex KEYBOARD): pending is one row on document- and image-enabled
     docks too: their refusal floors (3.75em, 44 px) yield to the consent line. */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer .composer-feedback:has(> .composer-reason[data-consent-feature="text"]) { min-height:0; }
  /* Granted and IDLE only (r4, Codex A11Y): the feedback row leaves the grid
     when it shows NOTHING but the keyboard-shortcut hint (or nothing): no
     visible status text (r5, Codex gatepra4 A11Y: the Saved confirmation after
     a send, [data-saved], keeps the row), no retry, discard, upload notice,
     refusal, failure or any other control. Its status regions stay in the
     accessibility tree at no size. Plain, document- and image-enabled docks
     alike (r4, Codex KEYBOARD). r5 (Codex gatepra4 Low): a READY staged image
     keeps its own row above the field and leaves no blank row below it. */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer:has(.composer-feedback > .composer-reason:is([data-shortcut],:empty)):not(:has(.composer-feedback[data-saved])):not(:has(.composer-feedback :is(button, a, input, [tabindex]))) {
    grid-template-areas:"message mic send" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer:has(.staged-images:not([hidden])):has(.composer-feedback > .composer-reason:is([data-shortcut],:empty)):not(:has(.composer-feedback[data-saved])):not(:has(.composer-feedback :is(button, a, input, [tabindex]))) {
    grid-template-areas:"images images images" "message mic send" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer:has(.composer-feedback > .composer-reason:is([data-shortcut],:empty)):not(:has(.composer-feedback[data-saved])):not(:has(.composer-feedback :is(button, a, input, [tabindex]))) .composer-feedback {
    grid-area:auto; position:absolute; width:1px; height:0; min-height:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .workspace[data-entrance="combined"] { height:auto; padding-bottom:calc(var(--phone-dock,250px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-entrance="combined"] .conversation { height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,250px) - 32px); min-height:0; }
  .workspace[data-entrance="combined"] [data-host-opener] { --turn-max-width:100%; padding-block:6px; }
  .workspace[data-entrance="combined"] [data-host-opener] > strong { margin-bottom:0; }
  /* AIT-603: session-element fits whole welcome lines (2..6) to the ready stage. */
  .workspace[data-entrance="combined"] .turn[data-host-opener] .turn-text { -webkit-line-clamp:var(--opener-lines,6); }
  /* The phone notice is abbreviated, so the processing route keeps its own line under the one-row readiness (RC26). */
  .workspace[data-entrance="combined"] .ready__route { flex:1 0 100%; }
  /* r2 (Codex READY-STAGE Medium): the one-row readiness fits the width left
     by a classic 15 px scrollbar gutter too (stable gutter): a tighter inline
     padding keeps title · consent state on one row at 320 DE and 390 DE 125 %. */
  .workspace[data-entrance="combined"] .ready { padding-inline:.5rem; }
  /* No render can run before the first reply (AIT-601 r5: the idle reserve is no
     content end), so the ready stage keeps no 40 px render-label reserve under
     the welcome. The welcome's top is unchanged; live restores the reserve. */
  .workspace[data-entrance="combined"][data-concept-layout="image"]:not([data-stage="live"]) .concept-thread .transcript-shell { --aithema-render-reserve:0px; }
  /* Readiness is the last ready-stage content; no trailing padding below it. */
  .workspace[data-entrance="combined"]:not([data-stage="live"]) .intro { padding-bottom:0; }
  /* Only when even two lines and readiness do not fit: a soft bottom fade while
     content is below; session-element shortens it (12..24 px) to keep Read full reply clear. */
  .workspace[data-entrance="combined"][data-stage="ready"] .conversation-scroll[data-bottom] { mask-image:linear-gradient(to bottom,#000 calc(100% - var(--opener-fade,24px)),transparent); }
  /* A new offer can use the full conversation reading area. The rail above
     it stays in the same scroller and can scroll away; the input stays pinned. */
  .workspace[data-entrance="combined"] .conversation-scroll:has(.email-offer) .concept-thread { flex:0 0 100%; }
  .workspace[data-entrance="combined"][data-phone-short] .composer { grid-template-columns:minmax(0,1fr) 44px 44px;
    grid-template-areas:"message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer:has(.staged-images:not([hidden])) {
    grid-template-areas:"images images images" "message mic send" "feedback feedback feedback" "status status status" "notice notice notice"; }
  .workspace[data-entrance="combined"][data-phone-short] .composer[data-image-input] .composer-feedback { grid-area:auto; }
  /* r4 (Codex KEYBOARD): with the keyboard up an image-enabled dock keeps no
     image slot above the field: its feedback is the ordinary feedback row
     under the field (one row while consent is pending, 0 px when idle; the
     idle collapse above wins), and the composer keeps the plain short-phone
     padding (question-card.js) instead of the slot's reserve. A staged image
     keeps its own row. */
  .workspace[data-entrance="combined"][data-phone-short][data-phone-keyboard] .composer[data-image-input] { padding-top:6px; }
  .workspace[data-entrance="combined"][data-phone-short][data-phone-keyboard] .composer[data-image-input] .composer-feedback {
    grid-area:feedback; position:relative; top:auto; left:auto; right:auto; height:auto; }
  .workspace[data-entrance="combined"][data-phone-short][data-phone-keyboard] .composer[data-image-input] .composer-feedback > .composer-reason[data-consent-feature="text"] { overflow:visible; }
  /* k1: nothing is reserved while the keyboard is up, the image refusal reserve included
     (image-input.js keeps its last measured height while it is hidden). */
  .workspace[data-entrance="combined"][data-phone-keyboard] .composer[data-image-input] .image-feedback-reserve { display:none; }
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
