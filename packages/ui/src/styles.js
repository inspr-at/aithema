import { reasonSeparator } from './consent-line.js';
import { CONCEPT_CONTROLS } from './concept-guards.js';

// START's look (src/styles/app.css palette, type and shell; src/pages/index.astro workspace, transcript,
// composer, conversation rail and understanding), adapted to the component; INSPR rights (D3).
// The `--aithema-*` custom properties are the public token surface: hosts may override any of them.
// AIT-118 (GUI-27): every text token reaches 4.5:1 on paper, surface, both bubbles, the selected card and
// every tint a control or notice sits on, in both themes (test/contrast.js). Nothing changes size or
// moves on hover, focus or selection: alternatives share one cell and states have reserved space.

/** The two palettes; text tokens are ink, muted, accent, warning and error. */
export const palette = Object.freeze({
  light: Object.freeze({ paper: '#fbf7ef', 'paper-deep': '#f4eee4', surface: '#fffcf8', ink: '#102b42', muted: '#496477',
    accent: '#0e6f6c', 'accent-bright': '#12908c', 'accent-soft': '#ddedea', amber: '#d99732', apricot: '#ffb45e', coral: '#f47c5b',
    warning: '#835410', error: '#a8401f', 'on-accent': '#ffffff', 'on-ink': '#ffffff' }),
  dark: Object.freeze({ paper: '#0b1a26', 'paper-deep': '#081521', surface: '#102433', ink: '#eaf1f6', muted: '#9db4c4',
    accent: '#4fbdb5', 'accent-bright': '#12908c', 'accent-soft': '#0c2d36', amber: '#e0a548', apricot: '#ffb45e', coral: '#f47c5b',
    warning: '#e8b866', error: '#f4a088', 'on-accent': '#0b1a26', 'on-ink': '#0b1a26' }),
});
// Translucent lines, START's raised shadow and the settings glass, per theme.
const extra = {
  light: `--aithema-line:rgba(16,43,66,.13); --aithema-line-strong:rgba(16,43,66,.24);
    --aithema-shadow-raised:0 1px 1px rgba(16,43,66,.04),0 8px 24px -12px rgba(16,43,66,.18),0 32px 64px -32px rgba(16,43,66,.22);
    --aithema-field:linear-gradient(120deg,#ffffff9e,#fcfbf770); --aithema-gauge-panel:radial-gradient(ellipse at 25% 0%,#fffefd,transparent 65%),linear-gradient(155deg,#faf8f3,#f7f9f6 55%,#e6f0ef);
    --aithema-glass:linear-gradient(100deg,#d0d0b14d,#ffffffe6 11%,#fff7 18%,#e7e8d940 47%,#fff8 80%,#90aaa76b); --aithema-glass-edge:#fffef8;
    --aithema-glass-shadow:inset 2px 0 3px #fff,inset -2px 0 3px #7b908340,0 5px 12px #163b3820,0 1px 1px #d8ac7760;
    --aithema-glass-inside:linear-gradient(90deg,#c3b69435,#fff8 24%,#fffffd0d 60%,#879d8f22);`,
  dark: `--aithema-line:rgba(234,241,246,.14); --aithema-line-strong:rgba(234,241,246,.26);
    --aithema-shadow-raised:0 1px 1px rgba(0,0,0,.4),0 12px 32px -16px rgba(0,0,0,.7),0 40px 80px -40px rgba(0,0,0,.8);
    --aithema-field:var(--aithema-surface); --aithema-gauge-panel:linear-gradient(155deg,var(--aithema-surface),var(--aithema-paper));
    --aithema-glass:linear-gradient(100deg,#ffffff0d,#ffffff24 11%,#ffffff12 18%,transparent 47%,#ffffff14 80%,#ffffff08); --aithema-glass-edge:var(--aithema-line);
    --aithema-glass-shadow:inset 1px 0 2px #ffffff1f,0 5px 12px #00000040; --aithema-glass-inside:color-mix(in srgb,var(--aithema-ink) 6%,transparent);`,
};
const tokens = theme => `color-scheme:${theme}; ${Object.entries(palette[theme]).map(([name, value]) => `--aithema-${name}:${value};`).join(' ')} ${extra[theme]}`;
/** Light by default; `theme="dark"`, or the system preference unless `theme="light"`. */
export const themeStyles = `:host { ${tokens('light')} }
:host([theme="dark"]) { ${tokens('dark')} }
@media(prefers-color-scheme:dark) { :host(:not([theme="light"])) { ${tokens('dark')} } }`;

