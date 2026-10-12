// AIT-140: About Aithema. Styles and visual layers belong to this module; the band keeps its layout.
let nextReveal = 0;
const css = `
.aithema-reveal-band > .aithema-reveal__fx { position:absolute; inset:0 0 var(--ar-fx-bottom,0px); overflow:hidden; pointer-events:none; z-index:0; }
/* Preserve the approved soft tint; full-white copy and faint glare provide AA contrast. */
.aithema-reveal__glass { position:absolute; left:calc(var(--ar-x) - var(--ar-radius)); top:calc(var(--ar-y) - var(--ar-radius)); width:calc(var(--ar-radius) * 2); height:calc(var(--ar-radius) * 2); border-radius:50%; background:linear-gradient(to bottom,rgba(14,86,84,.86) var(--ar-top),rgba(18,104,100,.80) var(--ar-bottom)); backdrop-filter:blur(10px) saturate(1.1); transform:scale(0); opacity:0; transition:transform .9s cubic-bezier(.2,.7,.2,1),opacity .85s cubic-bezier(.4,0,.2,1); }
.aithema-reveal__wash { position:absolute; inset:0; background:radial-gradient(380px 120px at var(--ar-x) 55%,rgba(255,214,160,.01),transparent 72%),linear-gradient(100deg,transparent 28%,rgba(255,255,255,.01) 44%,transparent 60%); box-shadow:inset 0 1px 0 rgba(255,255,255,.16),inset 0 -1px 0 rgba(255,255,255,.08); opacity:0; transition:opacity .85s cubic-bezier(.4,0,.2,1); }
.aithema-reveal__ring { position:absolute; left:calc(var(--ar-x) - 20px); top:calc(var(--ar-y) - 20px); width:40px; height:40px; border-radius:50%; background:radial-gradient(circle,transparent 56%,rgba(255,255,255,.5) 64%,rgba(255,230,190,.22) 68%,transparent 76%); opacity:0; }
.aithema-reveal__stars { position:absolute; inset:0; width:100%; height:100%; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__glass { transform:scale(var(--ar-open-scale)); opacity:1; transition:transform .9s cubic-bezier(.2,.7,.2,1),opacity .12s ease; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__wash { opacity:1; transition:opacity .7s ease; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__ring { animation:aithema-reveal-ring 1.15s cubic-bezier(.16,.7,.2,1) both; }
@keyframes aithema-reveal-ring { 0% { transform:scale(.7); opacity:1; } 60% { opacity:.55; } 100% { transform:scale(var(--ar-ring-scale)); opacity:0; } }
.aithema-reveal-band[data-aithema-reveal-state="exiting"] .aithema-reveal__glass { transform:scale(var(--ar-open-scale)); opacity:0; transition:opacity .85s cubic-bezier(.4,0,.2,1); }
.aithema-reveal-band > .aithema-reveal__row { position:absolute; left:var(--ar-row-left,108px); right:var(--ar-row-right,24px); top:0; bottom:6px; display:flex; align-items:center; gap:26px; color:#fff; font-family:var(--aithema-font,var(--ui,system-ui,sans-serif)); white-space:nowrap; opacity:0; pointer-events:none; z-index:3; transition:opacity .5s ease; }
.aithema-reveal-band[data-aithema-reveal-state="open"] > .aithema-reveal__row { opacity:1; pointer-events:auto; }
.aithema-reveal-band[data-aithema-reveal-state="exiting"] > .aithema-reveal__row { transition:opacity .3s ease-out; }
.aithema-reveal__wordmark { position:relative; display:inline-block; overflow:hidden; font:600 24px/1.15 var(--aithema-display,var(--display,Georgia,serif)); letter-spacing:-.025em; color:#fff; }
.aithema-reveal__wordmark > .aithema-reveal__letter { position:relative; display:inline-block; opacity:0; transform:translateY(9px) scale(.9); transition:opacity .55s,transform .65s cubic-bezier(.2,.9,.25,1.25); transition-delay:calc(120ms + var(--ar-i) * 45ms); }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__letter { opacity:1; transform:none; }
.aithema-reveal__letter::after { content:attr(data-letter); position:absolute; inset:0; filter:blur(9px); opacity:0; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__letter::after { animation:aithema-reveal-letter-mist .55s calc(120ms + var(--ar-i) * 45ms) both; }
@keyframes aithema-reveal-letter-mist { 0%,25% { opacity:.8; } 100% { opacity:0; } }
.aithema-reveal__glint { position:absolute; inset:0 auto 0 0; width:26px; overflow:hidden; color:#ffe4b3; mask-image:linear-gradient(to right,transparent,#fff,transparent); opacity:0; }
.aithema-reveal__glint > span { display:block; width:max-content; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__glint { animation:aithema-reveal-glint 1.3s .62s cubic-bezier(.3,.6,.2,1) both; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__glint > span { animation:aithema-reveal-glint-text 1.3s .62s cubic-bezier(.3,.6,.2,1) both; }
@keyframes aithema-reveal-glint { 0% { transform:translateX(-140px); opacity:0; } 10%,90% { opacity:1; } 100% { transform:translateX(140px); opacity:0; } }
@keyframes aithema-reveal-glint-text { from { transform:translateX(140px); } to { transform:translateX(-140px); } }
.aithema-reveal__separator { width:1px; align-self:stretch; margin:10px 0; background:linear-gradient(to bottom,transparent,rgba(255,255,255,.22),transparent); }
.aithema-reveal__link { display:grid; gap:2px; min-height:44px; align-content:center; color:#fff; text-decoration:none !important; }
.aithema-reveal__title { position:relative; display:inline-flex; align-items:center; gap:4px; width:max-content; padding-bottom:1px; color:#fff; font-size:14px; font-weight:600; line-height:1.3; }
.aithema-reveal__title::after { content:''; position:absolute; bottom:0; left:0; right:0; height:1px; background:currentColor; transform:scaleX(0); transform-origin:left; transition:transform .25s; }
.aithema-reveal__title svg { width:11px; height:11px; color:#ffd59a; }
.aithema-reveal__link:is(:hover,:focus-visible) .aithema-reveal__title::after { transform:scaleX(1); }
.aithema-reveal__link:focus-visible { outline:2px solid #ffd59a; outline-offset:3px; border-radius:3px; }
.aithema-reveal__subtitle { font-size:11.5px; line-height:1.3; color:#fff; }
.aithema-reveal__version { margin-left:auto; display:grid; justify-items:end; gap:2px; color:#fff; font-size:12.5px; line-height:1.3; font-variant-numeric:tabular-nums; }
.aithema-reveal__version code { font:11px/1.3 var(--aithema-mono,var(--mono,monospace)); color:inherit; }
.aithema-reveal__rise { opacity:0; transform:translateY(8px); transition:opacity .5s,transform .6s cubic-bezier(.2,.9,.25,1.15); transition-delay:calc(330ms + var(--ar-i) * 85ms); }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__rise { opacity:1; transform:none; }
.aithema-reveal-band[data-aithema-reveal-state="exiting"] :is(.aithema-reveal__letter,.aithema-reveal__rise) { opacity:1; transform:none; transition:none; }
.aithema-reveal-band [data-aithema-reveal-control] { opacity:var(--ar-opacity,1); transform:var(--ar-transform,none); transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1); transition-delay:calc(220ms + var(--ar-delay,0ms) * .55); }
.aithema-reveal-band[data-aithema-reveal-state="open"] [data-aithema-reveal-control] { opacity:0; transform:translateX(14px) scale(.94); pointer-events:none; transition:opacity .32s ease-in,transform .38s ease-in; transition-delay:var(--ar-delay,0ms); }
/* A fixed 7px blur on a short-lived visual copy gives the approved dissolve without animating filters. */
.aithema-reveal-band > .aithema-reveal__dissolves { position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2; }
.aithema-reveal__proxy { position:absolute !important; margin:0 !important; opacity:0; pointer-events:none !important; filter:blur(7px); animation:aithema-reveal-return .8s calc(220ms + var(--ar-delay) * .55) cubic-bezier(.2,.7,.2,1) both; }
.aithema-reveal-band[data-aithema-reveal-state="open"] .aithema-reveal__proxy { animation:aithema-reveal-dissolve .38s var(--ar-delay) ease-in both; }
@keyframes aithema-reveal-dissolve { 0% { opacity:0; transform:none; } 35% { opacity:.4; } 100% { opacity:0; transform:translateX(14px) scale(.94); } }
@keyframes aithema-reveal-return { 0% { opacity:0; transform:translateX(14px) scale(.94); } 30% { opacity:.25; } 100% { opacity:0; transform:none; } }
.aithema-reveal-band[data-aithema-reveal-paused] :is(.aithema-reveal__ring,.aithema-reveal__glint,.aithema-reveal__glint > span,.aithema-reveal__proxy) { animation-play-state:paused; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] :is(.aithema-reveal__ring,.aithema-reveal__stars,.aithema-reveal__glint,.aithema-reveal__dissolves) { display:none; animation:none !important; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] .aithema-reveal__letter::after { display:none; animation:none !important; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] .aithema-reveal__title::after { transition:none; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] :is(.aithema-reveal__glass,.aithema-reveal__wash,.aithema-reveal__row,.aithema-reveal__letter,.aithema-reveal__rise,[data-aithema-reveal-control]) { transition:opacity .2s ease !important; transition-delay:0s !important; animation:none !important; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] .aithema-reveal__glass { transform:scale(var(--ar-open-scale)); }
.aithema-reveal-band[data-aithema-reveal-motion="off"] :is(.aithema-reveal__letter,.aithema-reveal__rise) { transform:none; opacity:1; }
.aithema-reveal-band[data-aithema-reveal-motion="off"] [data-aithema-reveal-control] { transform:var(--ar-transform,none); }
@media(max-width:760px) {
  .aithema-reveal-band > .aithema-reveal__row { display:grid; grid-template-columns:minmax(84px,1fr) minmax(64px,.8fr) minmax(100px,1.2fr); align-content:center; gap:8px 10px; white-space:normal; }
  .aithema-reveal__wordmark { grid-column:1 / 3; width:max-content; }
  .aithema-reveal__separator { display:none; }
  .aithema-reveal__version { grid-column:3; grid-row:1; margin:0; font-size:10.5px; text-align:right; }
  .aithema-reveal__version code { font-size:10px; }
  .aithema-reveal__title { font-size:12px; }
  .aithema-reveal__subtitle { font-size:10px; overflow-wrap:anywhere; }
  .aithema-reveal__link:first-of-type .aithema-reveal__subtitle { white-space:nowrap; }
}
@media(max-width:599px) {
  .aithema-reveal-band > .aithema-reveal__row { grid-template-columns:max-content max-content minmax(0,1fr); gap:6px 12px; white-space:nowrap; }
  .aithema-reveal__subtitle { display:none; }
}
`;

