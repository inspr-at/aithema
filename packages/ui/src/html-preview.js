// Generated HTML click-dummies render only here: an opaque-origin frame
// (sandbox="allow-scripts", nothing else) served by the capability preview route.
// The frame cannot read this page's DOM, cookies or storage and cannot fetch.
import { HTML_MEDIA_TYPE, htmlPreviewHostPolicy } from '../../core/src/ui-html.js';
export { HTML_PREVIEW_HOST_CSP, frameDocument } from '../../core/src/ui-html.js';
export const PREVIEW_SANDBOX = 'allow-scripts';
const verifiedPolicies = new WeakMap();
const POLICY_PROBE = '[data-aithema-html-policy-probe]';
// Inspect first occurrences: CSP ignores duplicate directives. Only the canonical
// same-host route may be navigated to; schemes, origins and wildcards fail closed.
function framePolicy(policy, previewURL) {
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/u);
    if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values.join(' '));
  }
  return directives.get('frame-src') === previewURL && directives.get('child-src') === "'none'";
}
function verifyHostPolicy(document, previewURL) {
  let policies = verifiedPolicies.get(document);
  if (!policies) { policies = new Map(); verifiedPolicies.set(document, policies); }
  if (policies.has(previewURL)) return policies.get(previewURL);
  const verification = new Promise(resolve => {
    const probe = document.createElement('iframe');
    let pending = true;
    probe.hidden = true; probe.setAttribute('sandbox', PREVIEW_SANDBOX);
    probe.setAttribute('data-aithema-html-policy-probe', '');
    // A scriptless data destination never touches a socket, even without CSP.
    // The event must prove enforcement by the *host* frame-src/child-src policy;
    // neither a report-only event nor the draft's own default-src can authorize it.
    const finish = ok => {
      if (!pending) return;
      pending = false; clearTimeout(timer); document.removeEventListener('securitypolicyviolation', violation); probe.remove(); resolve(ok);
    };
    const violation = event => {
      // Chrome can redact a data destination to an empty string. Such an event
      // is usable only while this connected probe is the sole pending probe.
      const probes = document.querySelectorAll(POLICY_PROBE), uri = event.blockedURI;
      if (pending && probe.isConnected && probes.length === 1 && probes[0] === probe && event.isTrusted && event.disposition === 'enforce' &&
        ['frame-src', 'child-src'].includes(event.effectiveDirective) && framePolicy(event.originalPolicy, previewURL) &&
        (uri === '' || uri === 'data' || typeof uri === 'string' && uri.startsWith('data:'))) finish(true);
    };
    const timer = setTimeout(() => finish(false), 1500);
    document.addEventListener('securitypolicyviolation', violation);
    probe.src = 'data:text/html,%3Ctitle%3Epolicy%20probe%3C/title%3E';
    document.body.append(probe);
  });
  policies.set(previewURL, verification); return verification;
}
// Powerful features stay off even where a browser would delegate them.
const PERMISSIONS = ['camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read', 'clipboard-write', 'payment', 'usb',
  'serial', 'hid', 'bluetooth', 'midi', 'publickey-credentials-get', 'screen-wake-lock', 'fullscreen'].map(f => `${f} 'none'`).join('; ');
export const previewCopy = Object.freeze({ label: 'Draft, generated', title: 'Generated clickable draft', width: 'Preview width',
  wide: 'Wide', phone: 'Phone', empty: 'No draft yet.', invalid: 'This draft cannot be shown safely.',
  navigated: 'The draft tried to open another page and was stopped.',
  loading: 'Loading draft…', failure: 'The draft could not be loaded. Try closing and reopening it later.',
  policy: "Previews aren't enabled on this site.",
  policyOperator: 'For site operators: the exact preview address must be allowed as a frame.' });
