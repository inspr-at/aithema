// Conversation bubbles and aside adapted from START index.astro; INSPR rights (D3).
// AIT-118 (GUI-27): every text token reaches 4.5:1 on paper, surface, both bubbles and the hover
// and selection tints, in both themes (test/contrast.js). Structure is hairlines, tints and weight:
// actions are quiet accent text, each area has at most one filled primary, toggles mark their
// state with a check in a slot every toggle reserves, and nothing changes size on hover or selection.
export const styles = `
:host { --aithema-paper: #f7f5ef; --aithema-ink: #243b40; --aithema-muted: #566669;
  --aithema-accent: #1d6e6a; --aithema-amber: #c5974e; --aithema-line: #d5dfda;
  --aithema-surface: #fffef9; --aithema-on-accent: #ffffff; --aithema-warning: #7f5933; --aithema-error: #9a4030; --aithema-font: system-ui, sans-serif;
  color-scheme:light dark; display:block; color:var(--aithema-ink); font: 1rem/1.5 var(--aithema-font); }
@media(prefers-color-scheme:dark) { :host { --aithema-paper: #141a1b; --aithema-ink: #e2e9e6; --aithema-muted: #9badab;
  --aithema-accent: #5db5ae; --aithema-amber: #d6ab63; --aithema-line: #33403f; --aithema-surface: #1b2223; --aithema-on-accent: #0d1716;
  --aithema-warning: #d6ab63; --aithema-error: #e59a87; } }
* { box-sizing:border-box; } [hidden] { display:none !important; }
button, textarea, select, a { font:inherit; } button, a { touch-action:manipulation; }
button { color:inherit; cursor:pointer; background:transparent; border:0; border-radius:.45rem; padding:.5rem .85rem; }
button:where(:hover:not(:disabled)) { background:color-mix(in srgb,var(--aithema-accent) 8%,transparent); }
button:disabled { opacity:.5; cursor:wait; } :focus-visible { outline:2px solid var(--aithema-accent); outline-offset:3px; }
/* Quiet actions: accent text, a tint on hover. */
:is(.pause, .concept-tab, .settings-open, .expand, .retry, .transcript-latest, .voice-controls button, .concept-request, .concept-close,
  .concept-download, .ready__actions button, .notice-action, .save-retry, .general button, .local-disconnect, .local-test, .copy-command,
  .local-help-link, .local-stop, .local-send, .attach) { color:var(--aithema-accent); font-weight:600; }
/* The one filled primary of an area. */
:is(.send, .concept-regenerate, .local-connect) { color:var(--aithema-on-accent); background:var(--aithema-accent); font-weight:600; }
:is(.send, .concept-regenerate, .local-connect):hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-accent) 84%,var(--aithema-ink)); }
/* Toggles: ink text; pressed adds a check in the slot every toggle keeps and turns accent. Weight never changes. */
:is(.concept-up, .concept-down, .concept-guidance-options button)::before { content:'✓' / ''; display:inline-block; width:1.1em; visibility:hidden; }
:is(.concept-up, .concept-down, .concept-guidance-options button)[aria-pressed="true"] { color:var(--aithema-accent); }
:is(.concept-up, .concept-down, .concept-guidance-options button)[aria-pressed="true"]::before { visibility:visible; }
.workspace { display:grid; gap:1rem; }
/* The processing band: plain text on the page, set off by one hairline, not a box. */
.preset-panel { grid-column:1/-1; height:9rem; overflow:auto; overflow-anchor:none; border-bottom:1px solid var(--aithema-line); scrollbar-gutter:stable;
  padding:calc(.5rem + var(--aithema-slack-top,0px)) .25rem calc(.5rem + var(--aithema-slack-bottom,0px)); }
.features { display:flex; flex-wrap:wrap; list-style:none; padding:0; gap:.3rem 1rem; margin:.5rem 0; }
.features li { font-size:.75rem; } .features .unavailable { color:var(--aithema-muted); }
.features span { display:block; font-size:.65rem; max-width:12rem; } .conversation, .understanding { min-width:0; border:1px solid var(--aithema-line);
  background:var(--aithema-surface); border-radius:1rem; overflow:hidden; }
/* 42rem plus the AI notice's line (AIT-119), so the start card and transcript keep their room. */
.conversation { height:43.6rem; max-height:85dvh; display:grid; grid-template-rows:3.6rem 8rem 5.4rem minmax(0,1fr) auto 10rem; }
.head { display:flex; align-items:center; justify-content:space-between; padding:0 1.25rem; border-bottom:1px solid var(--aithema-line); }
h2 { font-size:1.05rem; font-weight:600; margin:0; } h3 { font-size:.82rem; font-weight:650; margin:0 0 .4rem; }
.status { font-size:.75rem; line-height:1.25; color:var(--aithema-muted); max-width:50%; max-height:2.5em; overflow:hidden; text-align:right; }
.transcript-shell { overflow:auto; overflow-anchor:none; scrollbar-gutter:stable;
  padding:calc(1.25rem + var(--aithema-slack-top,0px)) 1.25rem calc(1.25rem + var(--aithema-slack-bottom,0px)); }
.transcript-latest { position:sticky; bottom:0; display:block; margin:.6rem auto 0; font-size:.75rem;
  background:var(--aithema-surface); }
ol { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:1rem; }
.turn { position:relative; padding:.75rem 1rem; border-radius:.75rem;
  max-width:78%; background:color-mix(in srgb,var(--aithema-ink) 7%,var(--aithema-paper)); align-self:flex-start; overflow-wrap:anywhere; }
/* START's bubble tail, in the bubble's own tint: no outline, no shadow. */
.turn::before { content:''; position:absolute; left:-.43rem; top:.85rem; width:.75rem; height:.75rem;
  background:inherit; transform:rotate(45deg); clip-path:polygon(0 0,0 100%,100% 100%); }
.turn.user { align-self:flex-end; background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-paper)); }
.turn.user::before { left:auto; right:-.43rem; clip-path:polygon(100% 0,0 0,100% 100%); }
.turn strong { display:block; font-size:.68rem; color:var(--aithema-muted); margin-bottom:.2rem; }
.turn span { white-space:pre-wrap; } .turn.partial { color:var(--aithema-muted); }
:is(.withdraw, .upload-withdraw) { display:block; margin-top:.4rem; font-size:.72rem; padding:.2rem 0; color:var(--aithema-muted); text-decoration:underline;
  text-decoration-color:color-mix(in srgb,currentColor 40%,transparent); text-underline-offset:3px; }
:is(.withdraw, .upload-withdraw):hover:not(:disabled) { background:none; color:var(--aithema-ink); text-decoration-color:currentColor; } .pause { font-size:.75rem; min-width:5.5rem; flex-shrink:0; }
.composer { border-top:1px solid var(--aithema-line); padding:.8rem 1.2rem; display:grid; gap:.5rem; }
/* The AI notice (AIT-119, GUI-27): plain muted text heading the composer, no box. Both spans share one
   cell; the hidden full notice sets the height, so the line never resizes after the first paint. */
.ai-notice { display:grid; margin:0; padding:.6rem 1.2rem 0; border-top:1px solid var(--aithema-line); font-size:.75rem; line-height:1.35;
  color:var(--aithema-muted); overflow-wrap:anywhere; } .ai-notice > span { grid-area:1/1; } .ai-notice__sizer { visibility:hidden; }
.ai-notice + .composer { border-top:0; }
.composer label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
textarea { resize:none; width:100%; height:5rem; border:0; background:transparent; color:inherit; padding:.3rem 0; }
textarea::placeholder { color:var(--aithema-muted); opacity:1; }
.composer-actions { display:flex; align-items:center; justify-content:space-between; gap:.75rem; }
.composer-actions small { font-size:.7rem; color:var(--aithema-muted); } .send { min-width:6rem; }
/* A long reason wraps to a second line rather than ending in "…"; a longer upload refusal scrolls in its two lines. */
.composer-reason { flex:1; min-width:0; line-height:1.3; max-height:2.6em; overflow-wrap:anywhere; overflow-y:auto; overscroll-behavior:contain; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* Attach (AIT-100 B2): a quiet action; unavailable stays focusable and says why when pressed. */
.attach { display:inline-flex; align-items:center; gap:.4rem; flex-shrink:0; margin-left:-.85rem; font-size:.78rem; }
.attach svg { flex:none; } .attach[aria-disabled="true"] { opacity:.5; cursor:not-allowed; }
.attach[aria-disabled="true"]:hover { background:none; }
/* Dropping files: an overlay over the conversation that never takes layout space. */
.conversation { position:relative; }
.drop-overlay { position:absolute; inset:.5rem; display:grid; place-items:center; padding:1rem; text-align:center; pointer-events:none; visibility:hidden;
  border:2px dashed var(--aithema-accent); border-radius:.75rem; background:color-mix(in srgb,var(--aithema-surface) 94%,transparent); }
.conversation[data-dropping] .drop-overlay { visibility:visible; }
.drop-overlay p { margin:0; display:grid; gap:.3rem; } .drop-overlay strong { color:var(--aithema-accent); } .drop-overlay span { font-size:.8rem; color:var(--aithema-muted); }
/* An upload in the transcript (GUI-27, not a pill): glyph, name and Withdraw upload; then muted size and state.
   Fixed width and slots: a state change or withdrawal never moves the name or the action, nor resizes the row. */
.upload { align-self:flex-end; width:min(34rem,78%); display:grid; grid-template-columns:1.25rem 4.5rem minmax(0,1fr) auto;
  grid-template-rows:1.6rem auto; grid-template-areas:"glyph name name action" "glyph size state state"; column-gap:.5rem; padding:.15rem 0; overflow-wrap:anywhere; }
.upload:focus { outline:none; } .upload:focus-visible { outline:2px solid var(--aithema-accent); outline-offset:3px; }
.upload__glyph { grid-area:glyph; color:var(--aithema-muted); padding-top:.1rem; } .upload__glyph svg { display:block; }
.upload__name { grid-area:name; align-self:center; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.87rem; font-weight:600; }
.upload__size { grid-area:size; } .upload__size, .upload__status > * { font-size:.72rem; color:var(--aithema-muted); line-height:1.45; }
/* The real line and its invisible stand-ins share one cell: the cell keeps the size of the largest. */
.upload__action { grid-area:action; display:grid; justify-items:end; align-items:center; }
.upload__status { grid-area:state; display:grid; } :is(.upload__action, .upload__status) > * { grid-area:1/1; }
.upload__sizer { visibility:hidden; } .upload__action .upload__sizer { display:block; font-size:.72rem; padding:.2rem 0; }
.upload__action :is(.upload-withdraw, .upload__sizer) { white-space:nowrap; }
.upload[data-state="unreadable"] .upload__state { color:var(--aithema-warning); }
.upload[data-state="withdrawn"] .upload__name { font-weight:400; color:var(--aithema-muted); }
.upload .upload-withdraw { margin-top:0; } .upload-withdraw[aria-disabled="true"] { opacity:.5; cursor:wait; }
.understanding { height:43.6rem; display:grid; grid-template-rows:3.6rem 7rem minmax(0,1fr) 3.6rem; }
.readiness { padding:.8rem 1.25rem; } .scale { height:.72rem; border:1px solid var(--aithema-line); border-radius:999px;
  position:relative; background:linear-gradient(90deg,color-mix(in srgb,var(--aithema-accent) 10%,var(--aithema-surface)) 0 30%,
  color-mix(in srgb,var(--aithema-amber) 12%,var(--aithema-surface)) 30% 100%); overflow:visible; }
.fill { display:block; height:100%; border-radius:inherit; background:var(--aithema-accent); width:0; }
.marker { position:absolute; top:-.25rem; left:30%; height:1.1rem; width:2px; background:var(--aithema-ink); }
.scale-labels { display:flex; justify-content:space-between; font-size:.65rem; color:var(--aithema-muted); margin:.3rem 0; }
.readiness p { margin:0; font-size:.7rem; color:var(--aithema-muted); }
.analysis-content { overflow:auto; overflow-anchor:none; scrollbar-gutter:stable; overflow-wrap:anywhere;
  padding:var(--aithema-slack-top,0px) 1.25rem calc(1rem + var(--aithema-slack-bottom,0px)); }
.none-yet { list-style:none; color:var(--aithema-muted); } ul .none-yet { margin-left:-1.1rem; } .missing .none-yet { border-top:0; }
.analysis-content section { margin-bottom:1.1rem; } .analysis-content p { margin:0; font-size:.87rem; }
ul { margin:.3rem 0; padding-left:1.1rem; font-size:.83rem; } .notice { min-height:2.6rem; color:var(--aithema-muted); }
.missing { list-style:none; padding:0; } .missing li { border-top:1px solid var(--aithema-line); padding:.5rem 0; }
.missing strong { display:block; font-size:.7rem; color:var(--aithema-muted); } .missing span { display:block; }
.cleared-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.expand { font-size:.65rem; min-width:6rem; padding:.2rem .4rem; }
details { font-size:.8rem; border-top:1px solid var(--aithema-line); padding:.5rem 0; }
summary { cursor:pointer; } details p { padding:.5rem 0; } blockquote { margin:.5rem 0 .5rem .7rem; color:var(--aithema-muted); }
.foot { border-top:1px solid var(--aithema-line); display:flex; align-items:center; justify-content:space-between; padding:0 1.25rem; }
.export { font-size:.78rem; color:var(--aithema-accent); } .retry { font-size:.72rem; }
.audio-rail { height:8rem; display:grid; grid-template-columns:3rem minmax(0,1fr); grid-template-rows:3rem 3rem;
  gap:.3rem .6rem; padding:.5rem 1rem; border-bottom:1px solid var(--aithema-line); overflow:hidden; }
.voice-orb { width:3rem; height:3rem; border-radius:50%; position:relative; background:
  radial-gradient(circle at 35% 30%,var(--aithema-surface),transparent 60%),
  radial-gradient(circle at 65% 60%,var(--aithema-amber),var(--aithema-accent)); opacity:.6; }
.voice-info { min-width:0; display:grid; align-content:center; font-size:.75rem; line-height:1.3; }
/* The state wraps into reserved lines (two here, four on phones) that fit the longest English and German
   message, so nothing is cut off and no control moves. A narrower host scrolls the rest rather than hiding it.
   The live caption keeps its newest words in view (the full turn lands in the transcript). */
.voice-state { max-height:2.6em; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; overflow-wrap:anywhere; }
.voice-caption { min-height:1.3em; display:flex; justify-content:flex-end; overflow:hidden; white-space:nowrap; color:var(--aithema-muted); }
.voice-controls { grid-column:1/-1; display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:.3rem; }
.voice-controls button { min-width:0; width:100%; height:2.7rem; padding:.15rem; font-size:.65rem; overflow:hidden; }
.voice-wave { position:absolute; inset:25% 18%; display:grid; grid-template-columns:repeat(9,1fr); align-items:center; gap:1px; }
.voice-wave i { height:100%; background:var(--aithema-ink); border-radius:2px; transform:scaleY(.15); }
.audio-rail[data-state="speaking"] .voice-orb, .audio-rail[data-state="listening"] .voice-orb { opacity:1; }
.audio-rail[data-state="speaking"]:not([data-measured]) .voice-wave i { animation:voice-wave .7s ease-in-out infinite alternate; }
.audio-rail[data-state="speaking"] .voice-wave i:nth-child(2n) { animation-delay:-.3s; }
.audio-rail[data-state="speaking"] .voice-wave i:nth-child(3n) { animation-delay:-.5s; }
@keyframes voice-wave { to { transform:scaleY(.8); } }
.concept-rail { height:5.4rem; display:grid; grid-template-columns:2.5rem minmax(0,1fr) minmax(8rem,14rem); align-items:center;
  gap:.6rem; padding:.5rem 1rem; border-bottom:1px solid var(--aithema-line); overflow:hidden; }
.concept-activity { min-width:0; display:grid; gap:.15rem; font-size:.72rem; }
.concept-activity-text { height:2.2rem; overflow:hidden; } .concept-countdown { height:1rem; white-space:nowrap; overflow:hidden; }
.concept-progress { width:100%; height:.4rem; accent-color:var(--aithema-accent); }
.concept-request { width:100%; height:3.8rem; font-size:.7rem; overflow:hidden; }
.concept-scene { width:2.5rem; height:2.5rem; display:grid; grid-template-columns:1fr 1fr; gap:3px; }
.concept-scene i { background:var(--aithema-accent); border-radius:3px; opacity:.3; }
.concept-rail[data-phase="pending"] .concept-scene i { animation:concept-pulse 1.8s ease-in-out infinite alternate; }
.concept-scene i:nth-child(2n) { animation-delay:-.9s; } @keyframes concept-pulse { to { opacity:.9; } }
/* Unread is a filled dot in a slot the tab always keeps, never an edge line. */
.concept-tab { min-width:5.5rem; height:2.4rem; font-size:.75rem; }
.concept-tab::before { content:''; display:inline-block; width:.45rem; height:.45rem; margin-right:.45rem; border-radius:50%;
  vertical-align:.05em; background:transparent; }
.concept-tab[data-unread="true"]::before { background:var(--aithema-accent); }
.concept-preview-slot { height:6rem; margin-bottom:.7rem; }
.concept-preview { width:100%; height:6rem; display:flex; gap:1rem; align-items:center; text-align:left; }
.concept-preview img { width:8rem; height:4.5rem; object-fit:contain; border-radius:.3rem; } .concept-preview-label { font-size:.8rem; }
.concept-preview-glyph { width:8rem; height:4.5rem; flex:none; display:grid; place-items:center; color:var(--aithema-accent); }
.concept-preview-glyph svg { width:3.5rem; height:auto; }
.concept-viewer { position:fixed; inset:0; margin:0; width:100vw; max-width:none; height:100dvh; max-height:none; padding:0; border:0;
  color:var(--aithema-ink); background:var(--aithema-paper); overflow:hidden; }
.concept-viewer[open] { display:grid; grid-template-rows:4rem minmax(0,1fr) 12.5rem; }
.concept-viewer::backdrop { background:var(--aithema-ink); }
.concept-viewer-head { display:grid; grid-template-columns:minmax(0,1fr) 5rem minmax(9rem,13rem); align-items:center; gap:1rem; padding:.5rem 1rem; }
/* The title wraps to two lines rather than hiding its end. */
.concept-viewer-head h2 { line-height:1.2; max-height:2.4em; overflow:hidden; overflow-wrap:anywhere; } .concept-count { font-size:.8rem; }
.concept-stage { position:relative; min-height:0; display:grid; place-items:center; padding:1rem; }
.concept-image { width:100%; height:100%; min-height:0; object-fit:contain; }
/* A draft fills the stage; its width switch sits in the preview's own top line. */
.concept-viewer[data-kind="html"] .concept-stage { place-items:stretch; padding:.5rem 1rem 0; }
.concept-html { width:100%; height:100%; min-height:0; }
.concept-image-status { position:absolute; bottom:0; font-size:.8rem; }
/* GUI-27, not a row of equal boxes: Previous and Next are quiet navigation, Regenerate is the one
   filled action, Download is quiet text, Reject is quiet red text set apart on the right. */
.concept-viewer-controls { padding:.35rem 1rem .5rem; overflow:auto; scrollbar-gutter:stable; border-top:1px solid var(--aithema-line); }
.concept-navigation, .concept-feedback { display:flex; align-items:center; gap:.25rem; height:2.75rem; }
.concept-viewer-controls button { min-height:2.5rem; font-size:.82rem; line-height:1.2; padding:.35rem .7rem; }
.concept-previous, .concept-next, .concept-up, .concept-down, .concept-guidance-options button { color:var(--aithema-ink); }
.concept-previous { margin-left:-.7rem; } .concept-previous::before { content:'‹' / ''; margin-right:.4rem; } .concept-next::after { content:'›' / ''; margin-left:.4rem; }
.concept-download { margin-left:auto; } .concept-regenerate { padding-inline:1.1rem; }
.concept-up { margin-left:-.7rem; }
.concept-reject { margin-left:auto; color:var(--aithema-error); font-weight:600; }
.concept-reject:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-error) 8%,transparent); }
.concept-disclosure { height:1.2rem; margin:.1rem 0 .2rem; font-size:.75rem; color:var(--aithema-muted); overflow:hidden; }
/* Guidance: plain toggles that wrap into rows on narrow screens rather than scrolling sideways out of view. */
.concept-guidance-options { min-height:2.75rem; display:flex; flex-wrap:wrap; align-items:center; align-content:center; gap:0 .15rem; margin-left:-.7rem; }
.concept-guidance-options button { flex-shrink:0; white-space:nowrap; }
.concept-viewer-message { height:1.2rem; margin:.1rem 0 0; font-size:.75rem; }
@media(min-width:60rem) { .workspace { grid-template-columns:minmax(0,1.65fr) minmax(20rem,1fr); } }
/* Phones: fixed rail heights keep targets still; the transcript gets most of a small viewport (D14). */
@media(max-width:40rem) {
  .conversation { height:auto; max-height:none; grid-template-rows:3.6rem 12rem 9.4rem clamp(20rem,60svh,36rem) auto 9rem; }
  textarea { height:3.8rem; }
  /* Phones: Attach is its icon; the name stays its accessible label. */
  .attach { width:2.75rem; height:2.75rem; padding:0; justify-content:center; margin-left:-.6rem; }
  .attach__label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .upload { width:90%; }
  .audio-rail { height:12rem; grid-template-columns:2.5rem minmax(0,1fr); grid-template-rows:4.9rem auto; }
  .voice-orb { width:2.5rem; height:2.5rem; align-self:center; } .voice-state { max-height:5.2em; }
  .voice-controls { grid-template-columns:repeat(4,minmax(0,1fr)); grid-auto-rows:2.7rem; }
  .voice-controls button { line-height:1.2; }
  .concept-rail { height:9.4rem; grid-template-columns:2.5rem minmax(0,1fr); grid-template-rows:minmax(0,1fr) 2.7rem; align-items:start; }
  .concept-activity-text { height:3.3rem; }
  .concept-request { grid-column:1/-1; height:2.7rem; }
  /* The viewer on phones: navigation in two rows and a two-line disclosure, so long (German) labels stay whole. */
  .concept-viewer[open] { grid-template-rows:4rem minmax(0,1fr) 21.5rem; }
  .concept-navigation { height:auto; display:grid; grid-template-columns:auto auto minmax(0,1fr); grid-template-rows:2.75rem 2.75rem; row-gap:.2rem; }
  .concept-download { justify-self:end; } .concept-regenerate { grid-column:1/-1; }
  .concept-feedback { display:grid; grid-template-columns:auto auto minmax(0,1fr); }
  .concept-reject { justify-self:end; text-align:right; }
  .concept-viewer-controls button { font-size:.8rem; padding-inline:.6rem; }
  .concept-previous, .concept-up, .concept-guidance-options { margin-left:-.6rem; }
  .concept-disclosure { height:2.4em; line-height:1.2; }
  .concept-viewer-head { grid-template-columns:minmax(0,1fr) 3.5rem minmax(7rem,9rem); gap:.5rem; }
  .concept-viewer-head h2 { font-size:.95rem; } .concept-close { font-size:.75rem; line-height:1.2; padding:.3rem .5rem; }
}
@media(pointer:coarse) { .concept-viewer-controls button { min-height:2.75rem; } }
@media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto; animation:none !important; } }
`;
