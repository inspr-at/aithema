// AIT-140: the approved round-2 glass slab, adapted from start2-polish-approved-r2.html.
// The public INSPR Aithema logo's aperture is expressed as even-odd paths, not an external asset.
const LEFT = 'M627 110 110 627 627 1144Z M627 330 330 627 627 924Z';
const RIGHT = 'M627 110 1144 627 627 1144Z M627 330 924 627 627 924Z';
const CENTRE = 'm627 500 127 127-127 127-127-127 127-127Z';
let nextOrb = 0;

export const orbStyles = `
.orb { --orb-size:40px; --orb-energy:0; --orb-teal:var(--aithema-accent,var(--teal,#0e6f6c)); --orb-surface:var(--aithema-surface,var(--surface,#fffcf8)); position:relative; display:block; width:var(--orb-size); height:var(--orb-size); flex:none; border-radius:50%; perspective:140px; isolation:isolate; }
.orb[role="button"]:focus-visible { outline:2px solid rgba(255,255,255,.7); outline-offset:2px; box-shadow:0 0 0 5px #102b42; }
.orb > span { position:absolute; border-radius:50%; pointer-events:none; }
.orb__body { inset:0; background:radial-gradient(circle at 50% 118%,color-mix(in srgb,var(--orb-teal) 62%,transparent),color-mix(in srgb,var(--orb-teal) 16%,transparent) 48%,transparent 72%),radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--orb-surface) 22%,transparent),color-mix(in srgb,var(--orb-teal) 14%,transparent)); box-shadow:inset 0 -5px 9px color-mix(in srgb,var(--orb-teal) 38%,transparent),inset 0 3px 5px rgba(255,255,255,.75),inset 0 0 0 1px rgba(255,255,255,.4),0 5px 12px -4px rgba(16,43,66,.4),0 1px 2px rgba(16,43,66,.18); backdrop-filter:blur(2px) saturate(1.3); transition:transform 120ms linear,opacity .25s; }
.orb__breath { inset:0; box-shadow:inset 0 -5px 9px color-mix(in srgb,var(--orb-teal) 48%,transparent),0 0 0 5px color-mix(in srgb,var(--orb-teal) 12%,transparent); opacity:0; }
.orb__prism { inset:24%; border-radius:0 !important; transform-style:preserve-3d; transform:rotateX(10deg) rotateY(0deg); animation:aithema-prism-turn 14s linear infinite; }
.orb__slab { position:absolute; inset:0; display:block; }
.orb__slab svg { display:block; width:100%; height:100%; }
.orb__slab--front { filter:drop-shadow(0 0 2px rgba(255,255,255,.9)); }
.orb__face--logo { position:absolute; inset:0; opacity:0; transition:opacity .25s; }
.orb__face--warm { opacity:1; transition:opacity .5s; }
.orb[data-orb-reveal] .orb__face--logo { opacity:1; }
.orb[data-orb-reveal] .orb__face--warm { opacity:0; }
.orb__light { inset:0; mix-blend-mode:screen; opacity:.9; background:radial-gradient(circle at 94% 64%,rgba(255,166,58,.42),rgba(255,166,58,.14) 30%,transparent 58%); transition:opacity .5s,transform .5s; }
.orb__warm-glow { inset:0; box-shadow:0 0 22px 2px rgba(255,170,70,.45); opacity:0; transition:opacity .5s; }
.orb[data-orb-reveal] .orb__light { opacity:1; transform:scale(1.08); }
.orb[data-orb-reveal] .orb__warm-glow { opacity:1; }
.orb__caustic { left:22%; right:22%; bottom:7%; height:22%; background:radial-gradient(ellipse at 50% 60%,rgba(255,255,255,.55),transparent 70%); filter:blur(1px); }
.orb__rim { inset:0; background:radial-gradient(circle,transparent 62%,rgba(255,255,255,.38) 71%,transparent 77%); mix-blend-mode:screen; }
.orb__highlight { left:15%; top:8%; width:44%; height:30%; background:radial-gradient(ellipse at 50% 45%,rgba(255,255,255,.95),rgba(255,255,255,0) 72%); transform:rotate(-22deg); }
.orb[data-voice="speaking"] .orb__body { animation:aithema-glass-breathe 2.4s ease-in-out infinite; }
.orb[data-voice="speaking"] .orb__breath { animation:aithema-glass-light 2.4s ease-in-out infinite; }
.orb:is([data-voice="paused"],[data-voice="ended"],[data-voice="idle"]) .orb__light { opacity:.6; }
.orb[data-voice="paused"] .orb__body { opacity:.65; }
.orb[data-voice="recovering"] .orb__body { opacity:.8; }
@keyframes aithema-prism-turn { from { transform:rotateX(10deg) rotateY(0deg); } to { transform:rotateX(10deg) rotateY(360deg); } }
/* Fixed glass shadows crossfade; speech never animates a shadow or a blur. */
@keyframes aithema-glass-breathe { 0%,100% { transform:scale(1); } 50% { transform:scale(calc(1.015 + var(--orb-energy) * .035)); } }
@keyframes aithema-glass-light { 0%,100% { opacity:0; transform:scale(1); } 50% { opacity:calc(.25 + var(--orb-energy) * .4); transform:scale(1.04); } }
.orb[data-orb-paused] :is(.orb__prism,.orb__body,.orb__breath) { animation-play-state:paused; }
.orb[data-orb-motion="off"] :is(.orb__prism,.orb__body,.orb__breath) { animation:none !important; }
.orb[data-orb-motion="off"] :is(.orb__body,.orb__light) { transform:none !important; transition:opacity .2s; }
.orb[data-orb-motion="off"] .orb__breath { opacity:0; }
.orb[data-orb-motion="off"] :is(.orb__face--warm,.orb__face--logo,.orb__warm-glow) { transition:opacity .2s; }
/* Keep the old layer/ring selectors for embedders that inspect the voice avatar. */
@media(prefers-reduced-motion:reduce) { .orb__layer, .orb__ring { animation:none !important; transition:none; } .orb :is(.orb__prism,.orb__breath) { animation:none !important; } .orb__body,.orb__light { transform:none !important; } }
`;