const MESSAGE_STATES = ['empty', 'invalid', 'navigated', 'loading', 'failure', 'policy'];
const FRAME_READY = 'aithema-html-preview-ready';
// A private reply port distinguishes a served draft from an error document.
// It proves display readiness; the response and host CSP enforce containment.
const styles = `
:host { display:block; color:var(--aithema-ink,#243b40); font:1rem/1.5 var(--aithema-font,system-ui,sans-serif);
  --preview-height:var(--aithema-preview-height,min(48rem,80svh)); --preview-phone:var(--aithema-preview-phone,390px); }
* { box-sizing:border-box; } [hidden] { display:none !important; }
.bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem 1rem; min-height:2.75rem; padding-bottom:.5rem; }
.label { display:flex; align-items:center; gap:.4rem; font-weight:600; font-size:.85rem; }
.label svg { width:1rem; height:1rem; flex:none; }
/* GUI-27: two plain choices, not a boxed segment. The checked one shows a check in the slot both keep
   and turns accent; weight and size never change. */
.seg { display:inline-flex; gap:.15rem; }
.seg button { font:inherit; font-size:.85rem; font-weight:600; color:inherit; background:transparent; border:0; border-radius:.45rem;
  min-height:2.25rem; padding:0 .7rem; cursor:pointer; }
.seg button::before { content:'✓' / ''; display:inline-block; width:1.1em; visibility:hidden; }
.seg button:hover { background:color-mix(in srgb,var(--aithema-accent,#1d6e6a) 8%,transparent); }
.seg button[aria-checked="true"] { color:var(--aithema-accent,#1d6e6a); } .seg button[aria-checked="true"]::before { visibility:visible; }
:focus-visible { outline:2px solid var(--aithema-accent,#1d6e6a); outline-offset:2px; } .seg button:focus-visible { outline-offset:-3px; }
.stage { position:relative; height:var(--preview-height); border:1px solid var(--aithema-line,#d5dfda); border-radius:.5rem; overflow:hidden;
  background:var(--aithema-paper,#f7f5ef); contain:strict; }
iframe { position:absolute; top:0; bottom:0; left:50%; transform:translateX(-50%); width:100%; height:100%; border:0; background:#fff; display:block; }
.stage[data-width="phone"] iframe { width:min(var(--preview-phone),100%); box-shadow:0 0 0 1px var(--aithema-line,#d5dfda); }
iframe:focus-visible { outline:2px solid var(--aithema-accent,#1d6e6a); outline-offset:-2px; }
.state { position:absolute; inset:0; margin:0; display:grid; place-items:center; padding:1.5rem; text-align:center; color:var(--aithema-muted,#566669); }
/* Every locale's longest message and operator line reserve space in all states.
   Visibility keeps the 20px alert slot and message anchors fixed, even in ready. */
.state-content { display:grid; justify-items:center; gap:.5rem; width:100%; }
.state-icon { width:20px; height:20px; color:var(--aithema-muted,#566669); visibility:hidden; }
.state-text, .state-operator { display:grid; width:100%; }
.state-text > *, .state-operator > * { grid-area:1/1; }
.state-sizer { visibility:hidden; } .state-sizer::before { content:attr(data-reserve); }
.state-operator { font-size:.85rem; visibility:hidden; }
:host([state="ready"]) .state { visibility:hidden; pointer-events:none; }
:host([state="failure"]) .state-icon, :host([state="policy"]) .state-operator { visibility:visible; }
/* fill: the stage takes whatever height the host gives the element, e.g. a viewer row. */
:host([fill]) { display:grid; grid-template-rows:auto minmax(0,1fr); height:100%; min-height:0; }
:host([fill]) .stage { height:auto; min-height:0; }
@media (pointer:coarse) { .seg button { min-height:2.75rem; } }
`;
const DRAFT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l1-3.5L10.5 3 13 5.5 6.5 12z M9.5 4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ALERT_ICON = '<svg class="state-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2z M10 7v4.5 M10 14v.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export class AithemaHTMLPreview extends HTMLElement {
  #copy = previewCopy; #artifact = null; #width = 'wide'; #frame = null; #frameFocused = false; #renderId = 0; #refocus = false;
  #frameCleanup = null; #mintAbort = null;
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    root.innerHTML = `<style>${styles}</style><div class="bar"><span class="label">${DRAFT_ICON}<span class="label-text"></span></span>
      <div class="seg" role="radiogroup"><button type="button" role="radio" data-width="wide"></button><button type="button" role="radio" data-width="phone"></button></div></div>
      <div class="stage"><div class="state" role="status"><div class="state-content">${ALERT_ICON}
        <div class="state-text"><span class="state-message"></span>${MESSAGE_STATES.map(state => `<span class="state-sizer" data-state="${state}" aria-hidden="true"></span>`).join('')}</div>
        <div class="state-operator"><span class="operator-message"></span><span class="state-sizer" aria-hidden="true"></span></div>
      </div></div></div>`;
    const seg = root.querySelector('.seg');
    seg.addEventListener('click', event => { const button = event.target.closest('button'); if (button) this.width = button.dataset.width; });
    seg.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); this.width = this.#width === 'wide' ? 'phone' : 'wide';
      seg.querySelector(`[data-width="${this.#width}"]`).focus();
    });
    this.#text(); this.#render();
  }
  set copy(value) { this.#copy = { ...previewCopy, ...value }; this.#text(); this.#show(this.state ?? 'empty'); }
  get copy() { return this.#copy; }
  get width() { return this.#width; }
  /** Whether the shown draft holds keyboard focus (someone is working inside it). */
  get draftFocused() { return this.#frameFocused || this.#frame !== null && this.shadowRoot.activeElement === this.#frame; }
  /** Wide or phone; the stage keeps its size, only the frame's width changes. */
  set width(value) { if (!['wide', 'phone'].includes(value)) return; this.#width = value; this.#text(); }
  get artifact() { return this.#artifact; }
  /** `{mediaType, previewURL, mint(signal)}`; mint returns a fresh {url, expiresInMs}. No raw HTML fallback. */
  set artifact(value) { this.#artifact = value ?? null; this.#render(); }
  get state() { return this.getAttribute('state'); }
  connectedCallback() { this.#render(); }
  disconnectedCallback() { this.#renderId++; this.#discard(); }
  #text() {
    const root = this.shadowRoot, seg = root.querySelector('.seg');
    root.querySelector('.label-text').textContent = this.#copy.label;
    seg.setAttribute('aria-label', this.#copy.width);
    for (const button of seg.querySelectorAll('button')) {
      const on = button.dataset.width === this.#width;
      button.textContent = this.#copy[button.dataset.width]; button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
    }
    root.querySelector('.stage').dataset.width = this.#width;
    for (const sizer of root.querySelectorAll('.state-text .state-sizer')) sizer.dataset.reserve = this.#copy[sizer.dataset.state];
    root.querySelector('.state-operator .state-sizer').dataset.reserve = this.#copy.policyOperator;
    this.#frame?.setAttribute('title', this.#copy.title);
  }
  #show(state) {
    this.setAttribute('state', state);
    const message = this.shadowRoot.querySelector('.state');
    message.setAttribute('aria-hidden', String(state === 'ready'));
    message.querySelector('.state-message').textContent = state === 'ready' ? '' : this.#copy[state];
    message.querySelector('.operator-message').textContent = state === 'policy' ? this.#copy.policyOperator : '';
  }
  #discard() {
    this.#mintAbort?.abort(); this.#mintAbort = null;
    const hadFocus = this.#frameFocused || this.#frame !== null && this.ownerDocument.activeElement === this && this.shadowRoot.activeElement === this.#frame;
    this.#frameCleanup?.(); this.#frameCleanup = null;
    this.#frame?.remove(); this.#frame = null; this.#frameFocused = false; return hadFocus;
  }
  #render() {
    const value = this.#artifact, renderId = ++this.#renderId;
    this.#refocus = this.#discard() || this.#refocus;
    const reject = state => { this.#show(state); if (this.#refocus) this.shadowRoot.querySelector('.seg [aria-checked="true"]').focus(); this.#refocus = false; };
    if (!value) return reject('empty');
    let previewURL;
    try {
      previewURL = value.previewURL;
      htmlPreviewHostPolicy(previewURL);
      if (new URL(previewURL).origin !== new URL(this.ownerDocument.URL).origin) throw new Error();
    } catch { return reject('policy'); }
    if (value.mediaType !== HTML_MEDIA_TYPE || typeof value.mint !== 'function') return reject('invalid');
    this.#show('policy');
    if (!this.isConnected) return;
    const active = () => renderId === this.#renderId && this.isConnected;
    void (async () => {
      if (!await verifyHostPolicy(this.ownerDocument, previewURL) || !active()) return active() && reject('policy');
      this.#show('loading');
      const controller = new AbortController(); this.#mintAbort = controller;
      try {
        const source = await value.mint(controller.signal);
        if (!active() || controller.signal.aborted) return;
        const url = new URL(source.url);
        if (url.origin + url.pathname !== previewURL || url.hash || url.username || url.password ||
          [...url.searchParams.keys()].join() !== 'cap' || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('cap')) ||
          !Number.isFinite(source.expiresInMs) || source.expiresInMs <= 0 || source.expiresInMs > 60_000) throw new Error();
        const hadFocus = this.#refocus; this.#refocus = false; this.#mintAbort = null;
        this.#mount(url.href, hadFocus, source.expiresInMs);
      } catch { if (active() && !controller.signal.aborted) reject('failure'); }
    })();
  }
  #mount(url, hadFocus, expiresInMs) {
    // A fresh browsing context per draft; the sandbox is set before the document is assigned.
    const frame = this.ownerDocument.createElement('iframe');
    frame.setAttribute('sandbox', PREVIEW_SANDBOX); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', PERMISSIONS); frame.setAttribute('title', this.#copy.title);
    // The frame element holds focus while the draft's content does; a replacement keeps it.
    frame.addEventListener('focus', () => { if (frame === this.#frame) this.#frameFocused = true; });
    frame.addEventListener('blur', () => { if (frame === this.#frame) this.#frameFocused = false; });
    let loads = 0, preLoadTimer = null, readinessTimer = null, port = null, checking = false;
    const host = this.ownerDocument.defaultView;
    const stop = state => {
      if (frame !== this.#frame) return;
      const focused = this.#discard(); this.#show(state);
      if (focused) this.shadowRoot.querySelector('.seg [aria-checked="true"]').focus();
    };
    const navigated = () => stop('navigated');
    const checkReadiness = () => {
      if (frame !== this.#frame || checking) return;
      checking = true; clearTimeout(preLoadTimer);
      const channel = new MessageChannel(), reply = channel.port1; port = reply;
      reply.onmessage = event => {
        if (frame !== this.#frame || event.data !== FRAME_READY) return;
        clearTimeout(readinessTimer); reply.close(); port = null;
      };
      readinessTimer = setTimeout(navigated, 1500);
      frame.contentWindow.postMessage(FRAME_READY, '*', [channel.port2]);
    };
    // A message from this browsing context can precede load. It starts the
    // private-port check; it cannot itself prove that the route is ready.
    const firstMessage = event => {
      if (event.isTrusted && event.source === frame.contentWindow) checkReadiness();
    };
    this.#frameCleanup = () => {
      clearTimeout(preLoadTimer); clearTimeout(readinessTimer); port?.close();
      host?.removeEventListener('message', firstMessage);
    };
    // Late navigation loads again. An early blocked navigation can make the
    // *first* load a chrome-error document, which cannot answer the preview ping.
    frame.addEventListener('load', () => {
      if (frame !== this.#frame) return;
      if (++loads > 1) return navigated();
      checkReadiness();
    });
    host?.addEventListener('message', firstMessage);
    // Network/parse time has its own expiry-bounded budget. A slow response
    // fails with the ordinary retry state and never automatically re-mints.
    const preLoadBudget = Math.min(expiresInMs - Math.min(1000, expiresInMs / 10), 30_000);
    preLoadTimer = setTimeout(() => stop('failure'), preLoadBudget);
    frame.setAttribute('src', url);
    this.#frame = frame; this.shadowRoot.querySelector('.stage').prepend(frame); this.#show('ready');
    if (hadFocus) frame.focus();
  }
}
if (!customElements.get('aithema-html-preview')) customElements.define('aithema-html-preview', AithemaHTMLPreview);
