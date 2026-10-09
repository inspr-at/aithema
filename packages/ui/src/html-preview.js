// Generated HTML click-dummies render only here: an opaque-origin frame
// (sandbox="allow-scripts", nothing else) whose srcdoc starts with a strict CSP.
// The frame cannot read this page's DOM, cookies or storage and cannot fetch.
import { HTML_MEDIA_TYPE, HTML_PREVIEW_CSP, inspectHTML } from '../../core/src/ui-html.js';
export { HTML_PREVIEW_HOST_CSP } from '../../core/src/ui-html.js';
export const PREVIEW_SANDBOX = 'allow-scripts';
const verifiedPolicies = new WeakMap();
// The host declares the enforced policy in its head as well as its HTTP header.
// Inspect the first occurrence of each directive: CSP ignores later duplicates.
const declaresHostPolicy = document => [...document.head.querySelectorAll('meta[http-equiv]')].some(meta =>
  meta.getAttribute('http-equiv').toLowerCase() === 'content-security-policy' && framePolicy(meta.content));
function framePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/u);
    if (!directives.has(name)) directives.set(name, values.join(' '));
  }
  return directives.get('frame-src') === "'none'" && directives.get('child-src') === "'none'";
}
function verifyHostPolicy(document) {
  if (!declaresHostPolicy(document)) return Promise.resolve(false);
  if (verifiedPolicies.has(document)) return verifiedPolicies.get(document);
  const verification = new Promise(resolve => {
    const probe = document.createElement('iframe');
    probe.hidden = true; probe.setAttribute('sandbox', PREVIEW_SANDBOX);
    probe.setAttribute('data-aithema-html-policy-probe', '');
    // A scriptless data destination never touches a socket, even without CSP.
    // The event must prove enforcement by the *host* frame-src/child-src policy;
    // neither a report-only event nor the draft's own default-src can authorize it.
    const finish = ok => { clearTimeout(timer); document.removeEventListener('securitypolicyviolation', violation); probe.remove(); resolve(ok); };
    const violation = event => {
      if (event.isTrusted && event.disposition === 'enforce' && ['frame-src', 'child-src'].includes(event.effectiveDirective) &&
        event.blockedURI === 'data' && framePolicy(event.originalPolicy)) finish(true);
    };
    const timer = setTimeout(() => finish(false), 1500);
    document.addEventListener('securitypolicyviolation', violation);
    probe.srcdoc = '<!doctype html><script>self.location.href="data:text/html,%3Ctitle%3Epolicy%20probe%3C/title%3E"</script>';
    document.body.append(probe);
  });
  verifiedPolicies.set(document, verification); return verification;
}
// Powerful features stay off even where a browser would delegate them.
const PERMISSIONS = ['camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read', 'clipboard-write', 'payment', 'usb',
  'serial', 'hid', 'bluetooth', 'midi', 'publickey-credentials-get', 'screen-wake-lock', 'fullscreen'].map(f => `${f} 'none'`).join('; ');
export const previewCopy = Object.freeze({ label: 'Draft — generated', title: 'Generated click-dummy draft', width: 'Preview width',
  wide: 'Wide', phone: 'Phone', empty: 'No draft yet.', invalid: 'This draft cannot be shown safely.',
  navigated: 'The draft tried to open another page and was stopped.',
  policy: 'The host page must block frame navigation before drafts can be shown.' });
