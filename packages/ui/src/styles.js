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
:host { --aithema-font:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif; --aithema-mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
  --aithema-radius-sm:10px; --aithema-radius-md:18px; --aithema-radius-lg:28px;
  --aithema-shell-max:1520px; --aithema-gutter:clamp(1.25rem,4vw,3.5rem);
  /* The live workspace's height on wide screens; a host with a masthead above subtracts it, e.g. calc(100dvh - 4rem). */
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
.toolbar { grid-area:top; display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:center; gap:.5rem 1rem; min-height:3.5rem; padding-top:.25rem; }
.conversation { grid-area:conversation; } .understanding { grid-area:understanding; } .host-foot { grid-area:foot; }
.preset-panel { grid-column:1; } .host-bar { grid-column:2; } .settings-open { grid-column:3; }
/* Before the conversation starts there is nothing to understand: the column is not there (START data-entry),
   unless a host verification lock needs it for its form. */
.workspace[data-understanding="absent"]:not([data-stage="live"]) .understanding { display:none; }
/* The processing line: what processes this conversation, quiet, on the page itself. */
.preset-panel { min-width:0; overflow-anchor:none; padding-top:var(--aithema-slack-top,0px); padding-bottom:var(--aithema-slack-bottom,0px); }
.workspace:not([data-stage="live"]) .engine { visibility:hidden; }
.features { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; margin:0; padding:0; }
.settings-open { display:grid; place-items:center; width:2.75rem; height:2.75rem; padding:0; border-radius:50%; color:var(--aithema-muted);
  border:1px solid var(--aithema-line); background:color-mix(in srgb,var(--aithema-surface) 68%,transparent); }
.settings-open:hover:not(:disabled) { color:var(--aithema-ink); background:color-mix(in srgb,var(--aithema-accent-soft) 55%,var(--aithema-surface)); }

/* The conversation column (START .v2): quiet header line, then the entrance or the live conversation. */
.conversation { position:relative; min-width:0; display:grid; grid-template-rows:auto; align-content:start; gap:.85rem; }
.head { display:flex; align-items:baseline; justify-content:space-between; gap:.15rem 1.5rem; }
/* The AI notice (AIT-119, GUI-27): one quiet line, no box, from the first paint on. Sticky, so it stays in view
   wherever an interaction can begin; the hidden full notice holds its height, so it never resizes. */
.conversation > .head { position:sticky; top:0; z-index:3; padding:.35rem 0; background-color:var(--aithema-paper); background-image:var(--aithema-lighting); background-attachment:fixed; }
.ai-notice { display:grid; flex:1; min-width:0; margin:0; font-size:.75rem; line-height:1.35; color:var(--aithema-muted); overflow-wrap:anywhere; }
.ai-notice > span { grid-area:1/1; } .ai-notice__sizer { visibility:hidden; }
/* The status has a fixed width and two reserved lines (a longer one scrolls in them): a new status never
   rewraps the notice or changes the head's height, so nothing below it moves. */
.status { flex:0 0 min(45%,26rem); height:2.7em; overflow-y:auto; overscroll-behavior:contain; font-size:.75rem; line-height:1.35; color:var(--aithema-muted);
  text-align:right; overflow-wrap:anywhere; }
.workspace:not([data-stage="live"]) .status { visibility:hidden; }
.conversation > :not(.head) :is(button, textarea) { scroll-margin-top:5.5rem; }
.workspace:not([data-stage="live"]) :is(.audio-rail, .concept-bar, .transcript-shell, .composer) { display:none; }

/* The conversation rail (START .v2__conversation-rail): orb dock, sound, waveform with one status phrase,
   pause, microphone and end. 44 px controls in fixed cells. */
.audio-rail { position:relative; display:grid; grid-template-columns:48px 44px minmax(0,1fr) 44px 44px 44px; align-items:center; gap:8px; min-height:48px; }
.audio-rail:focus { outline:none; } .audio-rail:focus-visible { outline:2px solid var(--aithema-accent-bright); outline-offset:4px; border-radius:24px; }
.voice-orb { width:48px; height:48px; display:grid; place-items:center; } .voice-orb .orb { --orb-size:48px; }
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
.voice-icon--resume, :is(.pause, .voice-pause)[aria-pressed="true"] .voice-icon:not(.voice-icon--resume) { visibility:hidden; }
:is(.pause, .voice-pause)[aria-pressed="true"] .voice-icon--resume { visibility:visible; }
.audio-rail .voice-close { color:var(--aithema-error); }
.audio-rail .voice-playback, .audio-rail .voice-playback:hover:not(:disabled) { color:var(--aithema-on-accent); background:var(--aithema-accent); border-color:var(--aithema-accent); }
/* Which control of a shared cell shows: invisible ones are out of the tab order and the accessibility tree. */
.audio-rail:is([data-call="none"]) .voice-input, .audio-rail[data-call="active"] .voice-start,
.audio-rail[data-call="none"] .voice-close, .audio-rail[data-call="active"] .voice-retry, .audio-rail:not([data-state="failed"]) .voice-retry,
.audio-rail[data-playback-blocked] .voice-output, .audio-rail:not([data-playback-blocked]) .voice-playback { visibility:hidden; }
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

/* Concepts: one quiet line under the rail (START keeps concepts out of the conversation's way). */
/* One grid for the line: scene, state, the thumbnail once there is a concept, and Request at the right edge, so the
   thumbnail arriving narrows the state's column and never moves Request. */
.concept-bar { display:grid; grid-template-columns:1.5rem minmax(0,1fr) auto auto; align-items:center; gap:.6rem; min-height:2.75rem; }
.concept-rail { display:contents; } .concept-scene { grid-column:1; } .concept-activity { grid-column:2; }
.concept-preview-slot { grid-area:1/3; } .concept-request { grid-area:1/4; }
.concept-preview-slot:has(.concept-preview:disabled) { display:none; }
.concept-activity { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.1rem .6rem; font-size:.75rem; color:var(--aithema-muted); }
/* Reserved lines (a longer state scrolls in them) and a progress line that is always there: a concept state
   never changes the line's height, so the transcript below it never moves. */
.concept-activity-text { grid-column:1/-1; line-height:1.3; height:2.6em; overflow-y:auto; overscroll-behavior:contain; overflow-wrap:anywhere; }
.concept-progress { width:100%; height:.3rem; accent-color:var(--aithema-accent); }
.concept-countdown { font-size:.7rem; line-height:1.3; white-space:nowrap; font-variant-numeric:tabular-nums; }
.concept-rail:not([data-phase="pending"]) :is(.concept-progress, .concept-countdown) { visibility:hidden; }
.concept-request { min-height:2.75rem; font-size:.8rem; line-height:1.2; white-space:nowrap; }
.concept-scene { width:1.5rem; height:1.5rem; display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.concept-scene i { background:var(--aithema-accent); border-radius:2px; opacity:.3; }
.concept-rail[data-phase="pending"] .concept-scene i { animation:concept-pulse 1.8s ease-in-out infinite alternate; }
.concept-scene i:nth-child(2n) { animation-delay:-.9s; } @keyframes concept-pulse { to { opacity:.9; } }
.concept-preview-slot { display:grid; }
.concept-preview { display:flex; align-items:center; gap:.6rem; height:2.75rem; padding:.2rem .5rem; text-align:left; color:var(--aithema-accent); font-weight:600; font-size:.8rem; }
.concept-preview img { width:3.6rem; height:2.3rem; object-fit:cover; border:1px solid var(--aithema-line); border-radius:6px; }
.concept-preview-glyph { width:3.6rem; height:2.3rem; flex:none; display:grid; place-items:center; color:var(--aithema-accent); }
.concept-preview-glyph svg { width:2.4rem; height:auto; }
.concept-preview-text { display:grid; } .concept-preview-text > * { grid-area:1/1; } .concept-preview-sizer { visibility:hidden; }

/* The transcript (START .v2__transcript): tailed bubbles on the page, reading position kept by hand. */
.transcript-shell { position:relative; min-height:0; overflow:auto; overflow-anchor:none; overscroll-behavior-y:contain; scrollbar-gutter:stable;
  scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--aithema-accent-bright) 36%,transparent) transparent;
  padding:calc(.25rem + var(--aithema-slack-top,0px)) .75rem calc(1.5rem + var(--aithema-slack-bottom,0px)) .6rem; }
