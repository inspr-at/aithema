// Conversation bubbles and aside adapted from START index.astro; INSPR rights (D3).
export const styles = `
:host { --aithema-paper: #f7f5ef; --aithema-ink: #243b40; --aithema-muted: #67777a;
  --aithema-accent: #227c78; --aithema-amber: #c5974e; --aithema-line: #d5dfda;
  --aithema-surface: #fffef9; --aithema-on-accent: #ffffff; --aithema-warning: #89613b; --aithema-error: #9a4030; --aithema-font: system-ui, sans-serif;
  color-scheme:light dark; display:block; color:var(--aithema-ink); font: 1rem/1.5 var(--aithema-font); }
@media(prefers-color-scheme:dark) { :host { --aithema-paper: #141a1b; --aithema-ink: #e2e9e6; --aithema-muted: #9badab;
  --aithema-accent: #5db5ae; --aithema-amber: #d6ab63; --aithema-line: #33403f; --aithema-surface: #1b2223; --aithema-on-accent: #0d1716;
  --aithema-warning: #d6ab63; --aithema-error: #e59a87; } }
* { box-sizing:border-box; } [hidden] { display:none !important; }
button, textarea, select, a { font:inherit; } button, a { touch-action:manipulation; }
button { color:inherit; cursor:pointer; background:transparent; border:1px solid var(--aithema-line);
  border-radius:.6rem; padding:.5rem .85rem; } button:hover { background:color-mix(in srgb,var(--aithema-accent) 7%,transparent); }
button:disabled { opacity:.5; cursor:wait; } :focus-visible { outline:2px solid var(--aithema-accent); outline-offset:3px; }
.workspace { display:grid; gap:1rem; }
.preset-panel { grid-column:1/-1; height:9rem; overflow:auto; overflow-anchor:none; border:1px solid var(--aithema-line); border-radius:.6rem; scrollbar-gutter:stable;
  padding:calc(.5rem + var(--aithema-slack-top,0px)) 1rem calc(.5rem + var(--aithema-slack-bottom,0px)); }
.preset-choice { margin-left:.5rem; color:inherit; background:var(--aithema-surface); border:1px solid var(--aithema-line); border-radius:.4rem; }
.features { display:flex; flex-wrap:wrap; list-style:none; padding:0; gap:.3rem 1rem; margin:.5rem 0; }
.features li { font-size:.75rem; } .features .unavailable { color:var(--aithema-muted); }
.features span { display:block; font-size:.65rem; max-width:12rem; } .conversation, .understanding { min-width:0; border:1px solid var(--aithema-line);
  background:var(--aithema-surface); border-radius:1rem; overflow:hidden; }
.conversation { height:42rem; max-height:85dvh; display:grid; grid-template-rows:3.6rem 8rem 5.4rem minmax(0,1fr) 10rem; }
.head { display:flex; align-items:center; justify-content:space-between; padding:0 1.25rem; border-bottom:1px solid var(--aithema-line); }
h2 { font-size:1.05rem; font-weight:600; margin:0; } h3 { font-size:.82rem; font-weight:650; margin:0 0 .4rem; }
.status { font-size:.75rem; line-height:1.25; color:var(--aithema-muted); max-width:50%; max-height:2.5em; overflow:hidden; text-align:right; }
.transcript-shell { overflow:auto; overflow-anchor:none; scrollbar-gutter:stable;
  padding:calc(1.25rem + var(--aithema-slack-top,0px)) 1.25rem calc(1.25rem + var(--aithema-slack-bottom,0px)); }
.transcript-latest { position:sticky; bottom:0; display:block; margin:.6rem auto 0; font-size:.75rem;
  background:var(--aithema-surface); }
ol { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:1rem; }
.turn { position:relative; padding:.75rem 1rem; border:1px solid var(--aithema-line); border-radius:.75rem;
  max-width:78%; background:color-mix(in srgb,var(--aithema-ink) 7%,var(--aithema-paper));
  box-shadow:0 1px 3px color-mix(in srgb,currentColor 10%,transparent); align-self:flex-start; overflow-wrap:anywhere; }
.turn::before { content:''; position:absolute; left:-.43rem; top:.85rem; width:.75rem; height:.75rem;
  background:inherit; border-left:1px solid var(--aithema-line); border-bottom:1px solid var(--aithema-line);
  transform:rotate(45deg); clip-path:polygon(0 0,0 100%,100% 100%); }
.turn.user { align-self:flex-end; background:color-mix(in srgb,var(--aithema-accent) 12%,var(--aithema-paper));
  border-color:color-mix(in srgb,var(--aithema-accent) 32%,transparent); box-shadow:0 2px 6px color-mix(in srgb,var(--aithema-accent) 20%,transparent); }
.turn.user::before { left:auto; right:-.43rem; border-left:0; border-bottom:0; border-top:1px solid var(--aithema-line);
  border-right:1px solid var(--aithema-line); clip-path:polygon(100% 0,0 0,100% 100%); }
.turn strong { display:block; font-size:.68rem; color:var(--aithema-muted); margin-bottom:.2rem; }
.turn span { white-space:pre-wrap; } .turn.partial { color:var(--aithema-muted); }
.withdraw { display:block; margin-top:.5rem; font-size:.7rem; padding:.2rem .4rem; } .pause { font-size:.75rem; min-width:5.5rem; flex-shrink:0; }
.composer { border-top:1px solid var(--aithema-line); padding:.8rem 1.2rem; display:grid; gap:.5rem; }
.composer label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
textarea { resize:none; width:100%; height:5rem; border:0; background:transparent; color:inherit; padding:.3rem 0; }
textarea::placeholder { color:var(--aithema-muted); opacity:1; }
.composer-actions { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.composer-actions small { font-size:.7rem; color:var(--aithema-muted); } .send { min-width:6rem; background:var(--aithema-accent); color:var(--aithema-on-accent); }
.composer-reason { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.understanding { height:42rem; display:grid; grid-template-rows:3.6rem 7rem minmax(0,1fr) 3.6rem; }
.readiness { padding:.8rem 1.25rem; } .scale { height:.72rem; border:1px solid var(--aithema-line); border-radius:999px;
  position:relative; background:linear-gradient(90deg,color-mix(in srgb,var(--aithema-accent) 10%,var(--aithema-surface)) 0 30%,
  color-mix(in srgb,var(--aithema-amber) 12%,var(--aithema-surface)) 30% 100%); overflow:visible; }
.fill { display:block; height:100%; border-radius:inherit; background:var(--aithema-accent); width:0; }
.marker { position:absolute; top:-.25rem; left:30%; height:1.1rem; width:2px; background:var(--aithema-ink); }
.scale-labels { display:flex; justify-content:space-between; font-size:.65rem; color:var(--aithema-muted); margin:.3rem 0; }
.readiness p { margin:0; font-size:.7rem; color:var(--aithema-muted); }
.analysis-content { overflow:auto; overflow-anchor:none; scrollbar-gutter:stable;
  padding:var(--aithema-slack-top,0px) 1.25rem calc(1rem + var(--aithema-slack-bottom,0px)); }
.none-yet { list-style:none; color:var(--aithema-muted); } ul .none-yet { margin-left:-1.1rem; } .missing .none-yet { border-top:0; }
.analysis-content section { margin-bottom:1.1rem; } .analysis-content p { margin:0; font-size:.87rem; }
ul { margin:.3rem 0; padding-left:1.1rem; font-size:.83rem; } .notice { min-height:2.6rem; color:var(--aithema-muted); }
.missing { list-style:none; padding:0; } .missing li { border-top:1px solid var(--aithema-line); padding:.5rem 0; }
.missing strong { display:block; font-size:.7rem; color:var(--aithema-muted); } .missing span { display:block; }
.cleared-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
.expand { font-size:.65rem; min-width:6rem; padding:.2rem .4rem; }
details { font-size:.8rem; border-top:1px solid var(--aithema-line); padding:.5rem 0; }
summary { cursor:pointer; } details p { padding:.5rem 0; } blockquote { margin:.5rem 0; padding-left:.7rem; border-left:2px solid var(--aithema-line); color:var(--aithema-muted); }
.foot { border-top:1px solid var(--aithema-line); display:flex; align-items:center; justify-content:space-between; padding:0 1.25rem; }
.export { font-size:.78rem; color:var(--aithema-accent); } .retry { font-size:.72rem; }
.audio-rail { height:8rem; display:grid; grid-template-columns:3rem minmax(0,1fr); grid-template-rows:3rem 3rem;
  gap:.3rem .6rem; padding:.5rem 1rem; border-bottom:1px solid var(--aithema-line); overflow:hidden; }
.voice-orb { width:3rem; height:3rem; border-radius:50%; position:relative; background:
  radial-gradient(circle at 35% 30%,var(--aithema-surface),transparent 60%),
  radial-gradient(circle at 65% 60%,var(--aithema-amber),var(--aithema-accent)); opacity:.6; }
.voice-info { min-width:0; display:grid; align-content:center; font-size:.75rem; }
.voice-state, .voice-caption { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.voice-caption { min-height:1rem; color:var(--aithema-muted); }
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
.concept-tab { min-width:5.5rem; height:2.4rem; font-size:.75rem; }
.concept-tab[data-unread="true"] { box-shadow:inset 0 -3px var(--aithema-amber); color:var(--aithema-accent); }
.concept-preview-slot { height:6rem; margin-bottom:.7rem; }
.concept-preview { width:100%; height:6rem; display:flex; gap:1rem; align-items:center; text-align:left; }
.concept-preview img { width:8rem; height:4.5rem; object-fit:contain; border-radius:.3rem; } .concept-preview-label { font-size:.8rem; }
.concept-preview-glyph { width:8rem; height:4.5rem; flex:none; display:grid; place-items:center; color:var(--aithema-accent); }
.concept-preview-glyph svg { width:3.5rem; height:auto; }
.concept-viewer { position:fixed; inset:0; margin:0; width:100vw; max-width:none; height:100dvh; max-height:none; padding:0; border:0;
  color:var(--aithema-ink); background:var(--aithema-paper); overflow:hidden; }
.concept-viewer[open] { display:grid; grid-template-rows:4rem minmax(0,1fr) 17rem; }
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
.concept-viewer-controls { padding:.6rem 1rem; overflow:auto; scrollbar-gutter:stable; border-top:1px solid var(--aithema-line); }
.concept-navigation { display:grid; grid-template-columns:1fr 1fr 1.3fr 2fr; gap:.5rem; }
.concept-navigation button, .concept-feedback button { height:3rem; overflow:hidden; font-size:.75rem; line-height:1.2; padding:.2rem .4rem; }
.concept-disclosure { height:1.2rem; margin:.35rem 0; font-size:.75rem; overflow:hidden; }
.concept-feedback { display:grid; grid-template-columns:1fr 1fr 2fr; gap:.5rem; }
.concept-feedback [aria-pressed="true"] { background:var(--aithema-accent); color:var(--aithema-on-accent); }
/* The fixed guidance choices wrap into rows on narrow screens rather than scrolling sideways out of view. */
.concept-guidance-options { min-height:3rem; display:flex; flex-wrap:wrap; align-items:center; align-content:center; gap:.4rem; padding:.3rem 0; white-space:nowrap; }
.concept-guidance-options button, .concept-guidance-selected button { font-size:.7rem; padding:.3rem .5rem; flex-shrink:0; }
.concept-guidance-selected { height:2.3rem; display:flex; gap:.4rem; align-items:center; overflow:auto; white-space:nowrap; }
.concept-viewer-message { height:1rem; margin:.2rem 0; font-size:.75rem; }
@media(min-width:60rem) { .workspace { grid-template-columns:minmax(0,1.65fr) minmax(20rem,1fr); } }
/* Phones: fixed rail heights keep targets still; the transcript gets most of a small viewport (D14). */
@media(max-width:40rem) {
  .conversation { height:auto; max-height:none; grid-template-rows:3.6rem 9.6rem 9.4rem clamp(20rem,60svh,36rem) 9rem; }
  textarea { height:3.8rem; }
  .audio-rail { height:9.6rem; grid-template-columns:2.5rem minmax(0,1fr); grid-template-rows:2.5rem auto; }
  .voice-orb { width:2.5rem; height:2.5rem; }
  .voice-controls { grid-template-columns:repeat(4,minmax(0,1fr)); grid-auto-rows:2.7rem; }
  .voice-controls button { line-height:1.2; }
  .concept-rail { height:9.4rem; grid-template-columns:2.5rem minmax(0,1fr); grid-template-rows:minmax(0,1fr) 2.7rem; align-items:start; }
  .concept-activity-text { height:3.3rem; }
  .concept-request { grid-column:1/-1; height:2.7rem; }
  /* The viewer on phones: navigation in two rows and a two-line disclosure, so long (German) labels stay whole. */
  .concept-viewer[open] { grid-template-rows:4rem minmax(0,1fr) 21.5rem; }
  .concept-navigation { grid-template-columns:1fr 1fr; } .concept-navigation button { height:2.75rem; }
  .concept-disclosure { height:2.4em; line-height:1.2; }
  .concept-viewer-head { grid-template-columns:minmax(0,1fr) 3.5rem minmax(7rem,9rem); gap:.5rem; }
  .concept-viewer-head h2 { font-size:.95rem; } .concept-close { font-size:.75rem; line-height:1.2; padding:.3rem .5rem; }
}
@media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto; animation:none !important; } }
`;