/** The srcdoc: standards mode, then the CSP before any content of the dummy. */
export function frameDocument(html) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${
    html.replace(/^\s*<!doctype[^>]*>/iu, '')}`;
}
const styles = `
:host { display:block; color:var(--aithema-ink,#243b40); font:1rem/1.5 var(--aithema-font,system-ui,sans-serif);
  --preview-height:var(--aithema-preview-height,min(48rem,80svh)); --preview-phone:var(--aithema-preview-phone,390px); }
* { box-sizing:border-box; } [hidden] { display:none !important; }
.bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem 1rem; min-height:2.75rem; padding-bottom:.5rem; }
.label { display:flex; align-items:center; gap:.4rem; font-weight:600; font-size:.85rem; }
.label svg { width:1rem; height:1rem; flex:none; }
.seg { display:inline-flex; border:1px solid var(--aithema-line,#d5dfda); border-radius:.5rem; overflow:hidden; }
.seg button { font:inherit; font-size:.85rem; color:inherit; background:transparent; border:0; min-height:2.25rem; padding:0 .85rem; cursor:pointer; }
.seg button + button { border-left:1px solid var(--aithema-line,#d5dfda); }
.seg button:hover { background:color-mix(in srgb,var(--aithema-accent,#227c78) 6%,transparent); }
.seg button[aria-checked="true"] { background:color-mix(in srgb,var(--aithema-accent,#227c78) 12%,transparent); color:var(--aithema-accent,#227c78); font-weight:600; }
:focus-visible { outline:2px solid var(--aithema-accent,#227c78); outline-offset:2px; } .seg button:focus-visible { outline-offset:-3px; }
.stage { position:relative; height:var(--preview-height); border:1px solid var(--aithema-line,#d5dfda); border-radius:.5rem; overflow:hidden;
  background:var(--aithema-paper,#f7f5ef); contain:strict; }
iframe { position:absolute; top:0; bottom:0; left:50%; transform:translateX(-50%); width:100%; height:100%; border:0; background:#fff; display:block; }
.stage[data-width="phone"] iframe { width:min(var(--preview-phone),100%); box-shadow:0 0 0 1px var(--aithema-line,#d5dfda); }
iframe:focus-visible { outline:2px solid var(--aithema-accent,#227c78); outline-offset:-2px; }
.state { position:absolute; inset:0; margin:0; display:grid; place-items:center; padding:1.5rem; text-align:center; color:var(--aithema-muted,#5d6e71); }
@media (pointer:coarse) { .seg button { min-height:2.75rem; } }
`;
const DRAFT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l1-3.5L10.5 3 13 5.5 6.5 12z M9.5 4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
export class AithemaHTMLPreview extends HTMLElement {
  #copy = previewCopy; #artifact = null; #width = 'wide'; #frame = null; #frameFocused = false; #renderId = 0; #refocus = false;
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    root.innerHTML = `<style>${styles}</style><div class="bar"><span class="label">${DRAFT_ICON}<span class="label-text"></span></span>
      <div class="seg" role="radiogroup"><button type="button" role="radio" data-width="wide"></button><button type="button" role="radio" data-width="phone"></button></div></div>
      <div class="stage"><p class="state" role="status"></p></div>`;
    const seg = root.querySelector('.seg');
    seg.addEventListener('click', event => { const button = event.target.closest('button'); if (button) this.width = button.dataset.width; });
    seg.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); this.width = this.#width === 'wide' ? 'phone' : 'wide';
      seg.querySelector(`[data-width="${this.#width}"]`).focus();
    });
    this.#text(); this.#render();
  }
  set copy(value) { this.#copy = { ...previewCopy, ...value }; this.#text(); this.#render(); }
  get copy() { return this.#copy; }
  get width() { return this.#width; }
  /** Wide or phone; the stage keeps its size, only the frame's width changes. */
  set width(value) { if (!['wide', 'phone'].includes(value)) return; this.#width = value; this.#text(); }
  get artifact() { return this.#artifact; }
  /** `{bytes, mediaType}` of an html artifact (extra fields ignored) or null. */
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
    this.#frame?.setAttribute('title', this.#copy.title);
  }
  #show(state) {
    this.setAttribute('state', state);
    const message = this.shadowRoot.querySelector('.state');
    message.hidden = state === 'ready'; message.textContent = state === 'ready' ? '' : this.#copy[state];
  }
  #discard() {
    const hadFocus = this.#frameFocused || this.#frame !== null && this.ownerDocument.activeElement === this && this.shadowRoot.activeElement === this.#frame;
    this.#frame?.remove(); this.#frame = null; this.#frameFocused = false; return hadFocus;
  }
  #render() {
    const value = this.#artifact, renderId = ++this.#renderId;
    this.#refocus = this.#discard() || this.#refocus;
    const reject = state => { this.#show(state); if (this.#refocus) this.shadowRoot.querySelector('.seg [aria-checked="true"]').focus(); this.#refocus = false; };
    if (!value) return reject('empty');
    const html = value.mediaType === HTML_MEDIA_TYPE && inspectHTML(value.bytes).ok ? new TextDecoder().decode(value.bytes) : null;
    if (html === null) return reject('invalid');
    this.#show('policy');
    if (!this.isConnected) return;
    void verifyHostPolicy(this.ownerDocument).then(verified => {
      if (renderId !== this.#renderId || !this.isConnected) return;
      if (!verified || !declaresHostPolicy(this.ownerDocument)) return reject('policy');
      const hadFocus = this.#refocus; this.#refocus = false; this.#mount(html, hadFocus);
    });
  }
  #mount(html, hadFocus) {
    // A fresh browsing context per draft; the sandbox is set before the document is assigned.
    const frame = this.ownerDocument.createElement('iframe');
    frame.setAttribute('sandbox', PREVIEW_SANDBOX); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', PERMISSIONS); frame.setAttribute('title', this.#copy.title);
    // The frame element holds focus while the draft's content does; a replacement keeps it.
    frame.addEventListener('focus', () => { if (frame === this.#frame) this.#frameFocused = true; });
    frame.addEventListener('blur', () => { if (frame === this.#frame) this.#frameFocused = false; });
    // Host CSP blocks navigation before a request or destination script runs;
    // counting loads cannot establish containment and is no longer needed.
    frame.setAttribute('srcdoc', frameDocument(html));
    this.#frame = frame; this.shadowRoot.querySelector('.stage').prepend(frame); this.#show('ready');
    if (hadFocus) frame.focus();
  }
}
if (!customElements.get('aithema-html-preview')) customElements.define('aithema-html-preview', AithemaHTMLPreview);