.transcript-latest { position:sticky; bottom:0; display:block; margin:.6rem auto 0; font-size:.75rem; border-radius:999px;
  background:var(--aithema-surface); box-shadow:var(--aithema-shadow-raised); }
ol { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:.5rem; font-size:.95rem; }
.turn { position:relative; max-width:78%; align-self:flex-start; padding:.65rem .8rem; line-height:1.45; overflow-wrap:anywhere;
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
.turn strong { display:block; margin-bottom:.15rem; font-size:.72rem; font-weight:650; letter-spacing:.05em; text-transform:uppercase; color:var(--aithema-muted); }
.turn span { white-space:pre-wrap; } .turn.partial { color:var(--aithema-muted); }
.turn small.engine-tag { display:block; margin-top:.35rem; font-size:.66rem; color:var(--aithema-muted); }
@keyframes turn-in { from { transform:translateY(.35rem); } to { transform:none; } }
/* Withdrawing one's own sentence: a quiet text action under the bubble. */
:is(.withdraw, .upload-withdraw) { display:block; margin-top:.3rem; font-size:.72rem; padding:.2rem 0; color:var(--aithema-muted); text-decoration:underline;
  text-decoration-color:color-mix(in srgb,currentColor 40%,transparent); text-underline-offset:3px; }
:is(.withdraw, .upload-withdraw):hover:not(:disabled) { background:none; color:var(--aithema-ink); text-decoration-color:currentColor; }

/* The composer (START .v2__composer): one raised card, one focus ring, 44 px round actions. */
.composer { position:relative; display:grid; gap:.5rem; padding:clamp(.85rem,2vw,1.25rem); border:1px solid var(--aithema-line); border-radius:var(--aithema-radius-lg);
  background:color-mix(in srgb,var(--aithema-surface) 88%,transparent); box-shadow:var(--aithema-shadow-raised); backdrop-filter:blur(20px) saturate(1.2); }
.composer:focus-within { border-color:var(--aithema-accent); box-shadow:var(--aithema-shadow-raised),0 0 0 3px color-mix(in srgb,var(--aithema-accent-bright) 20%,transparent); }
.composer label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
textarea { resize:none; width:100%; min-height:3.5rem; height:3.5rem; border:0; outline:0; background:transparent; color:var(--aithema-ink); padding:.25rem .5rem; font-size:1rem; line-height:1.5; }
textarea:focus-visible { outline:0; }
textarea::placeholder { color:var(--aithema-muted); opacity:1; }
.composer-actions { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.composer-actions small { font-size:.72rem; color:var(--aithema-muted); }
/* A long reason wraps to a second line rather than ending in "…"; a longer upload refusal scrolls in its two lines. */
.composer-reason { flex:1; min-width:0; line-height:1.3; max-height:2.6em; overflow-wrap:anywhere; overflow-y:auto; overscroll-behavior:contain; }
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
.readiness p { margin:0; font-size:.78rem; line-height:1.35; color:var(--aithema-ink); } .readiness p:empty { display:none; }
.analysis-content { min-height:0; overflow:auto; overflow-anchor:none; overscroll-behavior-y:contain; scrollbar-gutter:stable; overflow-wrap:anywhere;
  scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--aithema-accent-bright) 40%,transparent) transparent;
  display:grid; align-content:start; gap:1.15rem; padding:calc(1rem + var(--aithema-slack-top,0px)) .75rem calc(1.5rem + var(--aithema-slack-bottom,0px)) 0; }
