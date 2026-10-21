// Host surface (AIT-104 B2) on the component's tokens, GUI-27: hairlines, weight and whitespace,
// quiet accent text actions and at most one filled primary per area. Every changing value sits in
// a reserved slot (stacked states share one grid cell), so nothing moves under the pointer.
export const hostStyles = `
/* One header row. The menu overlays the page, so opening it moves nothing. */
.host-bar { display:flex; align-items:center; min-width:0; }
.conversations-wrap { position:relative; }
.conversations-toggle { display:inline-flex; align-items:center; gap:7px; min-height:44px; width:168px; padding:0 var(--aithema-menu-padding,10px); font-size:var(--aithema-menu-size,14px); color:var(--aithema-ink); }
.conversations-toggle svg { width:17px; height:17px; } .conversations-toggle svg:last-child { width:10px; height:10px; }
.conversations-menu { position:absolute; z-index:8; right:0; top:calc(100% + 6px); width:min(300px,calc(100vw - 32px)); padding:6px; border-radius:14px;
  background:var(--aithema-surface); box-shadow:0 0 0 1px var(--aithema-line),var(--aithema-shadow-raised); font-size:14px; }
.conversations-menu button { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:6px 10px; text-align:left; border-radius:9px; }
.conversations-new { color:var(--aithema-accent); font-weight:600; } .conversations-new svg { width:16px; height:16px; }
.conversations-recent { display:grid; margin:4px 0; padding:4px 0; border-block:1px solid var(--aithema-line); }
.conversations-recent:empty { display:none; }
.conversations-recent-item[data-current] { background:var(--aithema-accent-soft); }
.conversations-recent-item span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversations-recent-item small { margin-left:auto; flex:none; font-size:12px; color:var(--aithema-muted); }
.host-verify { min-width:0; grid-column:1/-1; border-top:1px solid var(--aithema-line); padding-top:1.2rem; }
.verify-entry-state { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .7rem; font-size:.85rem; color:var(--aithema-muted); }
.verify-entry-address { overflow-wrap:anywhere; }
.verify-entry-address:empty { display:none; }
.verify-entry { min-height:44px; padding:.4rem .85rem; font-size:.8rem; font-weight:400; color:var(--aithema-accent); text-align:left; }
.verify-done { display:inline-flex; align-items:center; gap:.35rem; font-size:.8rem; color:var(--aithema-muted); }
.verify-done svg, .verify__done svg { flex:none; color:var(--aithema-accent); }
.host-account { display:flex; align-items:center; font-size:.8125rem; }
/* START preset flags; footer layout and viewport-clamped pop-ups are in band-styles. */
.engine__flag { display:flex; align-items:center; }
.settings-flag { display:inline-flex; align-items:center; gap:2px; }
.settings-flag > svg { width:18px; height:12px; flex:none; border-radius:2px; }
.settings-flag .settings-flag__machine { width:14px; height:14px; }

@media(max-width:44rem) {
  .conversations-toggle { gap:4px; font-size:var(--aithema-menu-size,12px); padding:0 var(--aithema-menu-padding,4px); }
  .conversations-toggle span { white-space:nowrap; }
}
[aria-disabled="true"]:is(.verify-send, .verify-resend, .handover-request, .library-open, .library-new, .library-reset, .library-rename,
  .library-delete, .library-confirm) { opacity:.5; cursor:not-allowed; }
:is(.verify-send, .library-new) { color:var(--aithema-on-accent); background:var(--aithema-accent); font-weight:600; min-height:2.75rem; }
:is(.verify-send, .library-new):hover:not([aria-disabled="true"]) { background:color-mix(in srgb,var(--aithema-accent) 84%,var(--aithema-ink)); }
:is(.verify-resend, .verify-change, .verify-cancel, .verify-dialog-close, .handover-request, .library-close, .library-reset, .library-rename,
  .library-save, .library-cancel, .library-retry, .library-more, .library-confirm-cancel) { color:var(--aithema-accent); font-weight:600; }

/* The verification lock replaces the assessment in place. */
.verify-lock { display:grid; gap:.55rem; padding:.25rem 0 1rem; }
.verify-lock__icon { color:var(--aithema-accent); line-height:0; } .verify-lock__icon svg { display:block; }
.verify-lock__title { font:600 1.05rem/1.3 var(--aithema-display); margin:0; } .analysis-content .verify-lock__lead { font-size:.87rem; margin:0; }
.verify-form { display:grid; gap:.45rem; min-width:0; }
.verify__field { display:grid; min-width:0; } .verify__field > * { grid-area:1/1; align-self:end; min-width:0; }
.verify__capture { display:grid; gap:.25rem; } .verify__label { font-size:.75rem; color:var(--aithema-muted); }
.verify__input, .library input { width:100%; min-height:2.75rem; padding:.4rem .65rem; border:1px solid var(--aithema-line); border-radius:.45rem;
  color:inherit; background:var(--aithema-paper); font:inherit; }
:is(.verify__input, .library input)::placeholder { color:var(--aithema-muted); opacity:1; }
.analysis-content .verify__pending, .verify__pending { margin:0; min-height:2.75rem; display:block;
  font-size:.85rem; overflow-wrap:anywhere; }
.verify__address { font-weight:650; } .verify-change { min-height:44px; padding:0; font-size:.8rem; }
.verify__recipient { display:inline-block; max-width:100%; }
.analysis-content .verify__done, .verify__done { display:flex; align-items:center; gap:.4rem; margin:0; min-height:2.75rem; font-size:.87rem; }
.verify__actions { display:flex; flex-wrap:wrap; align-items:center; gap:.25rem .5rem; }
/* Keep the sending action's reservation while each label hugs its own button. */
.verify__primary { display:grid; } .verify__primary > * { grid-area:1/1; justify-self:stretch; min-height:2.75rem; }
.verify-primary-measure { visibility:hidden; padding:.5rem .85rem; font-weight:600; }
/* Labels keep one line; Cancel moves below the button when the pair does not fit. */
.verify-dialog .verify__actions { gap:24px; }
.verify-dialog .verify__primary, .verify-dialog .verify-cancel { flex:none; white-space:nowrap; }
.verify-dialog .verify__primary > * { justify-self:start; }
/* Pending has no Cancel action; its hidden reservation must not add a row above the message. */
.verify-dialog .verify-form[data-mode=pending] .verify-cancel { display:none; }
.verify-resend { text-align:left; } .verify-cancel { font-size:.85rem; }
.verify-dialog .verify-form[data-mode=pending] { row-gap:12px; grid-template-areas:"lead" "field" "actions" "message" "note" "privacy"; }
.verify-dialog .verify-form[data-mode=pending] > .verify__lead { grid-area:lead; }
.verify-dialog .verify-form[data-mode=pending] > .verify__field { grid-area:field; }
.verify-dialog .verify-form[data-mode=pending] > .verify__actions { grid-area:actions; }
.verify-dialog .verify-form[data-mode=pending] > .verify__message { grid-area:message; }
.verify-dialog .verify-form[data-mode=pending] > .verify__note { grid-area:note; }
.verify-dialog .verify-form[data-mode=pending] > .m-notice { grid-area:privacy; }
.analysis-content .verify__message, .verify__message { margin:0; min-height:2.6em; font-size:.8rem; line-height:1.3; }
.verify__message[data-error="true"] { color:var(--aithema-ink); }
.analysis-content .verify__note, .verify__note { margin:0; min-height:1.3em; font-size:.75rem; line-height:1.3; color:var(--aithema-muted); font-variant-numeric:tabular-nums; }

/* The handover band follows the assessment in its scrolling pane (START: contact below the assessment), so the
   readable assessment comes first and the band never squeezes it; the export line stays below the pane. */
.handover { display:grid; gap:.3rem; padding:.75rem 0; border-top:1px solid var(--aithema-line); }
.handover h3 { margin:0; font-size:.86rem; font-weight:700; } .handover__offer { margin:0; font-size:.78rem; line-height:1.35; color:var(--aithema-muted); max-height:2.7em; overflow-y:auto; overflow-wrap:anywhere; }
.handover__row { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:.5rem; min-height:0; }
.handover-request { display:inline-grid; margin-left:-.85rem; font-size:.8rem; line-height:1.2; text-align:left; }
.handover-request > * { grid-area:1/1; } .handover__sizer { visibility:hidden; }
/* Three reserved lines (a longer state scrolls in them): failed, retried and sent states never resize the row under the pointer. */
.handover__state { margin:0; font-size:.72rem; line-height:1.3; color:var(--aithema-muted); height:3.9em; overflow-y:auto; overflow-wrap:anywhere; }
@media(60rem <= width < 70rem) {
  .handover__row { grid-template-columns:minmax(0,1fr); gap:.25rem; }
  .handover__state { overflow-wrap:normal; }
}

/* Dialogs: the settings dialog's frame, smaller. */
:is(dialog.library, dialog.verify-dialog) { padding:0; margin:auto; border:1px solid var(--aithema-line); border-radius:var(--aithema-radius-lg); color:var(--aithema-ink);
  background:var(--aithema-surface); box-shadow:var(--aithema-shadow-raised); font:.875rem/1.4 var(--aithema-font); max-width:none; max-height:none; overflow:hidden; }
:is(dialog.library, dialog.verify-dialog)::backdrop { background:rgb(12 28 39 / .36); backdrop-filter:blur(6px); }
:is(dialog.library, dialog.verify-dialog) :is(button, input, a):focus-visible { outline:3px solid var(--aithema-accent); outline-offset:2px; }
:is(dialog.library, dialog.verify-dialog) h2 { font:400 1.45rem/1.2 var(--aithema-display); margin:0; letter-spacing:-.01em; }
dialog.verify-dialog { width:min(32rem, calc(100vw - 1rem)); }
.verify-dialog__frame { display:grid; gap:1rem; padding:1rem 1.25rem 1.25rem; }
.verify-dialog__head { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.verify-dialog-close { margin-right:-.85rem; font-size:.82rem; }
.verify-dialog__notice { margin:-.5rem 0 0; font-size:.75rem; line-height:1.35; color:var(--aithema-muted); }
dialog.library { width:min(54rem, calc(100vw - 1rem)); height:min(44rem, calc(100dvh - 1rem)); }
.library__frame { display:grid; grid-template-rows:auto minmax(0,1fr) auto; height:100%; min-height:0; }
.library__head { display:grid; gap:.45rem; padding:1rem 1.25rem .5rem; border-bottom:1px solid var(--aithema-line); }
.library__heading { display:flex; align-items:center; justify-content:space-between; gap:1rem; } .library-close { margin-right:-.85rem; font-size:.82rem; }
.library__lead, .library__notice, .library__message { margin:0; } .library__lead { font-size:.87rem; }
/* The message line reserves its own line height, so a message appearing never pushes the list. */
.library__notice, .library__message { font-size:.75rem; color:var(--aithema-muted); } .library__message { min-height:1.3em; line-height:1.3; }
.library__list { min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:0 1.25rem; }
.library table { width:100%; border-collapse:collapse; table-layout:fixed; }
.library thead th { position:sticky; top:0; z-index:1; padding:.25rem 0; text-align:left; font-size:.75rem; font-weight:600; color:var(--aithema-muted);
  background:var(--aithema-surface); border-bottom:1px solid var(--aithema-line); }
.library__col-when { width:11.5rem; } .library__col-actions { width:13rem; }
.library-sort { display:inline-flex; align-items:center; gap:.25rem; min-height:2.5rem; margin-left:-.5rem; padding:.3rem .5rem; color:inherit; font-weight:600; }
.library__arrow { display:inline-block; width:1em; text-align:center; color:var(--aithema-accent); }
.library tbody tr { border-bottom:1px solid var(--aithema-line); } .library td { padding:.3rem 0; vertical-align:middle; min-width:0; }
.library__title-slot { display:grid; min-width:0; } .library__title-slot > * { grid-area:1/1; min-width:0; }
.library-open { display:grid; justify-items:start; gap:.05rem; min-height:2.75rem; margin-left:-.5rem; padding:.35rem .5rem; text-align:left; overflow-wrap:anywhere; }
.library__name { font-weight:600; } .library-open:hover:not([aria-disabled="true"]) .library__name { color:color-mix(in srgb,var(--aithema-accent) 35%,var(--aithema-ink)); }
tr[data-untitled="true"] .library__name { font-weight:400; color:var(--aithema-muted); }
.library__current { font-size:.72rem; color:var(--aithema-accent); } .library__current:empty { display:none; }
.library__rename { display:flex; align-items:center; padding-right:.75rem; }
.library__when { font-size:.8rem; color:var(--aithema-muted); font-variant-numeric:tabular-nums; }
.library__action-slot { display:grid; justify-items:end; } .library__action-slot > * { grid-area:1/1; display:flex; gap:.1rem; }
.library__actions button { min-height:2.75rem; padding:.4rem .6rem; font-size:.8rem; }
.library-delete, .library-confirm { color:var(--aithema-error); font-weight:650; }
.library-delete:hover:not([aria-disabled="true"]), .library-confirm:hover:not([aria-disabled="true"]) { background:color-mix(in srgb,var(--aithema-error) 8%,transparent); }
.library__state { display:grid; justify-items:center; gap:.5rem; padding:2.5rem 0; text-align:center; color:var(--aithema-muted); } .library__state p { margin:0; }
.library__more { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.5rem 0; font-size:.78rem; color:var(--aithema-muted); }
.library__foot { display:grid; padding:.75rem 1.25rem; border-top:1px solid var(--aithema-line); } .library__foot > * { grid-area:1/1; min-width:0; }
.library__default { display:flex; flex-wrap:wrap; align-items:start; gap:.25rem .75rem; } .library-reset { font-size:.85rem; }
.library__confirm { display:grid; gap:.3rem; }
/* Two lines for the question (a long title scrolls in them), the longer warning's height for either: a confirmation never resizes the footer. */
.library__question { margin:0; height:2.8em; line-height:1.4; font-weight:650; overflow-y:auto; overflow-wrap:anywhere; }
.library__warning { display:grid; margin:0; font-size:.8rem; color:var(--aithema-muted); } .library__warning > * { grid-area:1/1; } .library__sizer { visibility:hidden; } .library__confirm-actions { display:flex; flex-wrap:wrap; gap:.25rem; margin-left:-.85rem; }
@media(max-width:40rem) {
  dialog.library { width:calc(100vw - .5rem); height:calc(100dvh - .5rem); border-radius:.8rem; }
  .library__head, .library__foot { padding-inline:.8rem; } .library__list { padding:0 .8rem; } .library__message { min-height:2.6em; }
  .library table, .library tbody, .library thead { display:block; } .library__col-actions { display:none; }
  .library thead tr { display:flex; gap:1rem; position:sticky; top:0; z-index:1; background:var(--aithema-surface); border-bottom:1px solid var(--aithema-line); }
  .library thead th { width:auto; position:static; border-bottom:0; }
  .library tbody tr { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"title title" "when actions"; align-items:center; }
  .library__title-cell { grid-area:title; } .library__when { grid-area:when; } .library__actions { grid-area:actions; }
  .library__actions button { padding-inline:.5rem; } }
@media(pointer:coarse) { .library-sort { min-height:2.75rem; } }

/* AIT-135 B: the existing composer surface reserves both states. */
.workspace:not([data-stage="live"]) :is(.composer-shell,.question-card) { display:none; }
.composer-shell { position:relative; display:grid; grid-template-areas:"composer"; min-width:0; }
.composer-shell > * { grid-area:composer; min-width:0; }
.composer-shell .composer { transition:opacity .3s; }
.composer-out { display:grid; grid-template-rows:auto auto 1fr; gap:2px; padding:clamp(.85rem,2vw,1.25rem);
  border:1px solid var(--aithema-line); border-radius:var(--aithema-radius-lg); background:color-mix(in srgb,var(--aithema-surface) 88%,transparent);
  box-shadow:var(--aithema-shadow-raised); backdrop-filter:blur(20px) saturate(1.2); visibility:hidden; opacity:0; transition:opacity .3s; }
.composer-out p { margin:0; }
.composer-shell[data-used-up] .composer { visibility:hidden; opacity:0; }
.composer-shell[data-used-up] .composer-out { visibility:visible; opacity:1; }
.composer-out__title { display:grid; font-size:clamp(12px,3vw,15.5px); line-height:calc(15.5px * 1.35); color:var(--aithema-ink); }
/* Measure the no-upgrade title before it replaces the shorter credit title. */
.composer-out__title::before { content:attr(data-host-title); visibility:hidden; grid-area:1/1; min-width:0; white-space:nowrap; overflow:hidden; }
.composer-out__title > span { grid-area:1/1; }
.composer-out__body { display:grid; grid-template-columns:minmax(0,1fr); min-width:0; font-size:13.5px; line-height:1.4; color:var(--aithema-muted); }
/* Tick spec v1 (AIT-406): every variant sizes the same cell, even while hidden. */
.composer-out__body > :is(span,[data-credit-option-variant]) { grid-area:1/1; min-width:0; align-self:start; }
.composer-out__body > [data-credit-option-variant] { font:inherit; }
.composer-out__body > [data-active="false"] { visibility:hidden; }
/* Match the question card's text inset, accounting for the composer border.
   Only copy moves; the measured surface and action cells retain their padding. */
.composer-out { --host-limit-text-inset:calc(16px - 1px - clamp(.85rem,2vw,1.25rem)); }
.composer-out[data-host-limit] .composer-out__title { margin-inline:var(--host-limit-text-inset); }
.composer-out__body > [data-host-body] { margin-inline:var(--host-limit-text-inset); }
.composer-out__bar { display:flex; align-items:center; align-self:end; gap:14px; padding-top:2px; font-size:13.5px; line-height:1.35; }
.composer-out__steps { flex:1; min-width:0; }
:is(.composer-out__steps,.composer-out__actions,.composer-out__upgrade) { display:grid; }
:is(.composer-out__steps,.composer-out__actions,.composer-out__upgrade) > * { grid-area:1/1; }
.composer-out__actions { flex:none; align-items:center; justify-items:end; }
.composer-out [data-next] { visibility:hidden; }
.composer-shell[data-used-up] .composer-out[data-next="give"] [data-next="give"],
.composer-shell[data-used-up] .composer-out[data-next="confirm"] [data-next="confirm"],
.composer-shell[data-used-up] .composer-out[data-next="none"] [data-next="none"] { visibility:visible; }
.composer-out[data-delivery="false"] [data-next="confirm"] { display:none; }
.composer-out[data-next="none"] .composer-out__upgrade { visibility:hidden; }
.composer-out__upgrade { align-items:center; justify-items:center; min-height:44px; padding:0 16px; border-radius:12px; color:var(--aithema-on-accent); background:var(--aithema-accent); font-size:14px; font-weight:600; }
.composer-out__export { visibility:hidden; display:inline-flex; flex:none; white-space:nowrap; align-items:center; gap:8px; min-height:44px; font-size:13.5px; color:var(--aithema-ink); text-decoration:underline; text-underline-offset:3px; }
.composer-shell[data-used-up] .composer-out__export[data-export] { visibility:visible; }
/* Host-limit reserves two independent action slots, even when only export is available. */
.composer-out[data-host-limit] .composer-out__steps { display:none; }
.composer-out[data-host-limit] .composer-out__actions { width:100%; grid-template-columns:minmax(0,1fr) auto; gap:14px; justify-items:start; }
.composer-out[data-host-limit] .composer-out__actions > * { grid-area:auto; }
.composer-out[data-host-limit] .composer-out__upgrade { padding:0; max-width:none; border-radius:0; background:none; color:var(--aithema-accent); font-size:13.5px; white-space:nowrap; text-decoration:underline; text-underline-offset:3px; text-align:start; }
.composer-out[data-host-limit] .composer-out__export { max-width:none; color:var(--aithema-muted); }
.composer-out__export svg { width:14px; height:14px; flex:none; color:var(--aithema-muted); }
[data-used-up]:is(.qcard,.question-card) button { color:var(--aithema-muted); background:none; }
[data-used-up]:is(.qcard,.question-card) :is(.go,.tag,.qhint) { visibility:hidden; }
.composer-out__actions { position:relative; }
.composer-out[data-reset-slot] { position:relative; }
.composer-out__deadline { position:absolute; inset-inline:calc(clamp(.85rem,2vw,1.25rem) + var(--host-limit-text-inset)); bottom:54px; font-size:12px; line-height:1.4; color:var(--aithema-muted); }
.composer-out__new { position:absolute; inset-inline-start:0; bottom:0; min-height:44px; white-space:nowrap; padding:0 8px; border-radius:12px; background:var(--aithema-accent); color:var(--aithema-on-accent); font-size:13px; font-weight:600; }
.composer-out[data-credit-actions="new"] .composer-out__actions { width:100%; }
.composer-out[data-credit-actions="new"] .composer-out__steps { visibility:hidden; }
.composer-out[data-credit-actions="none"] :is(.composer-out__actions,.composer-out__steps) { visibility:hidden; }
.host-credits__reconciling { visibility:hidden; white-space:nowrap; color:var(--aithema-muted); font-weight:400; }
.host-credits[data-reconciling] .host-credits__reconciling { visibility:visible; }
.host-credits[data-reconciling] :is(.host-credits__text,.host-credits__used-up) { visibility:hidden; }

.m-delete-reason { color:var(--aithema-muted); }
.m-mail-notice[data-delete-reservation] { display:grid; }
.m-mail-notice[data-delete-reservation] > span { grid-area:1/1; min-width:0; }
.m-mail-notice[data-delete-reservation] .m-notice-measure { display:block; visibility:hidden; }
.m-notice .m-pp:not([href]) { color:inherit; text-decoration:none; cursor:inherit; }
/* Footer labels share a cell. The track and the neighboring controls never move. */
.host-credits .host-credits__button { display:flex; align-items:center; gap:8px; min-height:44px; padding:0; font:inherit; }
.host-credits__measure-cap { visibility:hidden; white-space:nowrap; font-weight:600; }
.host-credits__stack { display:grid; justify-items:center; }
.host-credits__stack > * { grid-area:1/1; }
/* Keep both numeric slots and the unit at the reserved start. */
.host-credits__text { justify-self:start; }
.host-credits__amount { display:inline-grid; min-width:max-content; font-variant-numeric:tabular-nums; }
/* Match the exact locale-formatted envelope without padding separators to digits. */
.host-credits__measure-amount { display:inline-block; }
.host-credits__measure-amount::before { content:attr(data-credit-reserve); display:block; height:0; }
.host-credits__amount::before { content:attr(data-credit-reserve); visibility:hidden; grid-area:1/1; }
.host-credits__value { grid-area:1/1; text-align:end; }
/* The total keeps its leading separator and grows naturally above the envelope. */
.host-credits__total { white-space:pre; text-align:end; font-variant-numeric:tabular-nums; }
.host-credits__total::before { content:attr(data-credit-reserve); display:block; height:0; visibility:hidden; }
/* An empty loading total keeps the same line box and baseline as its receipt. */
.host-credits__total:empty::after { content:"\\200b"; }
.host-credits__measure-total { font-variant-numeric:tabular-nums; }
.host-credits__used-up { visibility:hidden; font-weight:600; white-space:nowrap; color:var(--aithema-ink); }
.host-credits__used-up-short { display:none; }
.host-credits[data-ended="true"] .host-credits__text { visibility:hidden; opacity:0; }
.host-credits[data-ended="true"] .host-credits__used-up { visibility:visible; }
.host-credits__text,.host-credits__used-up { transition:opacity .3s; }
.host-credits .credits-popup { width:268px; white-space:normal; overflow:visible; }
.credits-popup::after { content:""; position:absolute; left:0; right:0; bottom:-10px; height:10px; }
.credits-popup .host-credits__current { display:flex; align-items:center; gap:7px; border-top:1px solid color-mix(in srgb,var(--aithema-paper) 16%,transparent); padding-top:8px; }
/* Session projections change text inside reserved rows, including empty offers.
   Keep hidden rows in the layout so sibling/tier updates cannot move the action. */
.host-credits[data-session-credits] .credits-popup { display:grid; grid-template-rows:72px 48px 36px 28px 36px 18px; grid-template-columns:1fr; gap:8px; }
.host-credits[data-session-credits] .credits-popup > :is(p,a,span) { margin:0; }
.host-credits[data-session-credits] .credits-popup > [hidden] { display:block !important; visibility:hidden; pointer-events:none; }
.host-credits[data-session-credits]:not([data-reset-time]) .host-credits__deadline { display:none !important; }
.host-credits[data-reset-time] .host-credits__deadline { grid-area:5/1; min-height:2lh; }
.host-credits[data-reset-time][data-daily-cap] .host-credits__limit { visibility:hidden; }
.host-credits[data-session-credits] :is(.host-credits__scope,.host-credits__daily-cap) { grid-area:1/1; }
.host-credits[data-session-credits] .host-credits__scope { visibility:visible; }
.host-credits[data-session-credits][data-daily-cap] .host-credits__scope { visibility:hidden; }
.host-credits[data-session-credits] .host-credits__current { grid-area:2/1; align-items:start; }
.host-credits[data-session-credits] .host-credits__next { grid-area:3/1; }
.host-credits[data-session-credits] .credits-email { grid-area:4/1; }
.host-credits[data-session-credits] .host-credits__limit { grid-area:5/1; }
.host-credits[data-session-credits] .host-credits__equivalence { grid-area:6/1; }
.credits-check { display:grid; flex:none; } .credits-check svg { width:14px; height:14px; }
.credits-email { display:inline-flex; align-items:center; min-height:28px; position:relative; font-weight:600; color:var(--aithema-paper); text-decoration:underline; text-underline-offset:3px; }
.credits-email::after { content:""; position:absolute; inset:-8px -4px; }
.credits-email:focus-visible { outline-color:var(--aithema-paper); }
.host-credits__equivalence { font-size:11.5px; opacity:.7; }
.host-credits__limit { display:block; }
.host-credits[data-pinned]:not([data-dismissed]) .footer-popup { visibility:visible; opacity:1; pointer-events:auto; }
/* Calm exhausted rail: same cells, no warning color or active controls. */
.audio-rail:is([data-used-up],[data-credit-ending]) .voice-close { color:var(--aithema-ink); }
.audio-rail[data-credit-ending] .voice-close { visibility:visible; }
.audio-rail[data-used-up] :is(.pause,.voice-pause,.voice-input,.voice-close,.voice-retry,.voice-playback),
.audio-rail[data-used-up] :is(.pause,.voice-pause) .voice-icon { visibility:hidden; }
.audio-rail[data-used-up] :is(.voice-start,.voice-output,.voice-wave) { visibility:visible; }
.audio-rail[data-used-up] :is(.pause,.voice-pause) { color:var(--aithema-ink); background:transparent; border-color:var(--aithema-line); }
.audio-rail[data-used-up] .voice-state { color:var(--aithema-ink); }
.audio-rail[data-credit-ending] .voice-wave { transform:scaleY(.07); transition:transform .6s; }
.audio-rail[data-credit-ending] button:disabled { opacity:1; }
.audio-rail:is([data-used-up],[data-credit-ending]) button { transition:opacity .3s, background-color .3s, color .3s; }
/* AIT-135 C: all address states share one grid cell. Inactive controls are also inert. */
.host-mail { display:grid; gap:.55rem; align-content:start; }
.m-stack { display:grid; max-width:36rem; }
.m-stack > .m-view { grid-area:1/1; min-width:0; visibility:hidden; align-content:start; }
.m-stack > .m-view.on { visibility:visible; }
/* Keep at most one notice line before the next Settings section. */
.general .host-mail[data-email-reservation="mail"] { margin-bottom:-.5rem; }
/* Mail can show its own view, delete confirmation and the privacy fallback. */
[data-email-reservation="mail"] .m-stack > :is([data-view="capture"],[data-view="saved"]) { display:none; }
/* Unknown tiers keep the full union, including space for later tier copy. */
[data-email-reservation="union"] .m-form .m-lead { min-height:3lh; }
[data-email-reservation="union"] .m-mail-tier { min-height:2lh; }
/* A wrapped delete action may be taller: keep the mail notice at the cell end. */
[data-email-mode="mail"] .m-stack > [data-view="mail"] { grid-template-rows:auto auto minmax(44px,1fr) auto; }
/* The two-line delete error is a reachable state, including with Linux fonts. */
[data-email-mode="mail"] .m-delete-message { min-height:2lh; }
.m-view { display:grid; gap:.45rem; }
.m-lead { font-size:.85rem; line-height:1.45; color:var(--aithema-ink); margin:0; font-variant-numeric:tabular-nums; }
.m-credit-status { color:var(--aithema-muted); }
.m-two { display:grid; } .m-two > * { grid-area:1/1; }
.m-lead-edit,.m-delete-over,.verify__lead-reconfirm { visibility:hidden; }
.m-form.editing .m-lead-save,.m-cons.over .m-delete-normal,.verify__lead.reconfirm .verify__lead-mail { visibility:hidden; }
.m-form.editing .m-lead-edit,.m-cons.over .m-delete-over,.verify__lead.reconfirm .verify__lead-reconfirm { visibility:inherit; }
.m-form { grid-template-columns:minmax(0,1fr) auto auto; grid-template-areas:"lead lead lead" "label label label" "in save cancel" "msg msg msg" "notice notice notice"; column-gap:.5rem; row-gap:.3rem; align-items:center; margin:0; }
.m-form .m-lead { grid-area:lead; margin-bottom:.35rem; }
.m-label { grid-area:label; font-size:.75rem; color:var(--aithema-muted); }
.m-in { grid-area:in; width:100%; min-height:44px; padding:.4rem .7rem; border:1px solid var(--aithema-line-strong,var(--aithema-line)); border-radius:.55rem; background:var(--aithema-paper); color:var(--aithema-ink); font: .95rem var(--aithema-font); }
.m-in::placeholder { color:var(--aithema-muted); opacity:1; }
.m-in[aria-invalid="true"],.verify__input[aria-invalid="true"] { border-color:color-mix(in srgb,var(--aithema-ink) 50%,transparent); }
.host-mail .m-save { grid-area:save; margin-left:0; justify-self:stretch; min-height:44px; padding:0 1.15rem; border-radius:.55rem; background:var(--aithema-accent); color:var(--aithema-on-accent); font-weight:600; white-space:nowrap; }
.m-save[aria-disabled="true"],.m-del[aria-disabled="true"] { opacity:.55; cursor:progress; }
.host-mail .m-cancel { grid-area:cancel; margin-left:0; } .m-form:not(.editing) .m-cancel { visibility:hidden; }
.m-form .m-msg { grid-area:msg; }
.m-msg { display:flex; align-items:center; gap:.4rem; min-height:2.6em; margin:0; font-size:.8rem; line-height:1.3; color:var(--aithema-ink); }
.verify__message.identity-stream-wait,.m-msg.identity-stream-wait { color:var(--aithema-muted); }
.m-ico { flex:none; width:14px; height:14px; display:grid; color:var(--aithema-accent); } .m-ico:empty { visibility:hidden; }
.m-form .m-notice { grid-area:notice; }
.m-notice { font-size:.75rem; line-height:1.5; color:var(--aithema-muted); max-width:34rem; margin:0; }
.m-notice-measure { display:none; }
.m-notice[data-notice-mode="save"] { display:grid; }
.m-notice[data-notice-mode="save"] > span { grid-area:1/1; min-width:0; }
.m-notice[data-notice-mode="save"] .m-notice-measure { display:block; visibility:hidden; pointer-events:none; user-select:none; }
.m-pp { position:relative; color:var(--aithema-muted); text-decoration:underline; text-underline-offset:3px; white-space:nowrap; padding-block:4px; }
.m-pp::after { content:""; position:absolute; inset:-11px -4px; }
.m-addr { margin:0; min-height:2.8em; max-height:2.8em; overflow:auto; font-size:.95rem; color:var(--aithema-ink); font-weight:600; overflow-wrap:anywhere; }
.m-tier { display:flex; align-items:center; gap:.4rem; margin:0; font-size:.85rem; color:var(--aithema-muted); font-variant-numeric:tabular-nums; }
.m-tier svg { flex:none; color:var(--aithema-accent); }
/* Keep labels on one line and let the second action move below when needed. */
.m-acts { display:flex; align-items:center; flex-wrap:wrap; gap:24px; margin-top:.15rem; }
.m-acts > button { flex:none; white-space:nowrap; }
.m-act { min-height:44px; padding:0 .85rem; border-radius:.6rem; color:var(--aithema-accent); font-weight:600; font-size:.85rem; }
.m-act:hover { background:color-mix(in srgb,var(--aithema-accent) 8%,transparent); }
.host-mail .m-acts > button { margin-left:0; }
.m-acts > .m-act:first-child { margin-left:-.85rem; }
/* The separator sits in the middle of the 24 px between the two button boxes. */
.m-dot { flex:none; display:flex; justify-content:center; width:0; margin-inline:-12px; color:var(--aithema-muted); opacity:.6; }
.m-mail-tier { gap:0; white-space:pre-wrap; }
.m-mail-tier-state { display:flex; align-items:center; }
.m-mail-tier-measure { display:none; }
[data-email-mode="mail"] .m-mail-tier { display:grid; }
[data-email-mode="mail"] .m-mail-tier > * { grid-area:1/1; }
[data-email-mode="mail"] .m-mail-tier-measure { display:block; visibility:hidden; }
[data-email-mode="mail"] [data-address="false"] .m-mail-tier-state { visibility:hidden; }
.host-mail .verify-entry-state { display:block; }
.m-q { font-size:.95rem; font-weight:600; margin:0; min-height:1.5rem; }
.m-cons[data-delete-normal]::before { content:attr(data-delete-normal); visibility:hidden; grid-area:1/1; }
.m-cons[data-delete-over]::after { content:attr(data-delete-over); visibility:hidden; grid-area:1/1; }
.m-cons { font-size:.85rem; line-height:1.45; margin:0; max-width:34rem; }
.host-mail .m-del { min-height:44px; margin-left:0; padding:0 1rem; border-radius:.55rem; border:1px solid var(--aithema-line); color:var(--aithema-ink); font-weight:600; font-size:.85rem; }
.m-delete-message,.m-unavailable-message { min-height:2.6em; margin:0; font-size:.8rem; }
.m-mail-stack { display:grid; } .m-mail-stack > * { grid-area:1/1; }
[data-view="mail"][data-address="true"] .m-lead-mail,[data-view="mail"][data-address="false"] .verify-entry-state { visibility:hidden; }
.m-sent-prefix { font-weight:400; color:var(--aithema-muted); }
.verify__lead { font-size:.85rem; line-height:1.45; margin:0; }
@media(max-width:600px) {
  .composer-out__bar { font-size:13px; gap:10px; }
  .composer-out { --host-limit-text-inset:calc(12px - 1px - clamp(.85rem,2vw,1.25rem)); }
  /* Fit the longer limit body into existing padding; retain the normal composer's line box. */
  .composer-out[data-host-limit] .composer-out__title,.composer-out__body > [data-host-body] { transform:translateY(-10px); }
  .composer-out[data-host-limit] .composer-out__bar { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; transform:translateY(10px); }
  .composer-out[data-host-limit] .composer-out__steps { display:grid; grid-area:1/1; visibility:hidden; opacity:0; }
  /* Preserve the normal action cell's wrapped button and hidden export measurements. */
  .composer-out[data-host-limit] .composer-out__bar::before { content:attr(data-upgrade-measure); grid-area:1/2; visibility:hidden; box-sizing:border-box; width:132px; min-height:44px; padding:4px 12px; font-size:14px; font-weight:600; line-height:1.2; }
  .composer-out[data-host-limit] .composer-out__bar::after { content:attr(data-export-measure); grid-area:1/2; visibility:hidden; box-sizing:border-box; width:max-content; min-height:44px; padding-inline-start:22px; font-size:13.5px; line-height:1.25; white-space:nowrap; }
  .composer-out[data-host-limit] .composer-out__actions { position:absolute; inset-inline:0; bottom:0; grid-template-columns:minmax(0,1fr); grid-template-rows:44px 44px; gap:0; }
  /* Keep the three-line offer's space when a top-up shortens its hidden copy. */
  .composer-out__steps { min-height:4.05em; }
  .composer-out__upgrade { max-width:132px; padding:4px 12px; line-height:1.2; text-align:center; white-space:normal; }
  .composer-out__export { line-height:1.25; }
  .host-credits__used-up-full { display:none; } .host-credits__used-up-short { display:inline; }
}
@media(width < 360px) { .host-credits .host-credits__track { display:none; } }
@media(max-width:40rem) {
  .m-form { grid-template-columns:auto auto minmax(0,1fr); grid-template-areas:"lead lead lead" "label label label" "in in in" "msg msg msg" "notice notice notice" "save cancel ."; row-gap:.35rem; }
  .m-save,.m-cancel { margin-top:.3rem; } .m-msg { font-size:.75rem; }
}
/* Only the host-limit state reserves stacked actions on narrow phones. */
@media(width < 389px) {
  /* The measured bar retains the normal composer's size; only its absolute
     host-limit action layer reserves the two 44 px rows. */
  .composer-out[data-host-limit] .composer-out__actions { min-height:90px; }
  /* The hidden title sizer keeps the normal row's measurement. Reserve the
     visible title's two lines independently so wrapping cannot grow the shell. */
  .composer-out[data-host-limit] .composer-out__title { position:relative; font-size:11.5px; }
  .composer-out[data-host-limit] .composer-out__title > span { position:absolute; inset:0; height:2lh; line-height:1.35; letter-spacing:-.025em; }
  .composer-out__body > [data-host-body] { position:relative; top:calc(2 * 11.5px * 1.35 - 15.5px * 1.35); font-size:12px; line-height:1.3; }
  /* Extend only this surface into the bottom gutter. Equal padding and
     negative margin keep its grid contribution and the normal shell fixed,
     while retaining the stacked export target inside the visible border. */
  .composer-out[data-host-limit] { padding-block-end:calc(clamp(.85rem,2vw,1.25rem) + 8px); margin-block-end:-8px; }
  .composer-out[data-host-limit] .composer-out__bar { transform:translateY(22px); }
}
/* AIT-435 Tick v1: reserve both real action rows in every phone state.
   The primary and export occupy independent 44 px targets with a 12 px gap. */
@media(width < 600px) {
  .composer-out__bar { min-height:102px; }
  .composer-out .composer-out__bar .composer-out__actions { grid-template-columns:minmax(0,1fr); grid-template-rows:44px 44px; gap:12px; justify-items:start; }
  .composer-out .composer-out__actions > :is(.composer-out__upgrade,.composer-out__new) { grid-area:1/1; }
  .composer-out .composer-out__actions > .composer-out__export { grid-area:2/1; }
  .composer-out__new { top:0; bottom:auto; max-width:none; }
  .composer-out[data-host-limit] :is(.composer-out__upgrade,.composer-out__export) { font-size:11.5px; }
}
:host([theme="dark"]) .composer-out:not([data-host-limit]) .composer-out__upgrade { background:var(--aithema-accent-bright); }
@media(prefers-color-scheme:dark) { :host(:not([theme="light"])) .composer-out:not([data-host-limit]) .composer-out__upgrade { background:var(--aithema-accent-bright); } }
@media(prefers-reduced-motion:reduce) { .composer-shell *, .host-credits *, .audio-rail[data-used-up] * { transition:none; } }
`;