function paths(fill) {
  return `<path fill-rule="evenodd" d="${LEFT}" fill="${fill}"/><path fill-rule="evenodd" d="${RIGHT}" fill="${fill}"/><path d="${CENTRE}" fill="${fill}"/>`;
}

/** One object: the logo and the voice avatar. Energy is the audible reply, clamped to 0..1. */
export function createOrb(document, { motion = true } = {}) {
  const view = document.defaultView, preference = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const id = `aithema-orb-${++nextOrb}`, element = document.createElement('div');
  element.className = 'orb'; element.setAttribute('aria-hidden', 'true'); element.dataset.orbPaused = '';
  const layers = [-2.4, -1.4, -.4, .6, 1.6].map(z => `<span class="orb__slab" style="transform:translateZ(${z}px)"><svg viewBox="0 0 1254 1254" aria-hidden="true">${paths(`url(#${id}-edge)`)}</svg></span>`).join('');
  element.innerHTML = `<style>${orbStyles}</style><span class="orb__body orb__layer orb__layer--a"></span><span class="orb__breath"></span><span class="orb__prism">${layers}<span class="orb__slab orb__slab--front" style="transform:translateZ(2.4px)"><svg class="orb__face--warm" viewBox="0 0 1254 1254" aria-hidden="true"><defs><linearGradient id="${id}-warm" gradientUnits="userSpaceOnUse" x1="110" y1="300" x2="1144" y2="950"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff"/><stop offset="1" stop-color="#ffd08a"/></linearGradient><linearGradient id="${id}-edge" gradientUnits="userSpaceOnUse" x1="110" y1="300" x2="1144" y2="950"><stop offset="0" stop-color="#b9dcd8"/><stop offset=".5" stop-color="#e8efe9"/><stop offset="1" stop-color="#f2b25a"/></linearGradient></defs>${paths(`url(#${id}-warm)`)}</svg><svg class="orb__face--logo" viewBox="0 0 1254 1254" aria-hidden="true"><path fill-rule="evenodd" d="${LEFT}" fill="#0e6f6c"/><path fill-rule="evenodd" d="${RIGHT}" fill="#d69b31"/><path d="${CENTRE}" fill="#14304b"/></svg></span></span><span class="orb__light"></span><span class="orb__warm-glow"></span><span class="orb__caustic"></span><span class="orb__rim orb__ring"></span><span class="orb__highlight"></span>`;
  const prism = element.querySelector('.orb__prism');
  let requested = motion !== false, revealed = false, mounted = false, pose = null, turn = null, home = null;
  const paused = new Set();
  const moving = () => requested && !preference?.matches;
  const animations = () => element.getAnimations?.({ subtree: true }) ?? [];
  const visibility = () => {
    element.toggleAttribute('data-orb-paused', document.hidden || !mounted);
    if (document.hidden || !mounted) {
      for (const animation of animations()) if (animation.playState === 'running') { paused.add(animation); animation.pause(); }
    } else {
      for (const animation of paused) if (animation.playState === 'paused') animation.play();
      paused.clear();
    }
  };
  const face = on => {
    revealed = on; element.toggleAttribute('data-orb-reveal', on);
    const from = view?.getComputedStyle(prism).transform || 'rotateX(10deg) rotateY(0deg)';
    pose?.cancel(); pose = null;
    if (!moving() || !prism.animate) { prism.style.transform = on ? 'rotateX(0deg) rotateY(0deg)' : ''; return; }
    if (on && !turn) {
      turn = prism.getAnimations().find(animation => animation.animationName === 'aithema-prism-turn');
      turn?.pause(); home = from;
    }
    pose = prism.animate([{ transform: from }, { transform: on ? 'rotateX(0deg) rotateY(0deg)' : home || 'rotateX(10deg) rotateY(0deg)' }],
      { duration: 700, easing: on ? 'cubic-bezier(.2,.9,.25,1.2)' : 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
    if (!on) pose.onfinish = () => { pose?.cancel(); pose = null; if (!document.hidden && mounted) turn?.play(); turn = null; home = null; };
    visibility();
  };
  const syncMotion = () => {
    pose?.cancel(); pose = null; turn = null; home = null; paused.clear();
    element.dataset.orbMotion = moving() ? 'on' : 'off';
    prism.style.transform = revealed ? 'rotateX(0deg) rotateY(0deg)' : '';
    if (moving() && mounted && !document.hidden) for (const animation of animations()) if (animation.animationName === 'aithema-prism-turn') animation.play();
    if (revealed && moving()) face(true);
    visibility();
  };
  const onReveal = event => face(Boolean(event.detail));
  const mount = () => {
    if (mounted || !element.isConnected) return;
    mounted = true;
    document.addEventListener('visibilitychange', visibility); preference?.addEventListener('change', syncMotion);
    element.addEventListener('aithema-orb-reveal', onReveal); syncMotion();
  };
  element.dataset.orbMotion = moving() ? 'on' : 'off';
  return {
    element, mount,
    setVoice(state) { element.dataset.voice = state; },
    setEnergy(value, measured = true) {
      element.style.setProperty('--orb-energy', String(Math.min(1, Math.max(0, Number(value) || 0))));
      element.toggleAttribute('data-measured', measured);
    },
    setMotion(on) { requested = Boolean(on); syncMotion(); },
    destroy() {
      mounted = false; document.removeEventListener('visibilitychange', visibility); preference?.removeEventListener('change', syncMotion);
      element.removeEventListener('aithema-orb-reveal', onReveal); pose?.cancel(); pose = null; turn?.cancel(); turn = null; home = null;
      paused.clear(); element.dataset.orbPaused = '';
    },
  };
}
