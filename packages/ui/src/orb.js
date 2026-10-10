// The orb, adapted from START src/components/Orb.astro, src/scripts/orb.ts and the orb layer of
// src/styles/app.css (INSPR rights, D3). One object: the entrance shows it, and during a call the
// same element is the voice avatar. WebGL draws the fluid field when it mounts; the three drifting
// CSS layers stay underneath as the complete fallback. The shader constants were tuned by hand
// against START's comparison board and are kept as they are.
const VERTEX = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos,0.0,1.0); }';
const FRAGMENT = `
precision highp float;
uniform float uTime, uEnergy, uOct;
uniform vec2  uResolution;
uniform vec3  uC1, uC2, uC3;
const float FLUID = 0.40; const float ROT = 0.525; const float TILT = 0.3375; const float SOFT = 10.0;
const float SIZE = 1.10; const float DEPTH = 0.75; const float LIFT = 0.75; const float EDGE = 0.0175;
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy)); vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1; i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0,i1.y,1.0)) + i.x + vec3(0.0,i1.x,1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0*fract(p * C.www) - 1.0; vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5); vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g; g.x = a0.x*x0.x + h.x*x0.y; g.yz = a0.yz*x12.xz + h.yz*x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p){
  float f = 0.0, amp = 0.5;
  for (int i = 0; i < 3; i++) { if (float(i) >= uOct) break; f += amp*snoise(p); p *= 1.9; amp *= 0.5; }
  return f;
}
vec3 rotY(vec3 p, float a){ float s=sin(a),c=cos(a); return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z); }
vec3 rotX(vec3 p, float a){ float s=sin(a),c=cos(a); return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z); }
void field(vec2 uv, vec3 home, vec3 colour, float seed, float t, out vec3 premul, out float cover) {
  vec3 p = rotY(home, t * ROT);
  p = rotX(p, TILT * sin(t * 0.21 + seed));
  p.xy += vec2(fbm(vec2(seed, t*0.13)), fbm(vec2(seed+5.3, t*0.11))) * FLUID;
  float near = 0.5 + 0.5 * p.z;
  float radius = SIZE * (1.0 + DEPTH * (near - 0.5)) * (1.0 + uEnergy * 0.07);
  float d = length(uv - p.xy) / max(radius, 0.02);
  float g = exp(-d * d * SOFT);
  cover = g * (1.0 - DEPTH * 0.35 * (1.0 - near));
  vec3 lit = mix(colour, min(colour + vec3(0.55), vec3(1.0)), LIFT * exp(-d * d * SOFT * 1.6));
  premul = lit * cover;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  vec3 p1, p2, p3; float a1, a2, a3;
  field(uv, vec3(-0.16,  0.13,  0.30), uC1, 0.0,  uTime, p1, a1);
  field(uv, vec3( 0.18, -0.06, -0.28), uC2, 4.0,  uTime, p2, a2);
  field(uv, vec3( 0.02, -0.20,  0.10), uC3, 11.0, uTime, p3, a3);
  float sum = a1 + a2 + a3;
  float alpha = 1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3);
  vec3 premul = (p1 + p2 + p3) * (sum > 0.0001 ? alpha / sum : 0.0);
  float aa = 1.5 / min(uResolution.x, uResolution.y);
  float mask = smoothstep(0.5, 0.5 - max(aa, EDGE), length(uv));
  float energy = 0.90 + uEnergy * 0.08;
  gl_FragColor = vec4(premul * mask * energy, clamp(alpha * mask * energy, 0.0, 1.0));
}`;
// Teal, apricot and a translucent white lightening field; seconds of shader time per real second;
// how fast the drawn energy follows the measured level, so speech cannot make it jitter.
const COLOURS = [[0x12 / 255, 0x90 / 255, 0x8c / 255], [0xff / 255, 0xb4 / 255, 0x5e / 255], [1, 1, 1]];
const TIME_SCALE = 1.28, ENERGY_SMOOTHING = 0.03;