.notice { min-height:1.4rem; margin:0; font-size:.8rem; line-height:1.45; color:var(--aithema-muted); }
.analysis-content section { display:grid; gap:.55rem; padding-top:1rem; border-top:1px solid var(--aithema-line); }
.analysis-content section.summary { padding-top:0; border-top:0; } .analysis-content section.summary h3 { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.summary-text { margin:0; font-size:1rem; line-height:1.55; color:var(--aithema-ink); text-wrap:pretty; }
.analysis-content h3 { font-size:.86rem; font-weight:700; color:var(--aithema-ink); }
.analysis-content ul { display:grid; gap:.45rem; margin:0; padding:0; list-style:none; }
.analysis-content li { position:relative; padding-inline-start:1rem; font-size:.8125rem; line-height:1.45; color:var(--aithema-muted); }
.analysis-content li::before { content:''; position:absolute; top:.55em; left:0; width:.35rem; height:.35rem; border-radius:50%; background:var(--aithema-accent-bright); }
.questions li::before { background:var(--aithema-amber); }
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
.understanding > .foot { display:flex; align-items:center; justify-content:space-between; gap:1rem; min-height:3.25rem; padding-top:.75rem; border-top:1px solid var(--aithema-line); }
.export { display:inline-flex; align-items:center; gap:.5rem; min-height:2.75rem; font-size:.78rem; color:var(--aithema-muted); text-underline-offset:.22em; }
.export:hover { color:var(--aithema-accent); } .export svg { width:1rem; height:1rem; } .retry { font-size:.75rem; }

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
  .workspace[data-stage="live"]:not(:has(> .host-foot:not([hidden]))) { grid-template-rows:auto minmax(0,1fr); grid-template-areas:"top top" "conversation understanding"; }
  .workspace[data-stage="live"] :is(.conversation, .understanding) { min-height:0; }
  .workspace[data-stage="live"] .conversation { grid-template-rows:auto auto auto minmax(0,1fr) auto; }
}
/* Narrow screens: stacked, the page scrolls; the transcript keeps a bounded reading area. */
@media(max-width:59.99rem) {
  .workspace[data-understanding="absent"] .understanding { display:none; }
  .workspace[data-reveal] .understanding { animation:rise-in 420ms ease-out; }
  .transcript-shell { height:clamp(20rem,60svh,36rem); }
  .understanding { max-height:none; } .analysis-content { overflow:visible; }
}
@keyframes rise-in { from { opacity:0; transform:translateY(.5rem); } to { opacity:1; transform:none; } }
@media(max-width:44rem) {
  /* Phones (START's compact masthead): the host's actions on the first line, its credits on the second with Settings
     at their end, then the processing line (once there is one). Without credits or a host bar, Settings moves up. */
  .toolbar { grid-template-columns:minmax(0,1fr) auto; align-items:start; column-gap:.5rem; min-height:0; }
  .host-bar { grid-column:1/-1; grid-row:1/3; } .settings-open { grid-column:2; grid-row:2; align-self:end; } .preset-panel { grid-column:1/-1; grid-row:3; }
  .toolbar:has(.host-credits[hidden]) .host-bar { grid-column:1; grid-row:1; } .toolbar:has(.host-credits[hidden]) .settings-open { grid-row:1; }
  .toolbar:has(.host-credits[hidden]) .preset-panel { grid-row:2; }
  .toolbar:has(> .host-bar[hidden]) .settings-open { grid-row:1; } .toolbar:has(> .host-bar[hidden]) .preset-panel { grid-column:1; grid-row:1; align-self:center; }
  .workspace:not([data-stage="live"]) .engine { display:none; }
  /* Room below the composer for the sticky notice line (inside the column, since a sticky box never enters its
     container's padding): with Attach or Send scrolled to the very top, the notice still stands above them (AIT-119). */
  .composer { margin-bottom:2rem; }
  .conversation > .head { flex-direction:column; align-items:stretch; } .status { flex-basis:auto; text-align:left; }
  .audio-rail { grid-template-columns:32px 44px minmax(0,1fr) 44px 44px 44px; gap:4px; }
  .voice-orb { width:32px; height:32px; } .voice-orb .orb { --orb-size:32px; }
  .voice-state, .voice-caption { font-size:.6rem; padding:3px 6px; } .audio-rail[data-message] .voice-state { left:0; font-size:.78rem; padding:.55rem .75rem; }
  .turn { max-width:88%; } .upload { width:90%; }
  .concept-bar { grid-template-columns:1.5rem minmax(0,1fr) auto; } .concept-activity { grid-column:2/-1; }
  .concept-request { grid-area:2/1/3/3; justify-self:start; } .concept-preview-slot { grid-area:2/3; } .concept-activity-text { height:3.9em; }
  .workspace:not([data-stage="live"]) .status { display:none; }
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
`;
