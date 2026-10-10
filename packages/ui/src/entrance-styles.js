// The entrance, adapted from START src/pages/index.astro (.v2__prompt, .v2__title, readiness composition),
// src/styles/landing-presets.css and src/components/ConversationReadiness.astro (INSPR rights, D3):
// the promise and the orb, the four processing choices, then readiness with an explicit start.
// START's hover lifts and arrow nudges are left out: nothing moves under the pointer.
export const entranceStyles = `
.intro { position:relative; display:grid; justify-items:center; align-content:start; gap:1.5rem; padding:clamp(.5rem,3svh,2.5rem) 0 2rem; }
.intro__prompt { display:grid; justify-items:center; gap:.25rem; width:min(100%,48rem); text-align:center; }
.intro__orb { line-height:0; margin-bottom:.35rem; } .intro__orb .orb { --orb-size:clamp(4rem,9svh,6rem); }
.intro__promise { display:grid; justify-items:center; }
.promise, .intro__promise ::slotted(*) { margin:0; max-width:40rem; font:400 clamp(2.25rem,4.2vw,3.8rem)/1.02 var(--aithema-display); letter-spacing:-.028em; color:var(--aithema-ink); }
.promise span { display:block; text-wrap:balance; }
.promise__lead { max-width:34rem; margin:.55rem 0 0; font-size:1rem; line-height:1.45; color:var(--aithema-muted); text-wrap:balance; }
/* The card is a size container: the choices follow the room the column gives them (START's 70rem and 52rem
   viewport breaks, less the gutters), also when a host lock column stands beside the entrance. */
.intro__card { display:grid; justify-items:center; width:100%; container-type:inline-size; }

/* START LandingPresets: four glass choices, a summary that reserves its longest text, Continue in a fixed column. */
.chooser { --glass-edge:light-dark(#fffdf9e6,#bdede238); --preset-columns:4; --preset-gap:1rem; width:100%; max-width:74rem; min-width:0; color:var(--aithema-ink); }
.chooser h3 { margin:0 0 1rem; font:600 clamp(1.15rem,2vw,1.5rem)/1.3 var(--aithema-display); letter-spacing:-.02em; text-align:center; }
.chooser__list { display:grid; grid-template-columns:repeat(var(--preset-columns),minmax(0,1fr)); gap:var(--preset-gap); }
.chooser-option { position:relative; isolation:isolate; overflow:hidden; display:flex; flex-direction:column; align-items:flex-start; gap:.65rem; min-width:0;
  padding:1.6rem 1.7rem 1.55rem; border:1px solid var(--glass-edge); border-radius:1.25rem; text-align:left; color:var(--aithema-ink);
  background:radial-gradient(ellipse at 100% 110%,light-dark(#b4e9dc70,#498d8a30),transparent 55%),radial-gradient(ellipse at 0 105%,light-dark(#ffe1b34a,#b7863c17),transparent 45%),
    linear-gradient(125deg,light-dark(#ffffff70,#28435070),light-dark(#fffefa30,#11293655) 50%,light-dark(#ffffff50,#35566335));
  backdrop-filter:blur(16px) saturate(115%); -webkit-backdrop-filter:blur(16px) saturate(115%);
  box-shadow:inset 0 1px 1px light-dark(#fff,#ffffff50),inset 2px 0 3px light-dark(#ffffffc0,#ffffff15),inset -2px -2px 4px light-dark(#ffffffa0,#83c6bf20),0 8px 22px light-dark(#30281712,#00000030),0 1px 3px #183d3810;
  transition:box-shadow .22s ease,border-color .22s ease,background-color .22s ease; }
.chooser-option::before { content:''; position:absolute; z-index:-1; inset:5px; pointer-events:none; border:1px solid light-dark(#ffffffa3,#c8f5ec20); border-radius:calc(1.25rem - 5px);
  background:linear-gradient(135deg,light-dark(#ffffffb0,#ffffff15),transparent 12%,transparent 75%,light-dark(#ffffff70,#ffffff0a)); box-shadow:inset 0 -1px 2px light-dark(#ffffff95,#ffffff0d); }
.chooser-option:hover:not(:disabled) { border-color:light-dark(#8dbdbb,#83c6bf); background-color:transparent; box-shadow:inset 0 1px 3px #ffffff90,0 10px 24px light-dark(#24494320,#00000045); }
.chooser-option:focus-visible, .chooser__continue:focus-visible, .ready__start:focus-visible { outline:3px solid var(--aithema-accent); outline-offset:4px; }
.chooser-option[aria-pressed="true"], .chooser-option[aria-pressed="true"]:hover { border-color:var(--aithema-accent); background-color:light-dark(#d6eeea75,#31716b50);
  box-shadow:inset 0 0 0 1px var(--aithema-accent),inset 0 1px 3px #ffffff80,0 8px 24px #14554d16; }
.chooser-option__icon { display:grid; place-items:center; width:2.25rem; height:2.25rem; margin-bottom:.2rem; color:light-dark(#173c53,#bddfdf); }
.chooser-option__icon svg { width:2rem; height:2rem; }
.chooser-option .radio { position:absolute; top:1.05rem; right:1.05rem; display:grid; place-items:center; width:1.1rem; height:1.1rem; border:1.25px solid light-dark(#71919f,#96b8be);
  border-radius:50%; background:light-dark(#ffffff60,#14333d80); }
.chooser-option .radio::after { content:''; width:.5rem; height:.5rem; border-radius:50%; background:var(--aithema-accent); transform:scale(0); transition:transform .18s ease; }
.chooser-option[aria-pressed="true"] .radio { border:1.25px solid var(--aithema-accent); } .chooser-option[aria-pressed="true"] .radio::after { transform:scale(1); }
.chooser-option strong { font:600 clamp(1rem,1.65vw,1.35rem)/1.2 var(--aithema-display); letter-spacing:-.025em; }
.chooser-option__detail { display:grid; font-size:.9rem; line-height:1.5; color:var(--aithema-muted); }
.chooser-option__note { font-size:.72rem; line-height:1.3; color:var(--aithema-muted); } .chooser-option__note:empty { display:none; }
.chooser-option[aria-disabled="true"] { cursor:help; } .chooser-option[aria-disabled="true"] :is(strong, .chooser-option__icon) { color:var(--aithema-muted); }
.chooser__action { display:grid; grid-template-columns:repeat(var(--preset-columns),minmax(0,1fr)); align-items:start; gap:var(--preset-gap); margin:2.75rem 0 0; }
.chooser__hint { grid-column:1/-2; display:grid; gap:.35rem; min-width:0; text-align:left; }
.chooser__summary { display:grid; } .chooser__summary > strong { grid-area:1/1; align-self:start; font:600 1.05rem/1.4 var(--aithema-display); }
.chooser__measure { visibility:hidden; pointer-events:none; user-select:none; }
.chooser__hint > span { font-size:.85rem; line-height:1.4; color:var(--aithema-muted); }
.chooser__continue { grid-column:-2/-1; display:flex; align-items:center; justify-content:space-between; gap:.75rem; width:100%; min-width:0; min-height:4rem;
  padding:.65rem .75rem .65rem 1.7rem; border:1px solid light-dark(#486b80,#6ba5b3); border-radius:1rem; color:#fff; font:650 1.25rem/1.2 var(--aithema-font);
  background:linear-gradient(135deg,#1c405b,#102c43 65%,#21445c); box-shadow:inset 0 1px 2px #ffffff45,0 5px 14px #153f4830; transition:box-shadow .2s ease; }
.chooser__continue:hover:not(:disabled) { background:linear-gradient(135deg,#1c405b,#102c43 65%,#21445c); box-shadow:inset 0 1px 2px #ffffff50,0 8px 24px #153f4850; }
.chooser__arrow, .ready__arrow { display:grid; place-items:center; flex:none; width:2.75rem; height:2.75rem; border-radius:.8rem; color:#fff;
  background:linear-gradient(135deg,#248f92,#107275); box-shadow:inset 0 1px 1px #ffffff25; }
.chooser__continue:disabled { cursor:wait; opacity:.7; }
.chooser__error { max-width:40rem; min-height:1.5em; margin:1rem auto 0; font-size:.9rem; line-height:1.5; text-align:center; color:var(--aithema-error); }

/* Readiness (START data-entry without a preset choice): the orb waits in the future conversation corner, the promise
   and the card stand side by side on short wide screens and stack elsewhere. */
.intro[data-mode="ready"] { row-gap:1.75rem; padding-top:1.5rem; }
.intro[data-mode="ready"] .intro__orb { position:absolute; top:0; left:0; margin:0; } .intro[data-mode="ready"] .intro__orb .orb { --orb-size:48px; }
.intro[data-mode="ready"] :is(.promise, .intro__promise ::slotted(*)) { font-size:clamp(2.2rem,1.2rem + 3vw,3rem); }
.intro[data-mode="ready"] .promise__lead { margin-top:.85rem; line-height:1.5; }
.ready { display:grid; gap:.85rem; width:min(100%,38rem); padding:1.25rem 1.5rem; text-align:left; color:var(--aithema-muted); font-size:.85rem; line-height:1.45;
  border:1px solid color-mix(in srgb,var(--aithema-line) 88%,var(--aithema-accent-bright)); border-radius:clamp(1rem,2vw,1.3rem);
  background:color-mix(in srgb,var(--aithema-surface) 86%,transparent); backdrop-filter:blur(1.25rem) saturate(115%);
  box-shadow:0 1.1rem 2.8rem -1.65rem color-mix(in srgb,var(--aithema-ink) 34%,transparent),inset 0 1px rgb(255 255 255 / 54%); }
.ready h3 { margin:0; font-size:.95rem; font-weight:650; color:var(--aithema-ink); }
.ready dl { display:grid; gap:.55rem; margin:0; }
.ready__row { display:grid; grid-template-columns:minmax(8rem,1fr) minmax(0,1.7fr); align-items:center; gap:.8rem; min-height:1.5rem; }
.ready dt, .ready dd { display:flex; align-items:center; gap:.5rem; margin:0; font-size:.78rem; }
.ready dd { justify-content:flex-end; text-align:right; color:var(--aithema-ink); }
.ready__icon, .ready__check { display:grid; place-items:center; flex:0 0 1.1rem; width:1.1rem; height:1.1rem; }
.ready__icon svg { width:1rem; height:1rem; } .ready__check svg { width:.8rem; height:.8rem; }
.ready__check { visibility:hidden; color:var(--aithema-accent); border-radius:50%; background:color-mix(in srgb,var(--aithema-accent-bright) 10%,transparent); }
.ready__row:is([data-state="confirmed"], [data-state="selected"]) .ready__check { visibility:visible; }
.ready__row[data-state="off"] dd { color:var(--aithema-muted); }
.ready__actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.4rem 1rem; }
.ready__actions button { min-height:44px; padding:.4rem 0; font-size:.8rem; font-weight:400; color:color-mix(in srgb,var(--aithema-muted) 90%,var(--aithema-ink)); text-decoration:underline;
  text-decoration-color:color-mix(in srgb,currentColor 30%,transparent); text-underline-offset:.2em; }
.ready__actions button:hover:not(:disabled) { background:none; color:var(--aithema-ink); }
.ready__route { margin:0; font-size:.76rem; line-height:1.42; color:color-mix(in srgb,var(--aithema-muted) 90%,var(--aithema-ink)); text-wrap:pretty; }
.ready__modes { display:inline-grid; grid-template-columns:repeat(2,minmax(0,1fr)); justify-self:center; gap:.2rem; padding:.2rem;
  border:1px solid color-mix(in srgb,var(--aithema-line) 88%,transparent); border-radius:999px; background:color-mix(in srgb,var(--aithema-paper) 48%,transparent); }
.ready__mode { display:inline-flex; align-items:center; justify-content:center; gap:.35rem; min-width:7rem; min-height:44px; padding:.35rem .75rem; border-radius:999px;
  color:var(--aithema-muted); font-size:.76rem; transition:color 160ms ease,background 160ms ease,box-shadow 160ms ease; }
.ready__mode svg { width:.9rem; height:.9rem; }
.ready__mode:hover:not([aria-disabled="true"]) { color:var(--aithema-ink); background:none; }
.ready__mode[aria-pressed="true"], .ready__mode[aria-pressed="true"]:hover { color:var(--aithema-ink); background:var(--aithema-surface);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--aithema-accent-bright) 38%,transparent),0 .2rem .65rem color-mix(in srgb,var(--aithema-ink) 12%,transparent); }
.ready__mode[aria-disabled="true"] { opacity:.55; cursor:not-allowed; }
.ready__start { display:grid; grid-template-columns:minmax(0,1fr) 2.35rem; align-items:center; width:100%; min-height:3.5rem; padding:.55rem .65rem .55rem 1.15rem;
  border-radius:.9rem; color:var(--aithema-paper); background:var(--aithema-ink); font-size:1rem; font-weight:700; text-align:left; }
.ready__start:hover:not(:disabled) { background:var(--aithema-ink); box-shadow:0 5px 14px color-mix(in srgb,var(--aithema-ink) 25%,transparent); }
.ready__start .ready__arrow { width:2.35rem; height:2.35rem; border-radius:.7rem; color:var(--aithema-paper); background:var(--aithema-accent-bright); box-shadow:none; }
@media(min-width:60rem) and (max-height:56rem) {
  .intro[data-mode="ready"] { grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); align-items:center; column-gap:clamp(2rem,5vw,5rem); max-width:72rem; margin-inline:auto; }
  .intro[data-mode="ready"] :is(.intro__prompt, .intro__promise) { justify-items:start; text-align:left; }
  .intro[data-mode="ready"] :is(.promise, .intro__promise ::slotted(*)) { font-size:clamp(2.6rem,3.9vw,3.75rem); line-height:1.04; }
  .intro[data-mode="ready"] .intro__card { justify-items:stretch; } .intro[data-mode="ready"] .ready { width:100%; }
}
@container(max-width:64rem) {
  .chooser { --preset-gap:.75rem; } .chooser-option { padding:1.35rem 1.15rem; }
  .chooser__continue { padding-left:1rem; font-size:1.1rem; } .chooser__arrow { width:2.25rem; height:2.25rem; }
}
@container(max-width:47rem) { .chooser { --preset-columns:2; } .chooser-option { padding:1.15rem 1.25rem; } }
@media(max-width:40rem) {
  .intro[data-mode="ready"] { row-gap:1.25rem; padding-top:1rem; }
  .intro[data-mode="ready"] :is(.promise, .intro__promise ::slotted(*)) { font-size:clamp(1.8rem,7.5vw,2.6rem); line-height:1.05; }
  .intro[data-mode="ready"] .promise__lead { font-size:.875rem; } .ready { padding:1rem; gap:.75rem; }
  .ready__modes { width:100%; } .ready__mode { min-width:0; }
}
@media(max-width:35rem) {
  .intro { gap:1.25rem; } .promise, .intro__promise ::slotted(*) { font-size:clamp(1.85rem,7vw,2.4rem); } .promise__lead { font-size:.88rem; }
  .chooser { --preset-gap:.7rem; } .chooser-option { padding:1rem .85rem; gap:.45rem; border-radius:1rem; } .chooser-option::before { border-radius:calc(1rem - 5px); }
  .chooser-option .radio { top:.8rem; right:.8rem; width:1rem; height:1rem; } .chooser-option strong { font-size:1.06rem; }
  .chooser-option__detail { font-size:.78rem; line-height:1.45; } .chooser__action { margin-top:2rem; }
  .chooser__summary > strong { font-size:.95rem; } .chooser__hint > span { font-size:.78rem; }
  .chooser__continue { padding:.6rem .5rem; gap:.35rem; font-size:.95rem; } .chooser__arrow { width:1.8rem; height:1.8rem; border-radius:.6rem; }
  .ready__row { grid-template-columns:minmax(6.7rem,1fr) minmax(0,1.4fr); gap:.4rem; } .ready dt, .ready dd { font-size:.72rem; }
}
@media(prefers-reduced-motion:reduce) { .chooser-option, .chooser-option .radio::after, .chooser__continue, .ready__mode { transition:none; } }
`;