export const orbStyles = `
.orb { --orb-size:clamp(15rem,34vw,27rem); --orb-energy:0; position:relative; width:var(--orb-size); height:var(--orb-size); flex:none; isolation:isolate; }
.orb__layer { position:absolute; inset:0; border-radius:50%; filter:blur(calc(var(--orb-size) * .035 + var(--orb-energy) * 10px)); will-change:transform,opacity; }
.orb--fluid > canvas { position:absolute; inset:0; width:100%; height:100%; border-radius:50%; }
/* The canvas is translucent by design; the fallback fields under it would muddy its colours. */
.orb--fluid > .orb__layer { display:none; }
/* Mutually prime durations, so the field never visibly loops. */
.orb__layer--a { background:radial-gradient(circle at 38% 34%,rgba(18,144,140,.92),rgba(18,144,140,0) 62%); animation:orb-drift-a 23s ease-in-out infinite; }
.orb__layer--b { background:radial-gradient(circle at 66% 58%,rgba(255,180,94,.72),rgba(255,180,94,0) 58%); animation:orb-drift-b 31s ease-in-out infinite; }
.orb__layer--c { background:radial-gradient(circle at 52% 72%,rgba(244,124,91,.58),rgba(244,124,91,0) 56%); animation:orb-drift-c 19s ease-in-out infinite; }
/* A hairline ring gives the diffuse field an edge, so it reads as an object rather than a smudge. */
.orb__ring { position:absolute; inset:4%; border-radius:50%; border:1px solid var(--aithema-line-strong); opacity:calc(.5 + var(--orb-energy) * .5);
  transform:scale(calc(1 + var(--orb-energy) * .04)); transition:opacity 120ms linear,transform 120ms linear; }
.orb__core { position:absolute; inset:30%; border-radius:50%; background:radial-gradient(circle at 42% 38%,rgba(255,252,248,.9),rgba(255,252,248,0) 70%);
  opacity:calc(.35 + var(--orb-energy) * .65); transition:opacity 90ms linear; }
/* Speaking without a measured level: the ring breathes instead (a static ring under reduced motion). */
.orb[data-voice="speaking"]:not([data-measured]) .orb__ring { animation:orb-speak .76s ease-in-out infinite alternate; }
@keyframes orb-speak { to { opacity:1; transform:scale(1.04); } }
@keyframes orb-drift-a { 0%,100% { transform:translate3d(0,0,0) scale(1); } 50% { transform:translate3d(6%,-5%,0) scale(1.08); } }
@keyframes orb-drift-b { 0%,100% { transform:translate3d(0,0,0) scale(1.04); } 50% { transform:translate3d(-7%,4%,0) scale(.95); } }
@keyframes orb-drift-c { 0%,100% { transform:translate3d(0,0,0) scale(.98); } 50% { transform:translate3d(3%,7%,0) scale(1.1); } }
@media(prefers-reduced-motion:reduce) { .orb__layer, .orb__ring { animation:none !important; transition:none; } .orb[data-voice="speaking"] .orb__ring { opacity:1; } }
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type); if (!shader) return null;
  gl.shaderSource(shader, source); gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}
/**
 * Attaches the WebGL field to `host` and drives it, or returns null (no WebGL, no observers, a shader
 * that will not link); the caller then keeps the CSS orb: the worst case is the fallback, never a hole.
 */
function mountFluid(host) {
  const view = host.ownerDocument.defaultView;
  if (!view?.ResizeObserver || !view.IntersectionObserver || !view.requestAnimationFrame) return null;
  const canvas = host.ownerDocument.createElement('canvas');
  let gl;
  try { gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true }); } catch { return null; }
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX), fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = vs && fs ? gl.createProgram() : null;
  if (!program) return null;
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = name => gl.getUniformLocation(program, name);
  const uTime = uniform('uTime'), uEnergy = uniform('uEnergy'), uOct = uniform('uOct'), uResolution = uniform('uResolution');
  COLOURS.forEach((colour, index) => gl.uniform3f(uniform(`uC${index + 1}`), ...colour));
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  host.append(canvas);
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let visible = true, clock = 0, last = 0, energy = 0, smoothed = 0, frame = 0, painted = false, destroyed = false;
  const resize = () => {
    const rect = host.getBoundingClientRect(), ratio = Math.min(view.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height); gl.uniform2f(uResolution, width, height);
    // Small instances lose nothing visible from fewer octaves and cost less.
    gl.uniform1f(uOct, rect.width < 110 ? 2 : 3); painted = false;
  };
  const sizes = new view.ResizeObserver(resize), views = new view.IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
  sizes.observe(host); views.observe(host); resize();
  const render = ms => {
    frame = view.requestAnimationFrame(render);
    const dt = last ? Math.min((ms - last) / 1000, .1) : 0; last = ms;
    if (!visible || host.ownerDocument.visibilityState !== 'visible') return;
    // Reduced motion still gets the object, just not the movement.
    if (reduced?.matches) { if (painted) return; painted = true; clock = 8; smoothed = energy; }
    else { clock += dt * TIME_SCALE; smoothed += (energy - smoothed) * ENERGY_SMOOTHING; }
    gl.uniform1f(uTime, clock); gl.uniform1f(uEnergy, smoothed); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  frame = view.requestAnimationFrame(render);
  const destroy = (release = true) => {
    if (destroyed) return; destroyed = true;
    canvas.removeEventListener('webglcontextlost', lost); view.cancelAnimationFrame(frame); sizes.disconnect(); views.disconnect();
    gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs); canvas.remove();
    host.classList.remove('orb--fluid');
    if (release) gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  // A lost context reveals the CSS layers at once.
  const lost = event => { event.preventDefault(); destroy(false); };
  canvas.addEventListener('webglcontextlost', lost);
  return { setEnergy(value) { energy = value; painted = false; }, destroy };
}

/** The orb element; `voice` mirrors the call state, `energy` (0 at rest, up to 1) the audible reply. */
export function createOrb(document) {
  const element = document.createElement('div'); element.className = 'orb'; element.setAttribute('aria-hidden', 'true');
  element.innerHTML = '<div class="orb__layer orb__layer--a"></div><div class="orb__layer orb__layer--b"></div><div class="orb__layer orb__layer--c"></div><div class="orb__ring"></div><div class="orb__core"></div>';
  let fluid = null;
  return {
    element,
    mount() { if (fluid || !element.isConnected) return; fluid = mountFluid(element); if (fluid) element.classList.add('orb--fluid'); },
    setVoice(state) { if (element.dataset.voice !== state) element.dataset.voice = state; },
    setEnergy(value, measured = true) {
      const energy = Math.min(1, Math.max(0, Number(value) || 0));
      element.style.setProperty('--orb-energy', String(energy)); element.toggleAttribute('data-measured', measured); fluid?.setEnergy(energy);
    },
    destroy() { fluid?.destroy(); fluid = null; },
  };
}
