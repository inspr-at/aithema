// Conversation bubbles and aside adapted from START index.astro; INSPR rights (D3).
export const styles = `
:host { --aithema-paper: #f7f5ef; --aithema-ink: #243b40; --aithema-muted: #67777a;
  --aithema-accent: #227c78; --aithema-amber: #c5974e; --aithema-line: #d5dfda;
  --aithema-surface: #fffef9; --aithema-font: system-ui, sans-serif;
  display:block; color:var(--aithema-ink); font: 1rem/1.5 var(--aithema-font); }
* { box-sizing:border-box; } [hidden] { display:none !important; }
button, textarea, select, a { font:inherit; } button, a { touch-action:manipulation; }
button { color:inherit; cursor:pointer; background:transparent; border:1px solid var(--aithema-line);
  border-radius:.6rem; padding:.5rem .85rem; } button:hover { background:color-mix(in srgb,var(--aithema-accent) 7%,transparent); }
button:disabled { opacity:.5; cursor:wait; } :focus-visible { outline:2px solid var(--aithema-accent); outline-offset:3px; }
.workspace { display:grid; gap:1rem; }
.preset-panel { grid-column:1/-1; height:9rem; overflow:auto; border:1px solid var(--aithema-line); border-radius:.6rem; padding:.5rem 1rem; scrollbar-gutter:stable; }
.preset-choice { margin-left:.5rem; color:inherit; background:var(--aithema-surface); border:1px solid var(--aithema-line); border-radius:.4rem; }
.features { display:flex; flex-wrap:wrap; list-style:none; padding:0; gap:.3rem 1rem; margin:.5rem 0; }
.features li { font-size:.75rem; } .features .unavailable { color:var(--aithema-muted); }
.features span { display:block; font-size:.65rem; max-width:12rem; } .conversation, .understanding { min-width:0; border:1px solid var(--aithema-line);
  background:var(--aithema-surface); border-radius:1rem; overflow:hidden; }
.conversation { height:42rem; max-height:85dvh; display:grid; grid-template-rows:3.6rem 8rem minmax(0,1fr) 10rem; }
.head { display:flex; align-items:center; justify-content:space-between; padding:0 1.25rem; border-bottom:1px solid var(--aithema-line); }
h2 { font-size:1.05rem; font-weight:600; margin:0; } h3 { font-size:.82rem; font-weight:650; margin:0 0 .4rem; }
.status { font-size:.75rem; color:var(--aithema-muted); max-width:50%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.transcript-shell { overflow:auto; padding:1.25rem; scrollbar-gutter:stable; }
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
.composer-actions { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.composer-actions small { font-size:.7rem; color:var(--aithema-muted); } .send { min-width:6rem; background:var(--aithema-accent); color:white; }
.composer-reason { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.understanding { height:42rem; display:grid; grid-template-rows:3.6rem 7rem minmax(0,1fr) 3.6rem; }
.readiness { padding:.8rem 1.25rem; } .scale { height:.72rem; border:1px solid var(--aithema-line); border-radius:999px;
  position:relative; background:linear-gradient(90deg,color-mix(in srgb,var(--aithema-accent) 10%,var(--aithema-surface)) 0 30%,
  color-mix(in srgb,var(--aithema-amber) 12%,var(--aithema-surface)) 30% 100%); overflow:visible; }
.fill { display:block; height:100%; border-radius:inherit; background:var(--aithema-accent); width:0; }
.marker { position:absolute; top:-.25rem; left:30%; height:1.1rem; width:2px; background:var(--aithema-ink); }
.scale-labels { display:flex; justify-content:space-between; font-size:.65rem; color:var(--aithema-muted); margin:.3rem 0; }
.readiness p { margin:0; font-size:.7rem; color:var(--aithema-muted); }
.analysis-content { overflow:auto; padding:0 1.25rem 1rem; scrollbar-gutter:stable; }
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
@media(min-width:60rem) { .workspace { grid-template-columns:minmax(0,1.65fr) minmax(20rem,1fr); } }
@media(prefers-reduced-motion:reduce) { * { scroll-behavior:auto; animation:none !important; } }
`;