export const styles = `${themeStyles}
.gauge__unrated { display:none; }
.gauge--unrated .gauge__inside { background:repeating-linear-gradient(135deg,var(--aithema-surface) 0 6px,var(--aithema-muted) 6px 7px,var(--aithema-surface) 7px 12px); }
.gauge--unrated .gauge__level, .gauge--unrated .gauge__etch, .gauge--unrated .gauge__glint { visibility:hidden; }
.gauge--unrated .gauge__unrated { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); display:block; padding:.1rem .25rem; border-radius:.2rem; background:var(--aithema-surface); color:var(--aithema-ink); font:600 1.4rem/1 var(--aithema-font); }
:host { --aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif; --aithema-mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
  --aithema-radius-sm:10px; --aithema-radius-md:18px; --aithema-radius-lg:28px;
  --aithema-shell-max:1520px; --aithema-gutter:clamp(1.25rem,4vw,3.5rem);
  /* The live workspace includes its single header and footer. */
  --aithema-height:100dvh;
  --aithema-ease:cubic-bezier(.22,.61,.36,1);
  /* START's three offset light sources (app.css body), none aligned to the grid, fixed to the viewport. */
  --aithema-lighting:radial-gradient(ellipse 60% 50% at 88% 4%,rgba(18,144,140,.14),transparent 70%),
    radial-gradient(ellipse 50% 45% at 6% 18%,rgba(255,180,94,.16),transparent 70%),radial-gradient(ellipse 70% 60% at 40% 100%,rgba(244,124,91,.07),transparent 70%);
  /* What the component paints behind itself: the lighting over paper. A host whose page already paints START's
     paper and lighting sets this to none, so page and component are one canvas without a seam. */
  --aithema-backdrop:var(--aithema-lighting) var(--aithema-paper);
  display:block; color:var(--aithema-ink); background:var(--aithema-backdrop); background-attachment:fixed;
  font:clamp(1rem,.97rem + .15vw,1.0625rem)/1.6 var(--aithema-font); -webkit-font-smoothing:antialiased; }
* { box-sizing:border-box; } [hidden] { display:none !important; }
button, textarea, select, a { font:inherit; } button, a { touch-action:manipulation; }
button { color:inherit; cursor:pointer; background:transparent; border:0; border-radius:.45rem; padding:.5rem .85rem; }
button:where(:hover:not(:disabled)) { background:color-mix(in srgb,var(--aithema-accent) 8%,transparent); }
button:disabled { opacity:.5; cursor:wait; } :focus-visible { outline:2px solid var(--aithema-accent-bright); outline-offset:3px; border-radius:4px; }
::selection { background:var(--aithema-accent); color:var(--aithema-on-accent); }
h2, h3 { margin:0; }
svg { display:block; flex:none; }
.sr-only, .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* Quiet actions: accent text, a tint on hover. */
:is(.concept-tab, .expand, .retry, .transcript-latest, .concept-request, .concept-close, .concept-download, .ready__actions button,
  .notice-action, .save-retry, .general button, .local-disconnect, .local-test, .copy-command, .local-help-link, .local-stop, .local-send) { color:var(--aithema-accent); font-weight:600; }
/* The one filled primary of an area. */
:is(.concept-regenerate, .local-connect) { color:var(--aithema-on-accent); background:var(--aithema-accent); font-weight:600; }
:is(.concept-regenerate, .local-connect):hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-accent) 84%,var(--aithema-ink)); }
/* Toggles: ink text; pressed adds a check in the slot every toggle keeps and turns accent. Weight never changes. */
:is(.concept-up, .concept-down, .concept-guidance-options button)::before { content:'✓' / ''; display:inline-block; width:1.1em; visibility:hidden; }
:is(.concept-up, .concept-down, .concept-guidance-options button)[aria-pressed="true"] { color:var(--aithema-accent); }
:is(.concept-up, .concept-down, .concept-guidance-options button)[aria-pressed="true"]::before { visibility:visible; }

/* The shell (START .shell, .v2__workspace): centred, START's gutters, stacked on phones. */
.workspace { display:grid; grid-template-columns:minmax(0,1fr); grid-template-areas:"top" "conversation" "understanding" "foot";
  gap:.75rem clamp(1rem,2.5vw,2rem); width:100%; max-width:var(--aithema-shell-max); margin-inline:auto; padding:0 var(--aithema-gutter) 1rem; }
.wordmark { margin-right:auto; color:var(--aithema-ink); font:600 24px/1.2 var(--aithema-display); letter-spacing:-.025em; }
.header-actions { display:flex; align-items:center; gap:4px; min-width:0; }
/* Before the conversation starts there is nothing to understand: the column is not there (START data-entry),
   unless a host verification lock needs it for its form. */
.workspace[data-understanding="absent"]:not([data-stage="live"]) .understanding { display:none; }
/* The active preset appears once, in the footer. Feature verdicts remain accessible. */
.preset-panel { min-width:0; }
.features { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; margin:0; padding:0; }
.settings-open { display:grid; place-items:center; width:44px; height:44px; padding:0; border-radius:10px; color:var(--aithema-muted); }
.settings-open:hover:not(:disabled) { color:var(--aithema-ink); background:color-mix(in srgb,var(--aithema-ink) 6%,transparent); }

/* The conversation column (START .v2): quiet header line, then the entrance or the live conversation. */
.conversation { position:relative; min-width:0; display:grid; grid-template-rows:auto; align-content:start; gap:.85rem; }
.head { display:flex; align-items:baseline; justify-content:space-between; gap:.15rem 1.5rem; }
.workspace:not([data-stage="live"]) :is(.audio-rail, .transcript-shell, .composer) { display:none; }
/* Stage visibility wins over later image/phone layout rules in either mount. */
.workspace:not([data-stage="live"]) :is(${CONCEPT_CONTROLS}) { display:none !important; }

/* The conversation rail (START .v2__conversation-rail): orb dock, sound, waveform with one status phrase,
   pause, microphone and end. 44 px controls in fixed cells. */
.audio-rail { position:relative; display:grid; grid-template-columns:48px 44px minmax(0,1fr) 44px 44px 44px; align-items:center; gap:8px; min-height:48px; }
.audio-rail:focus { outline:none; } .audio-rail:focus-visible { outline:2px solid var(--aithema-accent-bright); outline-offset:4px; border-radius:24px; }
.voice-cell { display:grid; } .voice-cell > * { grid-area:1/1; }
.audio-rail button { display:grid; place-items:center; width:44px; height:44px; padding:0; border:1px solid color-mix(in srgb,var(--aithema-line) 70%,transparent);
  border-radius:50%; color:var(--aithema-ink); background:color-mix(in srgb,var(--aithema-surface) 78%,transparent); }
.audio-rail button > * { grid-area:1/1; } .audio-rail button:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-surface) 78%,transparent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--aithema-accent-bright) 13%,transparent); }
.audio-rail button:disabled { opacity:.4; cursor:default; }
.voice-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.icon-slash { stroke-dasharray:24; stroke-dashoffset:24; transition:stroke-dashoffset 180ms ease; }
:is(.voice-input, .voice-output)[aria-pressed="false"] .icon-slash { stroke-dashoffset:0; }
:is(.voice-input, .voice-output)[aria-pressed="false"] { color:var(--aithema-muted); background:color-mix(in srgb,var(--aithema-line) 28%,var(--aithema-surface)); }
.audio-rail :is(.pause, .voice-pause) { color:var(--aithema-paper); background:var(--aithema-ink); border-color:var(--aithema-ink); }
.audio-rail :is(.pause, .voice-pause):hover:not(:disabled) { background:var(--aithema-ink); }
/* Disabled opacity mutes neutral ink; exhausted rails retain their neutral colour. */
.audio-rail button:is(.pause, .voice-pause):disabled { color:var(--aithema-ink); background:color-mix(in srgb,var(--aithema-surface) 50%,transparent); border-color:color-mix(in srgb,var(--aithema-line) 70%,transparent); cursor:not-allowed; }
.voice-icon--resume, :is(.pause, .voice-pause)[aria-pressed="true"] .voice-icon:not(.voice-icon--resume) { visibility:hidden; }
:is(.pause, .voice-pause)[aria-pressed="true"] .voice-icon--resume { visibility:visible; }
.audio-rail .voice-close { color:var(--aithema-error); }
.audio-rail .voice-playback, .audio-rail .voice-playback:hover:not(:disabled) { color:var(--aithema-on-accent); background:var(--aithema-accent); border-color:var(--aithema-accent); }
/* Which control of a shared cell shows: invisible ones are out of the tab order and the accessibility tree. */
.audio-rail:is([data-call="none"]) .voice-input, .audio-rail[data-call="active"] .voice-start,
.audio-rail[data-call="none"] .voice-close, .audio-rail[data-call="active"] .voice-retry, .audio-rail:not([data-state="failed"]) .voice-retry,
.audio-rail[data-playback-blocked] .voice-output, .audio-rail:not([data-playback-blocked]) .voice-playback { visibility:hidden; }
/* Reserve the pause cell only while the ended call reconciles. A paused session
   still offers Resume; hide descendants of unpaused controls because icons set visibility. */
.audio-rail[data-call-reconciling] :is(.pause, .voice-pause):not([aria-pressed="true"]),
.audio-rail[data-call-reconciling] :is(.pause, .voice-pause):not([aria-pressed="true"]) .voice-icon { visibility:hidden; }
/* A purpose pause presents once in the composer. The rail keeps its idle
   speaker and Start call in their normal cells, both disabled. */
.audio-rail[data-purpose-paused] :is(.pause, .voice-pause, .voice-playback, .voice-close, .voice-retry, .voice-input) { visibility:hidden; }
.audio-rail[data-purpose-paused] :is(.voice-start, .voice-output) { visibility:visible; }
.audio-rail[data-purpose-paused] :is(.pause, .voice-pause) .voice-icon--resume { visibility:hidden; }
/* The component's one pause stands in the pause cell: it drives the call and the conversation. */
.conversation .audio-rail .voice-pause { visibility:hidden; }
.voice-signal { position:relative; min-width:0; height:48px; display:grid; place-items:center; }
.voice-signal > * { grid-area:1/1; }
.voice-wave { width:100%; height:48px; opacity:.9; }
.voice-state, .voice-caption { position:relative; z-index:1; max-width:100%; padding:5px 12px; border-radius:999px; font-size:.68rem; line-height:1.25; text-align:center; color:var(--aithema-muted);
  background:color-mix(in srgb,var(--aithema-surface) 94%,transparent); box-shadow:0 0 12px 7px color-mix(in srgb,var(--aithema-surface) 70%,transparent); overflow-wrap:anywhere; }
/* A call message (START keeps errors out of the rail) opens under the rail over the conversation's edge: whole, and it moves
   nothing. It stays under the sticky AI notice line (z-index 3), which is in view wherever an interaction can begin. */
.audio-rail[data-message] .voice-state { position:absolute; z-index:2; top:calc(100% + 6px); left:56px; right:0; padding:.6rem .85rem; border:1px solid var(--aithema-line);
  border-radius:12px; background:var(--aithema-surface); box-shadow:var(--aithema-shadow-raised); text-align:left; font-size:.8rem; line-height:1.45; color:var(--aithema-ink); }
.voice-state:empty, .voice-caption:empty { visibility:hidden; }
/* A live caption takes the pill while words arrive; the state stays readable to assistive technology. */
.voice-signal:has(.voice-caption:not(:empty)) .voice-state { opacity:0; }
.voice-caption { color:var(--aithema-ink); white-space:nowrap; text-overflow:clip; direction:rtl; }
.audio-rail[data-state="failed"][data-message] .voice-state { color:var(--aithema-error); }

/* Notices fill from the top; the permanent reservation leaves free room below them. */
.voice-notices { grid-column:1/-1; min-width:0; display:flex; flex-direction:column; height:108px; font-size:.8rem; line-height:1.4; }
.voice-notice { flex:none; display:flex; align-items:center; gap:12px; min-width:0; min-height:24px; overflow-wrap:anywhere; color:var(--aithema-muted); }
.voice-notice--user { min-height:36px; }
.voice-notice--reply { min-height:48px; color:var(--aithema-ink); }
.voice-notice:empty, .voice-notice--reply:has(> span:empty):has(.voice-repeat[hidden]) { display:none; }
.voice-reply-actions { display:flex; align-items:center; gap:12px; flex:none; }
.voice-reply-actions .voice-repeat { display:inline-grid; align-items:center; flex:none; width:auto; height:auto; min-height:44px; padding:8px 14px; border:1px solid var(--aithema-line); border-radius:10px;
  background:var(--aithema-surface); color:var(--aithema-ink); font-size:.8rem; }
.voice-repeat-label, .voice-repeat::before, .voice-repeat::after { grid-area:1/1; white-space:nowrap; }
.voice-repeat::before { content:attr(data-stop-label); visibility:hidden; }
.voice-repeat::after { content:attr(data-fallback-label); visibility:hidden; }
.voice-reply-actions .voice-read-text { flex:none; width:auto; min-height:44px; padding:8px 0; border:0; background:none;
  color:var(--aithema-muted); font-size:.8rem; text-decoration:underline; text-underline-offset:3px; }
/* An attached row begins at the end of the reply text, with no empty line or box. */
.turn > .turn-text { display:block; }
.turn > .voice-reply-actions { margin:0; padding:0; gap:12px; }
.turn > .voice-reply-actions .voice-repeat { padding:8px 0; border:0; border-radius:0; background:none; color:var(--aithema-muted);
  text-decoration:underline; text-underline-offset:3px; }
.turn > .voice-reply-actions :is(.voice-repeat,.voice-read-text):hover:not(:disabled) { background:none; color:var(--aithema-ink); }
/* Tick v4.1: every reply permanently reserves its own visible 44px control row.
   Pointer hover/focus changes colour only; disabled controls keep their styling. */
.turn > .reply-actions { display:flex; align-items:center; flex:none; height:44px; min-height:44px; margin:0; padding:0; gap:0; }
.turn > .reply-actions > button { display:inline-flex; align-items:center; justify-content:center; flex:none; width:44px; height:44px; min-height:44px;
  padding:0; border:0; border-radius:0; background:none; color:var(--aithema-muted); text-decoration:none; }
.turn > .reply-actions > button svg { width:16px; height:16px; }
.turn > .reply-actions > button::before, .turn > .reply-actions > button::after { content:none; }
@media (hover:hover) and (pointer:fine) {
  .turn > .reply-actions > button:not(:disabled) { color:var(--ink-3,var(--aithema-muted)); }
  .turn:is(:hover,:focus-within) > .reply-actions > button:not(:disabled) { color:var(--aithema-ink); }
}
/* Use the phone transcript's available width and compact bubble insets so
   the permanent 44px controls fit above the card's existing option minimum. */
@media (max-width:600px) {
  .turn:has(> .reply-actions) { --turn-max-width:100%; padding-block:6px; }
  .turn:has(> .reply-actions) > strong { margin-bottom:0; }
}
/* A cleared recovery offer shares the existing reply slot and may retire
   independently. The permanent row owns keyboard/AX access at all times. */
.turn > .voice-reply-actions--recovery { position:absolute; inset-inline-start:.8rem; bottom:.65rem; height:44px; gap:0; }
.turn > .voice-reply-actions--recovery > button { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px;
  padding:0; font-size:0; text-decoration:none; }
.turn > .voice-reply-actions--recovery .voice-repeat-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.turn > .voice-reply-actions--recovery > button::before, .turn > .voice-reply-actions--recovery > button::after { content:none; }
.turn > .voice-reply-actions--recovery > button svg { width:16px; height:16px; }
@media (max-width:600px) { .turn > .voice-reply-actions--recovery { bottom:6px; } }
@media (hover:hover) and (pointer:fine) {
  .turn > .voice-reply-actions--recovery svg { visibility:hidden; }
  .turn:is(:hover,:focus-within) > .voice-reply-actions--recovery svg { visibility:visible; }
  .turn:is(:hover,:focus-within) > .voice-reply-actions--recovery > button:not(:disabled) { color:var(--aithema-ink); }
}
.voice-reply-dialog { width:min(560px,calc(100vw - 32px)); max-height:calc(100dvh - 48px); overflow:auto; padding:24px; border:1px solid var(--aithema-line);
  border-radius:16px; background:var(--aithema-paper); color:var(--aithema-ink); box-shadow:var(--aithema-shadow-raised); }
.voice-reply-dialog::backdrop { background:rgba(0,0,0,.4); }
.voice-reply-dialog h2 { margin:0; font-size:1.1rem; }
.voice-reply-note { color:var(--aithema-muted); font-size:.85rem; }
.voice-reply-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:1rem; line-height:1.5; }
.voice-reply-close { min-height:44px; }
.voice-cell:has(.voice-waiting-help) { position:relative; }
.voice-waiting-help { position:absolute; z-index:11; top:calc(100% + 6px); left:0; width:max-content; padding:8px 10px; border-radius:8px;
  background:var(--aithema-ink); color:var(--aithema-paper); font-size:.75rem; visibility:hidden; pointer-events:none; }
.voice-cell:is(:hover,:focus-visible) .voice-waiting-help:not([hidden]) { visibility:visible; }
.voice-cell--mic .voice-waiting-help { left:auto; right:0; }
.voice-cell:focus-visible { outline:2px solid var(--aithema-accent-bright); outline-offset:3px; border-radius:50%; }
@media(max-width:600px) {
  .voice-notices { height:156px; }
  .voice-notice--user { min-height:44px; }
  .voice-notice--reply { min-height:88px; flex-direction:column; align-items:flex-start; justify-content:center; gap:4px; }
}

/* Concepts: one quiet line under the rail (START keeps concepts out of the conversation's way). */
/* One grid for the line: scene, state, the thumbnail once there is a concept, and Request at the right edge, so the
   thumbnail arriving narrows the state's column and never moves Request. */
 .concept-bar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.5rem; min-height:44px; }
.workspace:not(:has(.audio-rail)) .concept-bar[data-no-drafts] { display:none; }
.concept-rail { display:grid; grid-template-columns:22px minmax(0,1fr); align-items:center; column-gap:.65rem; min-height:44px; }
.concept-scene { grid-area:1/1; width:22px; height:22px; display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.concept-scene i { background:var(--aithema-line-strong); border-radius:2px; }
.concept-activity { grid-area:1/2; min-width:0; display:grid; gap:.2rem; }
.concept-activity-text, .drafts-reason-reserve { grid-area:1/1; font-size:.8125rem; color:var(--aithema-muted); line-height:1.4; }
.drafts-reason-reserve { display:grid; visibility:hidden; pointer-events:none; }
.drafts-reason-reserve > span { grid-area:1/1; }
.drafts-reason-reserve .drafts-withdrawn-reserve { font-size:14px; line-height:1.6; }
.drafts-withdrawn-reserve.narrow { display:none; }
@media(max-width:600px) {
  .drafts-withdrawn-reserve.wide { display:none; }
  .drafts-withdrawn-reserve.narrow { display:block; }
}
.concept-progress, .concept-countdown { display:none; }
.concept-rail[data-phase="pending"] :is(.concept-progress,.concept-countdown) { display:block; }
.concept-request { grid-area:1/2; justify-self:start; min-height:44px; padding:.4rem 0; font-size:.8125rem; line-height:1.4; text-align:left; }
.concept-rail[data-phase="pending"] .concept-request { visibility:hidden; }
.concept-rail:is([data-phase="failed"],[data-phase="waiting"]) .concept-request { grid-area:2/2; }
.concept-rail[data-phase="pending"] .concept-scene i { animation:concept-pulse 1.8s ease-in-out infinite alternate; }
.concept-scene i:nth-child(2n) { animation-delay:-.9s; } @keyframes concept-pulse { to { opacity:.9; } }
.concept-preview-slot { display:grid; }
.concept-preview-slot > * { grid-area:1/1; }
.concept-preview-reserve { visibility:hidden; pointer-events:none; }
:is(.concept-preview,.concept-preview-reserve) { display:flex; align-items:center; gap:.6rem; height:2.75rem; padding:.2rem .5rem; text-align:left; color:var(--aithema-accent); font-weight:600; font-size:.8rem; }
.concept-preview-thumbs { position:relative; width:3.6rem; height:2.3rem; flex:none; overflow:hidden; border:1px solid var(--aithema-line); border-radius:6px; }
.concept-preview img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; transition:opacity 400ms var(--aithema-ease); }
.concept-preview img[data-on] { opacity:1; }
.concept-preview-glyph { width:3.6rem; height:2.3rem; flex:none; display:grid; place-items:center; color:var(--aithema-accent); }
.concept-preview-glyph svg { width:2.4rem; height:auto; }
.concept-preview-text { display:grid; } .concept-preview-text > * { grid-area:1/1; } .concept-preview-sizer { visibility:hidden; }

/* AIT-282: the image access occupies a permanent 44px cell; every state
   overlays that cell. Specificity also preserves the reservation on phones. */
.concept-access { display:contents; }
.concept-fold-slot .concept-access { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-rows:44px; min-height:44px; min-width:0; }
.concept-fold-slot .concept-access > * { grid-row:1; }
.concept-fold-slot .concept-rail { grid-column:1; }
.concept-fold-slot .concept-preview-slot { grid-column:2; }
.concept-withdrawn, .concept-phone-slot { display:none; }
.workspace:not([data-concept-layout="image"]) .concept-bar .concept-rail { grid-area:1/1; }
.concept-fold-slot:empty { display:none; }
.fold-view:has(.concept-fold-slot:not(:empty)) { grid-template-rows:auto 44px minmax(0,1fr); }
.concept-fold-slot .concept-access { visibility:visible; }
/* AIT-385: the notice takes the reserved rail cell; an empty access never paints. */
.concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-rail { visibility:hidden; }
.concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-withdrawn { display:block; grid-area:1/1; align-self:center; font-size:14px; color:var(--aithema-muted); pointer-events:none; }
.concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-preview-slot { visibility:visible; }
.concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-preview:not([hidden]) { visibility:visible !important; }
.concept-preview[hidden] { display:none; }
.concept-withdrawn:focus { outline:none; }
.workspace .concept-access[data-scope-withdrawn] .concept-preview-slot { display:grid; }
@media(min-width:601px) {
  .workspace:not([data-concept-layout="image"]) .concept-bar:has(.concept-access[data-scope-withdrawn]) { grid-template-columns:minmax(0,1fr) auto; }
}
.concept-thread { display:contents; }
.workspace[data-concept-layout="image"] .concept-thread { position:relative; min-height:0; display:grid; grid-template:minmax(0,1fr)/minmax(0,1fr); container-type:size; }
.workspace[data-concept-layout="image"] .concept-thread > .transcript-shell { grid-area:1/1; z-index:1; }
.concept-backdrop { position:absolute; left:0; bottom:0; width:min(66cqw,calc(66cqh * 1.7778)); aspect-ratio:16/9;
  pointer-events:none; overflow:hidden; border-radius:14px;
  mask-image:linear-gradient(to bottom,transparent,#000 64px,#000 calc(100% - 12px),transparent),linear-gradient(to right,transparent,#000 12px,#000 calc(100% - 84px),transparent); mask-composite:intersect; }
.concept-backdrop img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; opacity:0; filter:blur(2px); transition:opacity 400ms var(--aithema-ease); }
.concept-backdrop img[data-on] { opacity:.18; }
:host([theme="dark"]) .concept-backdrop img[data-on] { opacity:.14; }
@media(prefers-color-scheme:dark) { :host(:not([theme="light"])) .concept-backdrop img[data-on] { opacity:.14; } }
.concept-thread[data-near] .concept-backdrop img[data-on] { opacity:.35; filter:none; }
.concept-thread[data-hover] .transcript-shell { cursor:pointer; }
.concept-thread[data-hover] :is(.turn,button,a,input,textarea,select) { cursor:auto; }
.concept-backdrop-hint { position:absolute; z-index:3; pointer-events:none; visibility:hidden; white-space:nowrap;
  padding:7px 11px; border-radius:9px; font-size:13px; background:var(--aithema-surface); color:var(--aithema-ink); box-shadow:var(--aithema-shadow-raised); }
.concept-thread[data-hover] .concept-backdrop-hint[data-show] { visibility:visible; }
.workspace[data-concept-layout="image"] .concept-bar { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:44px; min-height:44px; }
.workspace[data-concept-layout="image"] .concept-access { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:44px; height:44px; min-width:0; }
.workspace[data-concept-layout="image"] .concept-access > * { grid-area:1/1; }
.workspace[data-concept-layout="image"] .concept-preview-slot { display:grid; justify-items:start; visibility:hidden; }
.workspace[data-concept-layout="image"] .concept-rail { grid-template-columns:22px minmax(0,1fr); grid-template-rows:44px; padding-left:0; }
.workspace[data-concept-layout="image"] .concept-rail .concept-activity { display:grid !important; grid-area:1/2; align-self:center; max-height:44px; gap:0; }
.workspace[data-concept-layout="image"] .drafts-reason-reserve { display:none; }
.workspace[data-concept-layout="image"] .concept-rail .concept-request { grid-area:1/2; align-self:center; margin-left:0; }
/* Inline content keeps the priced action immediately after the separator and wraps as one button. */
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-rail { display:block; align-content:center; font-size:.8125rem; line-height:1.4; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-scene { display:none; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-rail .concept-activity { display:inline !important; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-activity-text::after { content:"${reasonSeparator}"; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-activity-text { white-space:normal; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-request { display:inline-block; position:relative; min-height:0; padding:0; white-space:nowrap; vertical-align:baseline; }
.workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-request::after { content:''; position:absolute; inset:50% 0 auto; height:44px; transform:translateY(-50%); }
@media(600px < width <= 64rem) {
  .workspace[data-concept-layout="image"] .concept-access[data-state="err"] .concept-activity::after { content:''; display:block; }
}
.workspace[data-concept-layout="image"] .concept-access:is([data-state="ready"],[data-state="gone"],[data-state="none"],[data-state="empty"]) .concept-rail { visibility:hidden; }
.workspace[data-concept-layout="image"] .concept-access[data-state="gen"] .concept-activity { visibility:hidden; }
.workspace[data-concept-layout="image"] .concept-access[data-state="ready"] .concept-preview-slot { visibility:visible; }
.workspace[data-concept-layout="image"] .concept-access[data-state="gone"] .concept-withdrawn { display:block; align-self:center; font-size:14px; color:var(--aithema-muted); }
.workspace[data-concept-layout="image"] .concept-access:not([data-state="ready"]) .concept-preview { visibility:hidden !important; }
.workspace[data-concept-layout="image"] .concept-access[data-state="ready"] :is(.concept-preview,.concept-preview-reserve) { padding:0 12px 0 0; gap:12px; }
.workspace[data-concept-layout="image"] .concept-preview-thumbs { width:56px; height:32px; }
.workspace[data-concept-layout="image"] .concept-thread .transcript-shell { padding-bottom:calc(40px + var(--aithema-slack-bottom,0px)); }
.concept-bottom { position:absolute; z-index:0; left:14px; bottom:3px; width:min(calc(66cqw - 14px),calc(66cqh * 1.7778 - 14px)); display:grid; gap:6px; visibility:hidden; pointer-events:none; }
.concept-bottom[data-state="gen"] { visibility:visible; }
.concept-bottom-label { font-size:13px; line-height:16px; color:var(--aithema-muted); white-space:nowrap; }
.concept-bottom progress { appearance:none; width:100%; height:2px; border:0; background:var(--aithema-line); }
.concept-bottom progress::-webkit-progress-bar { background:var(--aithema-line); }
.concept-bottom progress::-webkit-progress-value { background:var(--aithema-accent); }
.concept-bottom progress::-moz-progress-bar { background:var(--aithema-accent); }
.workspace:not([data-concept-layout="image"]) :is(.concept-backdrop,.concept-bottom,.concept-backdrop-hint) { display:none; }
/* Below the two-column layout, size containment needs the same explicit
   block size as the existing bounded transcript. Otherwise it overlaps input. */
@media(600px < width < 60rem) {
  .workspace[data-concept-layout="image"] .concept-thread { height:clamp(20rem,60svh,36rem); }
}
@media(max-width:600px) {
  .workspace[data-concept-layout="image"] .concept-bar { position:absolute; visibility:hidden; pointer-events:none; height:0; min-height:0; }
  .workspace[data-concept-layout="image"] .composer-dock { padding-top:44px; }
  .workspace[data-concept-layout="image"] .concept-phone-slot { display:block; position:absolute; left:0; right:0; bottom:calc(100% + var(--question-card-height,0px) - 44px); height:44px; }
  .workspace[data-concept-layout="image"] .composer-dock > .qcard { bottom:calc(100% - 44px); }
  .workspace[data-concept-layout="image"] .concept-access { visibility:visible; }
  .workspace[data-concept-layout="image"] .concept-rail { grid-template-columns:56px minmax(0,1fr); }
  .workspace[data-concept-layout="image"] .concept-access[data-state="gen"] .concept-scene { width:56px; height:32px; grid-template-columns:6px 6px; grid-template-rows:6px 6px; justify-content:center; align-content:center; border-radius:6px; background:color-mix(in srgb,var(--aithema-ink) 5%,transparent); }
  .workspace[data-concept-layout="image"] .concept-preview-slot { padding-left:0; }
  .workspace[data-concept-layout="image"] :is(.concept-backdrop,.concept-backdrop-hint) { display:none; }
  .workspace[data-concept-layout="image"] .concept-thread { container-type:normal; }
  .workspace[data-concept-layout="image"] .concept-bottom { position:static; width:auto; align-self:center; margin-left:66px; }
  .workspace[data-concept-layout="image"] .concept-access[data-state="err"] :is(.concept-activity-text,.concept-request) { font-size:13px; line-height:17px; }
}
:host([motion="off"]) :is(.concept-backdrop,.concept-preview) img { transition:none; }
@media(prefers-reduced-motion:reduce) { :is(.concept-backdrop,.concept-preview) img { transition:none; } }

/* The transcript (START .v2__transcript): tailed bubbles on the page, reading position kept by hand. */
.transcript-shell { position:relative; margin-top:var(--transcript-top-inset,0px); min-height:0; overflow:auto; overflow-anchor:none; overscroll-behavior-y:contain; scrollbar-gutter:stable;
  scrollbar-width:thin; scrollbar-color:transparent transparent;
  /* Fade only the real top edge; retain just enough inset for the first row. */
  mask-image:linear-gradient(to bottom,transparent 0,#000 8px);
  padding:calc(8px + var(--aithema-slack-top,0px)) .75rem calc(1.5rem + var(--aithema-slack-bottom,0px)) .6rem; }
.transcript-latest { position:sticky; bottom:0; display:block; margin:.6rem auto 0; font-size:.75rem; border-radius:999px;
  background:var(--aithema-surface); box-shadow:var(--aithema-shadow-raised); }
ol { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:.5rem; font-size:.95rem; }
.turn { --turn-max-width:78%; position:relative; max-width:var(--turn-max-width); align-self:flex-start; padding:.65rem .8rem; line-height:1.45; overflow-wrap:anywhere;
  border:1px solid color-mix(in srgb,var(--aithema-line) 70%,transparent); border-radius:.75rem;
  background:color-mix(in srgb,var(--aithema-ink) 7%,var(--aithema-paper)); box-shadow:0 1px 3px color-mix(in srgb,var(--aithema-ink) 10%,transparent);
  animation:turn-in 220ms ease-out; }
/* START's tails, in the bubble's own fill and edge. */
.turn::before { content:''; position:absolute; left:-.45rem; top:.85rem; width:.75rem; height:.75rem; background:inherit; transform:rotate(45deg);
  border-left:1px solid color-mix(in srgb,var(--aithema-line) 70%,transparent); border-bottom:1px solid color-mix(in srgb,var(--aithema-line) 70%,transparent);
  clip-path:polygon(0 0,0 100%,100% 100%); }
.turn.user { align-self:flex-end; background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-paper));
  border-color:color-mix(in srgb,var(--aithema-accent) 32%,transparent); box-shadow:0 2px 6px color-mix(in srgb,var(--aithema-accent) 20%,transparent); }
.turn.user::before { left:auto; right:-.45rem; border:0; border-right:1px solid color-mix(in srgb,var(--aithema-accent) 32%,transparent);
  border-top:1px solid color-mix(in srgb,var(--aithema-accent) 32%,transparent); clip-path:polygon(100% 0,0 0,100% 100%); }
.turn strong { display:flex; align-items:center; gap:6px; margin-bottom:.15rem; font-size:.72rem; font-weight:600; color:var(--aithema-muted); }
.turn strong { position:relative; }
.turn .voice-interruption { position:absolute; inset-inline-end:0; top:0; display:inline-flex; align-items:center; gap:4px;
  color:var(--ink-3,var(--aithema-muted)); font-weight:400; white-space:nowrap; cursor:help; }
.voice-interruption svg { flex:none; }
.turn .voice-interruption-tooltip { display:none; position:absolute; top:calc(100% + 6px); inset-inline-end:0;
  z-index:10; width:max-content; max-width:min(270px,65vw); padding:7px 9px; border:1px solid var(--aithema-line);
  border-radius:6px; background:var(--aithema-paper); color:var(--aithema-ink); font-size:.75rem; line-height:1.4; white-space:normal; font-weight:400; }
.voice-interruption:is(:hover,:focus-visible) .voice-interruption-tooltip { display:block; }
.speaker-sign { display:inline-grid; place-items:center; width:12px; height:12px; flex:none; border-radius:50%; background:radial-gradient(circle at 35% 35%,#fff,var(--aithema-accent-soft) 45%,color-mix(in srgb,var(--aithema-accent) 50%,var(--aithema-surface))); }
.user .speaker-sign { background:none; } .speaker-sign svg { width:12px; height:12px; }
.turn.user { padding-right:2.8rem; }
.turn span { white-space:pre-wrap; } .turn.partial { color:var(--aithema-muted); }
.turn[data-voice-transcript] { animation:none; }
.turn[data-voice-transcript="partial"] { min-height:var(--voice-min-height,0px); min-width:min(var(--voice-min-width,0px),var(--turn-max-width)); }
.turn.user.partial { border-color:transparent; box-shadow:none; background:color-mix(in srgb,var(--aithema-accent) 5%,var(--aithema-paper)); }
.turn.user.partial::before { border-color:transparent; }
.voice-provisional { font-weight:400; }
@keyframes turn-in { from { transform:translateY(.35rem); } to { transform:none; } }
/* START's 20 px x in a reserved 44 px target: opacity changes, geometry does not. */
.withdraw { position:absolute; top:0; right:0; display:grid; place-items:center; width:44px; height:44px; padding:0; color:var(--aithema-ink); opacity:0; background:none; }
.withdraw svg { width:20px; height:20px; }
.turn:hover .withdraw, .turn:focus-within .withdraw { opacity:.55; }
.turn .withdraw:is(:hover,:focus-visible) { opacity:1; background:none; }
@media(hover:none) { .turn .withdraw { opacity:.55; } }
.upload-withdraw { display:block; margin-top:.3rem; font-size:.72rem; padding:.2rem 0; color:var(--aithema-muted); text-decoration:underline;
  text-decoration-color:color-mix(in srgb,currentColor 40%,transparent); text-underline-offset:3px; }
.upload-withdraw:hover:not(:disabled) { background:none; color:var(--aithema-ink); text-decoration-color:currentColor; }

/* The composer (START .v2__composer): one raised card, one focus ring, 44 px round actions. */
.composer { position:relative; display:grid; gap:.5rem; padding:clamp(.85rem,2vw,1.25rem); border:1px solid var(--aithema-line); border-radius:var(--aithema-radius-lg);
  background:color-mix(in srgb,var(--aithema-surface) 88%,transparent); box-shadow:var(--aithema-shadow-raised); backdrop-filter:blur(20px) saturate(1.2); }
.composer:focus-within { border-color:var(--aithema-accent); box-shadow:var(--aithema-shadow-raised),0 0 0 3px color-mix(in srgb,var(--aithema-accent-bright) 20%,transparent); }
.composer label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
textarea { resize:none; width:100%; min-height:3.5rem; height:3.5rem; border:0; outline:0; background:transparent; color:var(--aithema-ink); padding:.25rem .5rem; font-size:1rem; line-height:1.5; }
/* Absolute copy occupies the existing field slot; textarea and Send keep their boxes. */
.composer-paused { position:absolute; top:clamp(.85rem,2vw,1.25rem); left:calc(clamp(.85rem,2vw,1.25rem) + .5rem); right:clamp(.85rem,2vw,1.25rem);
  min-height:44px; display:flex; align-items:center; gap:.35em; color:var(--aithema-muted); font-size:1rem; line-height:1.5; }
.composer-paused[hidden] { display:none; }
.composer-resume { min-height:44px; min-width:44px; padding:0; color:var(--aithema-accent); background:none; border-radius:0; font:inherit; font-weight:500; }
.composer-resume:hover:not(:disabled), .composer-resume:focus-visible { background:none; text-decoration:underline; text-underline-offset:3px; }
.purpose-pause-copy { position:absolute; inset:clamp(.85rem,2vw,1.25rem) clamp(.85rem,2vw,1.25rem) calc(clamp(.85rem,2vw,1.25rem) + 44px + .25rem); overflow:auto;
  padding:.15rem .5rem; font-size:.8rem; line-height:1.2; color:var(--aithema-muted); }
.purpose-new { position:absolute; right:clamp(.85rem,2vw,1.25rem); bottom:clamp(.85rem,2vw,1.25rem); min-height:44px;
  padding:0 16px; border-radius:12px; font-size:.875rem; color:var(--aithema-ink); border:1px solid var(--aithema-line); background:var(--aithema-surface); }
.composer-shell[data-purpose-paused] .composer-actions { visibility:hidden; }
textarea:focus-visible { outline:0; }
textarea::placeholder { color:var(--aithema-muted); opacity:1; }
.composer-actions { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.composer-actions small { font-size:.72rem; color:var(--aithema-muted); }
/* A long reason wraps to a second line rather than ending in "…"; a longer upload refusal scrolls in its two lines. */
.composer-reason { flex:1; min-width:0; line-height:1.3; max-height:2.6em; overflow-wrap:anywhere; overflow-y:auto; overscroll-behavior:contain; }
/* A resumed call retains its held hint's slot. Ordinary shortcuts keep the
   compact confirmation width; all variants share the existing row height. */
.composer-feedback { display:grid; flex:1; margin-right:auto; min-width:0; align-items:center; align-self:stretch; }
.composer-feedback:not([data-voice-space]):has(.composer-reason[data-shortcut]) { flex:0 1 auto; }
.composer-feedback > :not(.sr-only) { grid-area:1/1; }
.composer-reason { transition:opacity 120ms ease; }
.composer-reason kbd { font:inherit; padding:0 .2em; border:1px solid var(--aithema-line-strong); border-radius:3px; }
.composer-saved, .composer-saved-sizer { display:flex; align-items:center; gap:.35em; width:max-content; max-width:100%; line-height:1.3; }
.composer-saved svg, .composer-saved-sizer svg { width:14px; height:14px; }
.composer-saved-sizer { visibility:hidden; }
.composer-saved { opacity:0; pointer-events:none; transition:opacity 120ms ease; }
.composer-feedback[data-saved] .composer-reason { opacity:0; pointer-events:none; }
.composer-feedback[data-saved] .composer-saved { opacity:1; }
@media(hover:none), (pointer:coarse) {
  .composer-reason[data-shortcut] { position:absolute; visibility:hidden; width:0; overflow:hidden; }
  .composer-feedback[data-voice-space] .composer-reason[data-shortcut] { position:static; width:auto; }
}
@media(prefers-reduced-motion:reduce) { .composer-reason, .composer-saved { transition:none; } }
/* Leave paint room for the shared action's 3px underline offset inside the scroll port. */
.composer-reason:has(.upload-discard) { display:flex; flex-direction:column; max-height:44px; line-height:1.25; padding-bottom:3px; overflow:visible; }
.upload-retry-copy { min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.upload-retry-actions { flex:none; }
.composer-reason[data-send-failed] { max-height:none; overflow:visible; }
.composer-reason[data-send-failed]:has(.upload-discard) { padding-bottom:8px; }
.composer-reason[data-send-failed] .upload-retry-copy { flex:none; overflow:visible; }
.composer-reason[data-send-failed] .upload-retry-actions { white-space:nowrap; }
.send-failure-short { display:none; }
.send-failure-short::before { content:attr(data-text); }
@media(width < 600px) {
  .send-failure-short { display:inline; }
  /* Visually omit the retry sentence, while the polite region retains it. */
  .composer-reason[data-send-failed] :is(.send-failure-first,.send-failure-detail) { position:absolute; width:1px; height:1px;
    padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
}
.upload-retry-copy[data-consent-feature] { display:flex; flex:none; gap:.25em; overflow:visible; }
.upload-retry-copy .consent-line-copy { min-width:0; max-height:1.25em; overflow-y:auto; }
.upload-retry-copy .consent-action { flex:none; }
/* AIT-274's status markup, with warning ink confined to the failure sentence. */
:is(.composer-reason,.concept-activity-text) .question-status { display:inline-flex; align-items:center; gap:7px; height:auto; vertical-align:baseline; }
:is(.composer-reason,.concept-activity-text) .question-status svg { flex:none; width:14px; height:14px; align-self:center; }
:is(.composer-reason,.concept-activity-text) .warning, :is(.composer-reason,.concept-activity-text) .warning .question-why { color:var(--aithema-warning); }
.composer-reason .question-status { white-space:nowrap; }
.composer-reason:has(> .consent-action) { max-height:44px; overflow:visible; }
.composer-reason[data-consent-feature="text"] { font-size:max(12px,.72rem); max-height:none; overflow:visible; }
.composer-reason[data-consent-feature="text"] .consent-narrow { display:none; }
@media(max-width:340px) {
  /* Reclaim only gaps: Attach and Send keep their normal positions. */
  .composer-actions:has(.composer-reason[data-consent-feature="text"]) { gap:0; }
  .composer-actions:has(.composer-reason[data-send-failed]) { gap:0; }
  .composer-reason[data-send-failed] { letter-spacing:-.03em; }
  .composer-reason[data-send-failed] .consent-action { letter-spacing:inherit; }
  /* Keep the 12px DE label on one line with the wider Linux baseline font. */
  .composer-reason[data-consent-feature="text"] { letter-spacing:-.03em; }
  .composer-reason[data-consent-feature="text"] .consent-wide { display:none; }
  .composer-reason[data-consent-feature="text"] .consent-narrow { display:inline; }
}
/* Keep the 44px target inside its text column, clear of Attach and Send. */
.composer-reason[data-consent-feature="text"] > .consent-action::after { left:0; width:max(100%,44px); height:max(100%,44px); }
@media(hover:none), (pointer:coarse) {
  .composer-reason[data-consent-feature] > .consent-action::after, .upload-retry-copy[data-consent-feature] > .consent-action::after { height:max(100%,44px); }
}
.attach, .send { display:grid; place-items:center; flex:none; width:44px; height:44px; padding:0; border-radius:22px; }
.attach { color:var(--aithema-muted); border:1px solid var(--aithema-line); } .attach svg { width:20px; height:20px; }
.attach__label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.attach[aria-disabled="true"] { opacity:.5; cursor:not-allowed; } .attach[aria-disabled="true"]:hover { background:none; }
.send { color:var(--aithema-on-accent); background:var(--aithema-accent); }
.send:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-accent) 84%,var(--aithema-ink)); }
/* Dropping files: an overlay over the conversation that never takes layout space. */
.drop-overlay { position:absolute; inset:.5rem; z-index:4; display:grid; place-items:center; padding:1rem; text-align:center; pointer-events:none; visibility:hidden;
  border:2px dashed var(--aithema-accent); border-radius:var(--aithema-radius-md); background:color-mix(in srgb,var(--aithema-surface) 94%,transparent); }
.conversation[data-dropping] .drop-overlay { visibility:visible; }
.drop-overlay p { margin:0; display:grid; gap:.3rem; } .drop-overlay strong { color:var(--aithema-accent); } .drop-overlay span { font-size:.8rem; color:var(--aithema-muted); }
/* An upload in the transcript (GUI-27, not a pill): glyph, name and Withdraw upload; then muted size and state.
   Fixed width and slots: a state change or withdrawal never moves the name or the action, nor resizes the row. */
.upload { align-self:flex-end; width:min(34rem,78%); display:grid; grid-template-columns:1.25rem 4.5rem minmax(0,1fr) auto;
  grid-template-rows:1.6rem auto; grid-template-areas:"glyph name name action" "glyph size state state"; column-gap:.5rem; padding:.15rem 0; overflow-wrap:anywhere; }
.upload:focus { outline:none; } .upload:focus-visible { outline:2px solid var(--aithema-accent); outline-offset:3px; }
.upload__glyph { grid-area:glyph; color:var(--aithema-muted); padding-top:.1rem; }
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

/* Understanding (START .v2__analysis): a card beside the conversation, absent until the first input. */
.understanding { --inset:clamp(.9rem,2vw,1.35rem); position:relative; min-width:0; display:grid; grid-template-rows:auto auto minmax(0,1fr) auto; overflow:hidden;
  padding:var(--inset); border:1px solid var(--aithema-line); border-radius:var(--aithema-radius-lg); background:color-mix(in srgb,var(--aithema-surface) 70%,transparent); }
.understanding > .head { align-items:center; min-height:2.8rem; }
.understanding h2 { font-size:.75rem; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--aithema-muted); }
.concept-tab { display:inline-flex; align-items:center; min-height:2.75rem; font-size:.78rem; }
/* Unread is a filled dot in a slot the tab always keeps, never an edge line. */
.concept-tab::before { content:''; display:inline-block; width:.45rem; height:.45rem; margin-right:.45rem; border-radius:50%; background:transparent; }
.concept-tab[data-unread="true"]::before { background:var(--aithema-accent); }
.readiness { display:grid; gap:.05rem; padding:.25rem 0 1rem; border-bottom:1px solid color-mix(in srgb,var(--aithema-line) 82%,transparent); }
.scale { position:relative; height:.72rem; margin:.28rem 0 .08rem; border:1px solid color-mix(in srgb,var(--aithema-muted) 22%,transparent); border-radius:999px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--aithema-accent-bright) 10%,var(--aithema-surface)) 0 30%,color-mix(in srgb,var(--aithema-amber) 12%,var(--aithema-surface)) 100%);
  box-shadow:inset 0 1px 2px color-mix(in srgb,var(--aithema-ink) 10%,transparent); }
.fill { display:block; width:0; height:100%; border-radius:inherit; transition:width 260ms ease;
  background:linear-gradient(90deg,color-mix(in srgb,var(--aithema-accent-bright) 92%,var(--aithema-ink)) 0%,var(--aithema-accent-bright) 58%,color-mix(in srgb,var(--aithema-accent-bright) 70%,var(--aithema-amber)) 100%); }
/* START's two markers: talking (where the host sets it) and building (the end). */
.marker, .scale::after { position:absolute; top:50%; width:.76rem; height:.76rem; border:2px solid var(--aithema-surface); border-radius:50%; transform:translate(-50%,-50%);
  background:var(--aithema-accent-bright); box-shadow:0 0 0 1px color-mix(in srgb,var(--aithema-accent-bright) 42%,var(--aithema-line)); }
.scale::after { content:''; left:calc(100% - .4rem); background:var(--aithema-amber); box-shadow:0 0 0 1px color-mix(in srgb,var(--aithema-amber) 50%,var(--aithema-line)); }
.scale-labels { display:flex; justify-content:space-between; height:1.4rem; font-size:.72rem; color:var(--aithema-muted); }
.analysis-content { min-height:0; overflow:auto; overflow-anchor:none; overscroll-behavior-y:contain; scrollbar-gutter:stable; overflow-wrap:anywhere;
  scrollbar-width:thin; scrollbar-color:transparent transparent;
  scroll-padding-block:28px 44px;
  display:grid; align-content:start; gap:1.15rem; padding:calc(28px + var(--aithema-slack-top,0px)) .75rem calc(44px + var(--aithema-slack-bottom,0px)) 0; }
/* Completed/draft labels keep their live status without a row or grid gap. */
.analysis-content:has(> .notice[data-assessment]) { padding-top:calc(1rem + var(--aithema-slack-top,0px)); }
.notice[data-assessment] { position:absolute; width:1px; height:1px; min-height:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.notice[data-current] .notice-text { visibility:hidden; }
.notice, .reaction-failure { min-height:2.9em; margin:0; font-size:.8rem; line-height:1.45; color:var(--aithema-muted); }
.analysis-content section { scroll-margin-block:28px 44px; display:grid; gap:.55rem; padding-top:1rem; border-top:1px solid var(--aithema-line); }
/* Readiness already draws the entry divider; keep the section's box stable. */
.analysis-content > section:nth-child(1 of section:not([hidden])) { border-top-color:transparent; }
.analysis-content section.summary { padding-top:0; border-top:0; } .analysis-content section.summary h3 { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.summary-text { margin:0; font-size:1rem; line-height:1.55; color:var(--aithema-ink); text-wrap:pretty; }
.analysis-content h3 { font-size:.86rem; font-weight:700; color:var(--aithema-ink); }
.analysis-content ul { display:grid; gap:.45rem; margin:0; padding:0; list-style:none; }
.analysis-content li { position:relative; padding-inline-start:1rem; font-size:.8125rem; line-height:1.45; color:var(--aithema-muted); }
.analysis-content li::before { content:''; position:absolute; top:.55em; left:0; width:.35rem; height:.35rem; border-radius:50%; background:var(--aithema-accent-bright); }
/* AIT-274: Tick's reserved question state line and heading notice slot. */
.open-questions { --clarify-tint:9%; --clarify-hover:10%; gap:2px !important; }
:host([theme="dark"]) .open-questions { --clarify-tint:11%; --clarify-hover:13%; }
@media(prefers-color-scheme:dark) { :host(:not([theme="light"])) .open-questions { --clarify-tint:11%; --clarify-hover:13%; } }
.questions-heading { display:grid; align-items:end; min-height:calc(13px * 1.45); }
.questions-heading > * { grid-area:1/1; }
.question-notice { display:flex; align-items:flex-start; gap:7px; margin:0; color:var(--aithema-muted); font-size:13px; line-height:1.45; }
.question-notice svg { width:13px; height:13px; margin-top:.2em; }
.question-notice:not([data-on]) { visibility:hidden; }
.questions-heading:has(.question-notice[data-on]) h3 { visibility:hidden; }
.analysis-content .questions { gap:2px; container-type:inline-size; }
.analysis-content .open-question { display:grid; grid-template-columns:6px minmax(0,1fr); column-gap:12px; padding:7px 10px 0; margin-inline:-10px; border-radius:12px; }
.open-question::before { background:var(--aithema-amber) !important; position:static !important; width:6px !important; height:6px !important; margin-top:.62em; }
.question-text { font-size:14.5px; line-height:1.45; color:var(--aithema-ink); text-wrap:pretty; }
.question-state { grid-column:2; display:flex; align-items:center; height:36px; min-width:0; font-size:13.5px; line-height:1.3; white-space:nowrap; }
.open-question:is([data-state="selected"],[data-state="retry"]) { background:color-mix(in srgb,var(--aithema-accent) var(--clarify-tint),transparent); }
.clarify-action, .question-status { display:inline-flex; align-items:center; gap:7px; height:36px; }
.clarify-action { position:relative; padding:0 9px; margin-left:-9px; border-radius:8px; color:var(--aithema-accent); font-weight:600; }
.clarify-action::after { content:''; position:absolute; inset:-4px 0; }
.clarify-action:hover:not([aria-disabled="true"]) { background:color-mix(in srgb,var(--aithema-accent) var(--clarify-hover),transparent); }
.clarify-action[aria-disabled="true"] { cursor:default; background:transparent; }
.clarify-action svg, .question-status svg { width:14px; height:14px; }
.clarify-icon:empty { display:none; }
.question-separator { padding:0 7px; color:var(--aithema-muted); }
.question-why { color:var(--aithema-muted); overflow:hidden; text-overflow:ellipsis; }
.question-failed-short { display:none; }
.open-question[data-state="disabled"] .clarify-action { color:color-mix(in srgb,var(--aithema-muted) 72%,transparent); font-weight:500; }
.open-question[data-state="requesting"] .clarify-action { color:var(--aithema-ink); font-weight:500; }
.open-question:is([data-state="requesting"],[data-state="selected"]) .clarify-action svg { color:var(--aithema-accent); }
.open-question[data-state="selected"] .clarify-action { color:var(--aithema-ink); font-weight:600; }
.open-question[data-state="asked"] .clarify-action { color:var(--aithema-muted); font-weight:500; }
.open-question:is([data-state="retry"],[data-state="refused"]) .question-status { min-width:0; color:var(--aithema-muted); }
.open-question[data-state="retry"] .question-status svg { color:var(--aithema-warning); }
.clarify-spin { animation:clarify-spin .9s linear infinite; }
@keyframes clarify-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .clarify-spin { animation:none; } }
@container(max-width:360px) {
  .question-state { font-size:13px; }
  .question-separator { padding:0 6px; }
}
@container(max-width:316px) {
  .question-failed-long { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .question-failed-short { display:inline; }
}
/* The focused assistant reply links to the public question, without another turn. */
.clarify-meta { position:relative; display:flex; align-items:center; gap:8px; min-width:0; max-width:100%; margin:1px 0 5px; color:var(--aithema-muted); font-size:13.5px; line-height:1.45; text-decoration:none; }
.clarify-meta::after { content:''; position:absolute; inset:-13px -6px; }
.clarify-dot { width:6px; height:6px; border-radius:50%; background:var(--aithema-amber); flex:none; }
.clarify-meta-label { flex:none; }
.turn .clarify-meta-question { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-decoration:underline; text-underline-offset:3px; }
.clarify-meta:hover { color:var(--aithema-ink); }
@media(max-width:599px) {
  .question-text { font-size:15px; }
  .questions-heading { min-height:calc(13px * 1.45 * 2); }
  .clarify-meta { font-size:13px; }
}
.missing li::before, li.none-yet::before { content:none; } .none-yet { color:var(--aithema-muted); } li.none-yet { padding-inline-start:0; }
.missing li { padding:.15rem 0; } .missing strong { display:block; font-size:.72rem; font-weight:650; color:var(--aithema-muted); } .missing span { display:block; color:var(--aithema-ink); }
.overflow { margin:0; font-size:.75rem; color:var(--aithema-muted); } .overflow:empty { display:none; }
.cleared-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.expand { min-width:6.5rem; padding:.4rem .5rem; font-size:.75rem; color:var(--aithema-muted); font-weight:500; }
.cleared { display:grid; gap:.25rem; }
details { font-size:.8125rem; } details p { margin:0; padding:.32rem .5rem .5rem 1.6rem; color:var(--aithema-muted); line-height:1.45; }
summary { display:grid; grid-template-columns:1rem minmax(0,1fr) auto; align-items:center; gap:.55rem; min-height:2.5rem; padding:.4rem .5rem; border-radius:.4rem;
  color:var(--aithema-ink); font-weight:600; cursor:pointer; list-style:none; }
summary::-webkit-details-marker { display:none; }
summary::before { content:''; width:1rem; height:1rem; background:var(--aithema-accent-bright);
  mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m5 12 4 4 10-11' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat; }
summary::after { content:''; width:.45rem; height:.45rem; margin:0 .25rem .2rem; border-right:1.5px solid var(--aithema-muted); border-bottom:1.5px solid var(--aithema-muted); transform:rotate(45deg); }
details[open] summary::after { transform:rotate(225deg); }
summary:hover { background:color-mix(in srgb,var(--aithema-accent-soft) 50%,transparent); }
blockquote { margin:.5rem 0 0; padding-left:.7rem; border-left:0; color:var(--aithema-muted); }
.overview-retry, .reaction-failure > .retry { display:inline; padding:0; border:0; background:none; color:inherit; font:inherit; text-decoration:underline; text-underline-offset:.15em; cursor:pointer; }
.understanding > .foot { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; column-gap:1rem; row-gap:0; min-height:3.25rem; padding-top:.75rem; border-top:1px solid var(--aithema-line); }
.export { white-space:nowrap; flex:none; }
.export, .create-project { display:inline-flex; align-items:center; gap:.5rem; min-height:2.75rem; font-size:.78rem; color:var(--aithema-muted); text-underline-offset:.22em; }
.understanding > .foot > .export { grid-area:1/1; justify-self:start; }
.understanding > .foot > :is(.create-project,.retry) { grid-area:1/2; justify-self:end; }
/* Invisible in server modes, but always measured so mode switches move nothing. */
.export-reason { grid-column:1/-1; font-size:.72rem; line-height:1.4; color:var(--aithema-muted); }
.export[href] { text-decoration:underline; }
.export[aria-disabled="true"] { text-decoration:none; cursor:help; }
@media(width < 480px) {
  .understanding > .foot { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:2.75rem auto 2.75rem; gap:0; }
  .understanding > .foot > .export { grid-area:1/1; white-space:nowrap; }
  .understanding > .foot > .export-reason { grid-area:2/1; }
  .understanding > .foot > :is(.create-project,.retry) { grid-area:3/1; justify-self:start; margin-inline-start:0; white-space:nowrap; }
}
.create-project { margin-inline-start:auto; padding:0; border-radius:0; text-align:start; text-decoration:underline; }
/* Reserve the action slot until the overview can become a project. */
.understanding:not([data-overview="current"]) > .foot > .create-project { visibility:hidden; }
.export:hover, .create-project:hover { color:var(--aithema-accent); background:transparent; }
.export svg, .create-project svg { flex:none; width:1rem; height:1rem; } .retry { font-size:.75rem; white-space:nowrap; }

/* Neutral scrollbars only during interaction. A stable gutter prevents hover from changing line wraps. */
:is(.transcript-shell,.analysis-content):is(:hover,:focus-within,[data-scrolling]) { scrollbar-color:var(--aithema-line-strong) transparent; }
:is(.transcript-shell,.analysis-content)::-webkit-scrollbar { width:6px; }
:is(.transcript-shell,.analysis-content)::-webkit-scrollbar-thumb { border-radius:4px; background:transparent; }
:is(.transcript-shell,.analysis-content):is(:hover,:focus-within,[data-scrolling])::-webkit-scrollbar-thumb { background:var(--aithema-line-strong); }
.analysis-content[data-bottom] { mask-image:linear-gradient(to bottom,#000 calc(100% - 44px),transparent); }
.analysis-content[data-top] { mask-image:linear-gradient(to bottom,transparent,#000 26px); }
.analysis-content[data-top][data-bottom] { mask-image:linear-gradient(to bottom,transparent,#000 26px,#000 calc(100% - 44px),transparent); }

/* The concept viewer: START's immersive surface on the page's own paper. */
.concept-viewer { position:fixed; inset:0; margin:0; width:100vw; max-width:none; height:100dvh; max-height:none; padding:0; border:0;
  color:var(--aithema-ink); background:var(--aithema-paper); background-image:var(--aithema-lighting); overflow:hidden; font:1rem/1.5 var(--aithema-font); }
.concept-viewer[open] { display:grid; grid-template-rows:4rem minmax(0,1fr) 12.5rem; }
.concept-viewer::backdrop { background:var(--aithema-ink); }
.concept-viewer-head { display:grid; grid-template-columns:minmax(0,1fr) 5rem minmax(9rem,13rem); align-items:center; gap:1rem; padding:.5rem 1rem; }
/* The title wraps to two lines rather than hiding its end. */
.concept-viewer-head h2 { font:400 clamp(1.15rem,2vw,1.55rem)/1.2 var(--aithema-display); max-height:2.4em; overflow:hidden; overflow-wrap:anywhere; }
.concept-count { font-size:.8rem; color:var(--aithema-muted); font-variant-numeric:tabular-nums; }
.concept-stage { position:relative; min-height:0; display:grid; place-items:center; padding:1rem; }
.concept-image { width:100%; height:100%; min-height:0; object-fit:contain; border-radius:clamp(.9rem,2vw,1.35rem); }
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

/* Wide screens (START ≥ 60rem): conversation and understanding side by side, each pane fits the viewport and
   scrolls on its own. Before the first input the second column is not there; it arrives from the right. */
@media(min-width:60rem) {
  .workspace { grid-template-columns:minmax(0,1.55fr) minmax(22rem,.88fr); grid-template-areas:"top top" "conversation understanding" "foot foot"; }
  .workspace[data-understanding="absent"] { grid-template-columns:minmax(0,1fr) minmax(0,0fr); column-gap:0; }
  /* START's reveal runs only while the column opens (data-reveal): a resize, a reload or a theme change never animates. */
  .workspace[data-reveal] { transition:grid-template-columns 560ms var(--aithema-ease),column-gap 560ms var(--aithema-ease); }
  .workspace[data-reveal] .understanding { transition:opacity 420ms ease 120ms,transform 520ms var(--aithema-ease) 100ms,padding 480ms ease,border-width 300ms ease; }
  .workspace[data-understanding="absent"] .understanding { min-width:0; padding-inline:0; border-width:0; opacity:0; transform:translateX(1.75rem); }
  .workspace[data-stage="live"] { height:var(--aithema-height); min-height:34rem; grid-template-rows:auto minmax(0,1fr) auto; }
    .workspace[data-stage="live"] :is(.conversation, .understanding) { min-height:0; }
  .workspace[data-stage="live"] .conversation { grid-template-rows:auto auto auto minmax(0,1fr) auto; }
}
/* Narrow screens: stacked, the page scrolls; the transcript keeps a bounded reading area. */
@media(max-width:59.99rem) {
  .workspace[data-understanding="absent"] .understanding { display:none; }
  .workspace[data-reveal] .understanding { animation:rise-in 420ms ease-out; }
  .transcript-shell { height:clamp(20rem,60svh,36rem); }
  .understanding { max-height:none; } .analysis-content { height:440px; max-height:440px; overflow:auto; }
}
@keyframes rise-in { from { opacity:0; transform:translateY(.5rem); } to { opacity:1; transform:none; } }
@media(max-width:44rem) {
  .wordmark { font-size:20px; }
  .header-actions { gap:0; }
  .turn { --turn-max-width:88%; } .upload { width:90%; }
  .concept-bar { grid-template-columns:minmax(0,1fr) auto; } .concept-rail { column-gap:.5rem; }
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
@media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto; animation:none !important; } .workspace, .understanding, .fill, .icon-slash { transition:none !important; } }
.workspace[data-concept-layout="image"] .concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-preview-slot { visibility:visible; justify-self:end; }
.workspace[data-concept-layout="image"] .concept-access:is([data-partial-withdrawal],[data-refresh-failed]) .concept-preview:not([hidden]) { visibility:visible !important; }
`;