const attribute = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
const remember = (node, names) => names.map(name => [name, node.getAttribute(name)]);
const restore = (node, attributes) => attributes.forEach(([name, value]) => attribute(node, name, value));

/** `orb` accepts the createOrb handle (or its element). Call once after mounting the header band. */
export function createReveal({ band, orb, controls = [], links, version = {}, copy = {}, motion = true }) {
  const document = band.ownerDocument, view = document.defaultView, trigger = orb.element ?? orb;
  const text = copy.reveal ?? copy, preference = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const id = `aithema-reveal-${++nextReveal}`, style = document.createElement('style'), fx = document.createElement('div'), row = document.createElement('nav');
  style.textContent = css; fx.className = 'aithema-reveal__fx'; fx.setAttribute('aria-hidden', 'true');
  fx.innerHTML = '<div class="aithema-reveal__glass"></div><div class="aithema-reveal__wash"></div><div class="aithema-reveal__ring"></div>';
  const glass = fx.querySelector('.aithema-reveal__glass');
  row.className = 'aithema-reveal__row'; row.id = id; row.setAttribute('aria-label', text.label ?? 'Aithema'); row.setAttribute('aria-hidden', 'true'); row.inert = true;
  const wordmark = document.createElement('span'); wordmark.className = 'aithema-reveal__wordmark'; wordmark.setAttribute('role', 'img'); wordmark.setAttribute('aria-label', text.wordmark ?? 'Aithema');
  Array.from(text.wordmark ?? 'Aithema').forEach((letter, index) => { const span = document.createElement('span'); span.className = 'aithema-reveal__letter'; span.textContent = letter; span.dataset.letter = letter; span.style.setProperty('--ar-i', index); span.setAttribute('aria-hidden', 'true'); wordmark.append(span); });
  const glint = document.createElement('span'); glint.className = 'aithema-reveal__glint'; glint.setAttribute('aria-hidden', 'true');
  const glintText = document.createElement('span'); glintText.textContent = text.wordmark ?? 'Aithema'; glint.append(glintText); wordmark.append(glint);
  const separator = document.createElement('span'); separator.className = 'aithema-reveal__separator'; separator.setAttribute('aria-hidden', 'true'); row.append(wordmark, separator);
  (links ?? text.links ?? []).forEach((link, index) => {
    const url = new URL(link.href, document.baseURI); if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Reveal links must use HTTP or HTTPS');
    const anchor = document.createElement('a'); anchor.href = url.href; anchor.title = link.subtitle ?? ''; anchor.className = 'aithema-reveal__link aithema-reveal__rise'; anchor.style.setProperty('--ar-i', index + 1);
    const title = document.createElement('span'); title.className = 'aithema-reveal__title'; title.textContent = link.title;
    title.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>');
    const subtitle = document.createElement('span'); subtitle.className = 'aithema-reveal__subtitle'; subtitle.textContent = link.subtitle; anchor.append(title, subtitle); row.append(anchor);
  });
  const build = document.createElement('span'); build.className = 'aithema-reveal__version aithema-reveal__rise'; build.style.setProperty('--ar-i', (links ?? text.links ?? []).length + 1);
  build.title = (text.build ?? '{date}').replace('{date}', version.date ?? '');
  const product = document.createElement('span'), commit = document.createElement('code'), sourceCommit = version.commit ?? '';
  product.textContent = version.product ?? ''; commit.textContent = /^[a-f0-9]{40,64}$/iu.test(sourceCommit) ? sourceCommit.slice(0, 10) : sourceCommit;
  commit.title = sourceCommit; build.append(product, commit); row.append(build);
  const bandAttributes = remember(band, ['data-aithema-reveal-state', 'data-aithema-reveal-motion', 'data-aithema-reveal-paused']);
  const triggerAttributes = remember(trigger, ['aria-hidden', 'role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-controls']);
  const hadClass = band.classList.contains('aithema-reveal-band'), originalPosition = band.style.position;
  if (view.getComputedStyle(band).position === 'static') band.style.position = 'relative';
  band.classList.add('aithema-reveal-band'); band.dataset.aithemaRevealState = 'closed';
  trigger.removeAttribute('aria-hidden'); trigger.setAttribute('role', 'button'); trigger.tabIndex = 0; trigger.setAttribute('aria-label', text.label ?? 'Aithema'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', id);
  band.prepend(style, fx); band.insertBefore(row, trigger.parentNode === band ? trigger.nextSibling : null);
  const items = [...new Set(controls)].filter(control => control !== trigger && !control.contains(trigger));
  const saved = new Map(), properties = new Map(), paused = new Set();
  let requested = motion !== false, destroyed = false, connected = false, intent = 0, exitTimer = 0, phase = 'closed', suppressFocus = false, geometry, dissolves;
  let canvas, context, particles = [], frame = 0, ambient = 0, last = 0;
  const moving = () => requested && !preference?.matches;
  const active = () => band.getRootNode().activeElement ?? document.activeElement;
  const focusOrb = () => { suppressFocus = true; trigger.focus({ preventScroll: true }); suppressFocus = false; };
  const cancelIntent = () => { view.clearTimeout(intent); intent = 0; };
  const setPhase = value => { phase = value; band.dataset.aithemaRevealState = value; };
  const setVariable = (name, value) => { if (!properties.has(name)) properties.set(name, [band.style.getPropertyValue(name), band.style.getPropertyPriority(name)]); band.style.setProperty(name, value); };
  // All geometry/style reads precede writes. Sparks reuse this snapshot, never measure on a frame.
  const measure = () => {
    const b = band.getBoundingClientRect(), r = trigger.getBoundingClientRect();
    // The host owns the hairline. Clip all glass effects at its lower edge, including an inset line.
    const bottom = Math.max(0, parseFloat(view.getComputedStyle(band, '::after').bottom) || 0), height = Math.max(0, b.height - bottom);
    const x = r.left + r.width / 2 - b.left, y = r.top + r.height / 2 - b.top;
    const sizes = items.flatMap(node => {
      const style = view.getComputedStyle(node);
      // Reserved slots are layout, not visible controls. Leave them untouched:
      // no dissolve clone, inert state, or stagger to paint a ghost on exit.
      if (style.visibility === 'hidden' || parseFloat(style.opacity) === 0 || !node.getClientRects().length) return [];
      const rect = node.getBoundingClientRect();
      const visual = ['display', 'align-items', 'justify-content', 'gap', 'padding', 'border', 'border-radius', 'background', 'color', 'font', 'line-height', 'box-shadow'].map(name => [name, style.getPropertyValue(name)]);
      return [{ node, rect, opacity: style.opacity, transform: style.transform, visual }];
    });
    const radius = Math.max(1, Math.hypot(x, y), Math.hypot(b.width - x, y), Math.hypot(x, height - y), Math.hypot(b.width - x, height - y));
    // Match the reference's 2400px circle without allocating a 4800px backing element.
    const openRadius = Math.max(2400, radius);
    geometry = { x, y, left: b.left, top: b.top, width: b.width, height, sizes, radius };
    Object.entries({ '--ar-x': `${x}px`, '--ar-y': `${y}px`, '--ar-radius': `${radius}px`, '--ar-open-scale': openRadius / radius, '--ar-ring-scale': 70, '--ar-fx-bottom': `${bottom}px`,
      '--ar-top': `${(openRadius - y) / (2 * openRadius) * 100}%`, '--ar-bottom': `${(openRadius - y + height) / (2 * openRadius) * 100}%`,
      '--ar-row-left': `${r.right - b.left + 14}px`, '--ar-row-right': `${b.width < 760 ? 14 : 24}px` }).forEach(([name, value]) => setVariable(name, value));
  };
  const restoreControls = () => {
    for (const [node, { attributes, vars }] of saved) {
      restore(node, attributes); for (const [name, value, priority] of vars) value ? node.style.setProperty(name, value, priority) : node.style.removeProperty(name);
    }
    saved.clear(); dissolves?.remove(); dissolves = null;
  };
  const dissolveControls = () => {
    dissolves = document.createElement('div'); dissolves.className = 'aithema-reveal__dissolves'; dissolves.setAttribute('aria-hidden', 'true'); dissolves.inert = true;
    for (const { node, rect, opacity, transform, visual } of geometry.sizes) {
      const delay = Math.round(Math.max(0, rect.left - (geometry.x + 20 + geometry.left)) * .42);
      const vars = ['--ar-delay', '--ar-opacity', '--ar-transform'].map(name => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
      saved.set(node, { attributes: remember(node, ['inert', 'aria-hidden', 'data-aithema-reveal-control']), vars, delay });
      node.setAttribute('data-aithema-reveal-control', ''); node.inert = true; node.setAttribute('aria-hidden', 'true');
      node.style.setProperty('--ar-delay', `${delay}ms`); node.style.setProperty('--ar-opacity', opacity); node.style.setProperty('--ar-transform', transform);
      if (moving()) {
        const proxy = node.cloneNode(true); proxy.removeAttribute('data-aithema-reveal-control'); proxy.removeAttribute('data-reveal'); proxy.removeAttribute('id'); proxy.classList.add('aithema-reveal__proxy');
        proxy.querySelectorAll('[id]').forEach(child => child.removeAttribute('id')); proxy.querySelectorAll('style,script').forEach(child => child.remove());
        for (const [name, value] of visual) proxy.style.setProperty(name, value);
        Object.assign(proxy.style, { left: `${rect.left - geometry.left}px`, top: `${rect.top - geometry.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        dissolves.append(proxy);
      }
    }
    band.append(dissolves);
  };
  const stopParticles = (remove = false) => {
    view.cancelAnimationFrame(frame); view.clearInterval(ambient); frame = 0; ambient = 0; last = 0;
    if (remove) { canvas?.remove(); canvas = null; context = null; particles = []; }
  };
  const spawn = (x, y, burst) => {
    const angle = burst ? Math.random() * 1.5 - .75 + (Math.random() < .18 ? Math.PI : 0) : Math.random() * Math.PI * 2;
    const speed = burst ? .18 + Math.random() * .95 : .01 + Math.random() * .03;
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * .55, age: 0,
      life: burst ? 900 + Math.random() * 900 : 1400 + Math.random() * 1400, radius: burst ? .6 + Math.random() * 1.6 : .4 + Math.random() * .9,
      star: Math.random() < (burst ? .1 : .05), colour: ['255,255,255', '255,255,255', '255,244,226', '242,194,126'][Math.random() * 4 | 0], twinkle: Math.random() * 6 });
  };
  const paint = now => {
    if (destroyed || document.hidden || !moving() || !context) { frame = 0; return; }
    const dt = Math.min(40, last ? now - last : 0); last = now;
    context.clearRect(0, 0, geometry.width, geometry.height); particles = particles.filter(p => (p.age += dt) < p.life);
    for (const p of particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; const drag = .985 ** (dt / 16.667); p.vx *= drag; p.vy *= drag;
      const k = p.age / p.life; context.globalAlpha = Math.min(1, k * 6) * (1 - k) * (.65 + .35 * Math.sin(p.twinkle + p.age / 90));
      context.fillStyle = `rgb(${p.colour})`; context.shadowColor = `rgba(${p.colour},.8)`; context.shadowBlur = p.star ? 8 : 6; context.beginPath();
      if (p.star) {
        const r = p.radius * 3.2, s = p.radius * .55, { x, y } = p;
        context.moveTo(x, y - r); context.quadraticCurveTo(x + s, y - s, x + r, y); context.quadraticCurveTo(x + s, y + s, x, y + r);
        context.quadraticCurveTo(x - s, y + s, x - r, y); context.quadraticCurveTo(x - s, y - s, x, y - r);
      } else context.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1; context.shadowBlur = 0;
    frame = particles.length || phase === 'open' ? view.requestAnimationFrame(paint) : 0;
  };
  const startParticles = (burst = false) => {
    if (!moving() || document.hidden || phase !== 'open') return;
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.className = 'aithema-reveal__stars';
      try { context = canvas.getContext('2d'); } catch { context = null; }
      if (!context) { canvas = null; return; }
      const ratio = Math.min(view.devicePixelRatio || 1, 2); canvas.width = Math.round(geometry.width * ratio); canvas.height = Math.round(geometry.height * ratio); context.setTransform(ratio, 0, 0, ratio, 0, 0); fx.append(canvas);
    }
    if (burst) for (let n = 0; n < 42; n++) spawn(geometry.x, geometry.y, true);
    if (!ambient) ambient = view.setInterval(() => spawn(90 + Math.random() * Math.max(1, geometry.width - 110), 8 + Math.random() * Math.max(1, geometry.height - 16), false), 340);
    if (!frame) frame = view.requestAnimationFrame(paint);
  };
  const finishExit = () => {
    exitTimer = 0; if (phase !== 'exiting' || destroyed) return;
    restoreControls(); stopParticles(true); setPhase('closed'); glass.style.transform = ''; paused.clear();
  };
  const exitDuration = () => moving() ? Math.max(850, ...[...saved.values()].map(({ delay }) => 1020 + delay * .55)) : 200;
  const close = () => {
    cancelIntent(); if (destroyed || phase !== 'open') return;
    // Early leave holds the actual circle too. Expanding it to the final radius here would flash teal.
    const currentCircle = view.getComputedStyle(glass).transform;
    glass.style.transform = currentCircle === 'none' ? '' : currentCircle;
    setPhase('exiting'); trigger.setAttribute('aria-expanded', 'false'); row.setAttribute('aria-hidden', 'true');
    if (row.contains(active())) focusOrb(); row.inert = true;
    for (const [node, { attributes }] of saved) restore(node, attributes.filter(([name]) => name !== 'data-aithema-reveal-control'));
    trigger.dispatchEvent(new view.CustomEvent('aithema-orb-reveal', { detail: false }));
    view.clearInterval(ambient); ambient = 0; exitTimer = view.setTimeout(finishExit, exitDuration());
  };
  const open = () => {
    cancelIntent(); if (destroyed || !connected || document.hidden || phase === 'open') return;
    view.clearTimeout(exitTimer); exitTimer = 0;
    if (items.some(node => node.contains(active()))) focusOrb();
    if (phase === 'closed') { measure(); dissolveControls(); }
    for (const node of saved.keys()) { node.inert = true; node.setAttribute('aria-hidden', 'true'); }
    row.inert = false; row.removeAttribute('aria-hidden'); trigger.setAttribute('aria-expanded', 'true'); glass.style.transform = ''; setPhase('open');
    trigger.dispatchEvent(new view.CustomEvent('aithema-orb-reveal', { detail: true })); startParticles(true);
  };
  const visibility = () => {
    band.toggleAttribute('data-aithema-reveal-paused', document.hidden);
    if (document.hidden) {
      cancelIntent(); stopParticles();
      for (const animation of band.getAnimations?.({ subtree: true }) ?? []) if (animation.playState === 'running') { paused.add(animation); animation.pause(); }
    } else {
      for (const animation of paused) if (animation.playState === 'paused') animation.play(); paused.clear();
      if (phase === 'open') startParticles();
    }
  };
  const syncMotion = () => {
    band.dataset.aithemaRevealMotion = moving() ? 'on' : 'off';
    if (!moving()) stopParticles(true); else if (phase === 'open') startParticles();
    if (phase === 'exiting') { view.clearTimeout(exitTimer); exitTimer = view.setTimeout(finishExit, exitDuration()); }
  };
  const enter = () => { cancelIntent(); if (!document.hidden) intent = view.setTimeout(open, 350); };
  const focus = () => { if (!suppressFocus) open(); };
  const blur = event => { if (!band.contains(event.relatedTarget)) close(); };
  const keydown = event => {
    if (event.key === 'Escape' && (phase === 'open' || intent)) { event.preventDefault(); close(); }
    else if (event.composedPath().includes(trigger) && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
  };
  const resize = () => { if (phase === 'open') { measure(); stopParticles(true); startParticles(); } };
  const connect = () => {
    if (destroyed || connected) return; connected = true;
    trigger.addEventListener('mouseenter', enter); trigger.addEventListener('mouseleave', cancelIntent); trigger.addEventListener('focus', focus); trigger.addEventListener('click', open);
    band.addEventListener('mouseleave', close); band.addEventListener('focusout', blur); document.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', visibility); view.addEventListener('resize', resize); preference?.addEventListener('change', syncMotion);
    syncMotion(); visibility();
  };
  const disconnect = () => {
    if (!connected) return; connected = false;
    cancelIntent(); view.clearTimeout(exitTimer); exitTimer = 0; stopParticles(true); restoreControls(); setPhase('closed'); glass.style.transform = ''; paused.clear();
    row.inert = true; row.setAttribute('aria-hidden', 'true'); trigger.setAttribute('aria-expanded', 'false');
    trigger.removeEventListener('mouseenter', enter); trigger.removeEventListener('mouseleave', cancelIntent); trigger.removeEventListener('focus', focus); trigger.removeEventListener('click', open);
    band.removeEventListener('mouseleave', close); band.removeEventListener('focusout', blur); document.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', visibility); view.removeEventListener('resize', resize); preference?.removeEventListener('change', syncMotion);
    trigger.dispatchEvent(new view.CustomEvent('aithema-orb-reveal', { detail: false }));
  };
  connect();
  return {
    close, connect, disconnect,
    setMotion(on) { if (!destroyed) { requested = Boolean(on); syncMotion(); } },
    destroy() {
      if (destroyed) return; if (row.contains(active())) focusOrb(); disconnect(); destroyed = true;
      restore(trigger, triggerAttributes); restore(band, bandAttributes);
      for (const [name, [value, priority]] of properties) value ? band.style.setProperty(name, value, priority) : band.style.removeProperty(name);
      if (!hadClass) band.classList.remove('aithema-reveal-band'); band.style.position = originalPosition; style.remove(); fx.remove(); row.remove(); paused.clear();
    },
  };
}
