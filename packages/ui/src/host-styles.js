// Host surface (AIT-104 B2) on the component's tokens, GUI-27: hairlines, weight and whitespace,
// quiet accent text actions and at most one filled primary per area. Every changing value sits in
// a reserved slot (stacked states share one grid cell), so nothing moves under the pointer.
export const hostStyles = `
/* The host bar sits in the top row beside the processing line (START's masthead controls): the credits line,
   Conversations, the verification entry and the account slot on one line; on phones the credits go under them. */
.host-bar { display:grid; grid-template-columns:minmax(0,auto) repeat(3,auto); grid-template-areas:"credits library verify account";
  justify-content:end; align-items:center; column-gap:.5rem; min-width:0; }
.library-open-dialog { grid-area:library; display:inline-flex; align-items:center; gap:.45rem; min-height:2.75rem; padding:.4rem .75rem;
  font-size:.8125rem; font-weight:600; color:var(--aithema-accent); white-space:nowrap; border-radius:999px; }
.library-open-dialog svg { display:block; flex:none; }
.host-verify { grid-area:verify; min-width:0; display:flex; align-items:center; }
.verify-entry { min-height:2.75rem; padding:.4rem .6rem; font-size:.8rem; line-height:1.2; font-weight:600; color:var(--aithema-accent); text-align:left; overflow-wrap:anywhere; }
.verify-done { display:inline-flex; align-items:center; gap:.35rem; font-size:.8rem; color:var(--aithema-muted); }
.verify-done svg, .verify__done svg { flex:none; color:var(--aithema-accent); }
.host-account { grid-area:account; justify-self:end; display:flex; align-items:center; min-height:2.75rem; font-size:.8125rem; }
.host-credits { grid-area:credits; justify-self:end; max-width:28rem; margin:0; font-size:.72rem; line-height:1.3; color:var(--aithema-muted); text-align:right; max-height:2.6em;
  overflow-y:auto; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.host-credits[data-ended="true"] .host-credits__text { color:var(--aithema-warning); }
/* Phones (after the rules it adjusts): the controls wrap as whole words (never squeezed to a letter per line),
   the credits line below them, one touch row high with room at its end for Settings. Conversations shows its
   icon; its name stays for assistive technology, so the three actions share one line. */
@media(max-width:44rem) { .host-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-start; gap:0 .25rem; }
  .host-credits { flex:1 0 100%; height:2.75rem; max-height:none; padding:.45rem 3.25rem .45rem 0; text-align:left; }
  .library-open-dialog { justify-content:center; min-width:2.75rem; padding-inline:.5rem; }
  .library-open-dialog span { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; } }
.host-foot { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem 1.5rem;
  padding:1rem 0 .25rem; border-top:1px solid var(--aithema-line); font-size:.75rem; color:var(--aithema-muted); }
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
.analysis-content .verify__pending, .verify__pending { margin:0; min-height:2.75rem; display:flex; flex-wrap:wrap; align-items:center; gap:0 .35rem;
  font-size:.85rem; overflow-wrap:anywhere; }
.verify__address { font-weight:650; } .verify-change { padding:.4rem .5rem; font-size:.8rem; }
.analysis-content .verify__done, .verify__done { display:flex; align-items:center; gap:.4rem; margin:0; min-height:2.75rem; font-size:.87rem; }
.verify__actions { display:flex; flex-wrap:wrap; align-items:center; gap:.25rem .5rem; }
/* Send and Send link again share one cell and one box: the pending state puts its action exactly where the
   pointer pressed Send. */
.verify__primary { display:grid; } .verify__primary > * { grid-area:1/1; justify-self:stretch; min-height:2.75rem; }
.verify-resend { text-align:left; } .verify-cancel { font-size:.85rem; }
.analysis-content .verify__message, .verify__message { margin:0; min-height:2.6em; font-size:.8rem; line-height:1.3; }
.verify__message[data-error="true"] { color:var(--aithema-error); }
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
`;
