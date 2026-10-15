import { node, reconcile, setText } from './dom.js';
import { icon } from './icons.js';

// AIT-132, approved card: it grows above the dock without moving the composer below it.
export const questionCardStyles = `
.composer-dock { position:relative; min-width:0; }
.phone-dock-backdrop { display:none; }
/* Tick L2: keep the same composer slot over the footer. The overview remains
   in the page below the bounded transcript; scrolling it never loses input. */
@media(max-width:600px) {
  .workspace :is(.understanding,.transcript-shell) :is(button,a,input,textarea,select,[tabindex]) {
    scroll-margin-bottom:calc(var(--phone-dock,138px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-phone-keyboard] .display-foot { display:none; }
  /* Linux and macOS font metrics differ; reclaim spacing, keeping every target 44px. */
  .workspace[data-phone-keyboard] .conversation { row-gap:4px; }
  .workspace[data-stage="live"] { padding-bottom:calc(var(--phone-dock,138px) + var(--phone-footer,57px) + 24px); }
  .workspace[data-stage="live"] .conversation {
    height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,138px) - 36px);
    min-height:0; grid-template-rows:auto minmax(0,1fr); }
  .workspace[data-stage="live"] .transcript-shell { height:auto; min-height:0; }
  .transcript-shell > .voice-notices { height:auto; margin-top:8px; }
  .workspace[data-stage="live"] .phone-dock-backdrop { display:block; position:fixed; z-index:8;
    left:0; right:0; bottom:var(--phone-bottom,0px);
    height:calc(var(--phone-dock,138px) + var(--phone-footer,57px) + 24px); background:var(--aithema-paper);
    mask-image:linear-gradient(to bottom,transparent,#000 12px); }
  .workspace[data-stage="live"] .composer-dock { position:fixed; z-index:9;
    left:var(--aithema-gutter); right:var(--aithema-gutter);
    bottom:calc(var(--phone-bottom,0px) + var(--phone-footer,57px) + 12px); }
}

.workspace:not([data-stage="live"]) .composer-dock { display:none; }
.qcard { position:absolute; inset:auto 0 100%; z-index:2; display:grid; gap:8px;
  padding:14px 16px 12px; border-radius:18px 18px 0 0; max-height:min(440px,calc(100dvh - 280px));
  overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--aithema-line-strong) transparent;
  background:color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-surface));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--aithema-accent) 28%,transparent); }
.qcard:not([hidden]) + .composer, .qcard:not([hidden]) + .composer-shell, .qcard:not([hidden]) + .composer-shell :is(.composer,.composer-out) { border-radius:0 0 18px 18px; }
.qhead { display:flex; align-items:center; gap:7px; color:var(--aithema-accent); font:600 13px var(--aithema-font); }
.qtext { margin:0; font-size:15.5px; line-height:1.4; text-wrap:balance; overflow-wrap:anywhere; }
.qopts { display:grid; gap:2px; margin-top:2px; }
.qopt { display:grid; grid-template-columns:minmax(0,1fr) auto 30px; align-items:center; gap:10px;
  min-height:44px; padding:0 10px; border:0; border-radius:10px; background:transparent; color:var(--aithema-ink);
  font:14.5px var(--aithema-font); text-align:left; }
.qopt .t { overflow-wrap:anywhere; }
.qopt:hover:not(:disabled):not([aria-disabled="true"]) { background:color-mix(in srgb,var(--aithema-accent) 10%,transparent); }
.qopt .go { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; color:var(--aithema-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--aithema-accent) 40%,transparent); }
.qopt .go svg { width:14px; height:14px; }
.qopt:hover:not(:disabled):not([aria-disabled="true"]) .go, .qopt:focus-visible .go, .qopt.likely .go {
  background:var(--aithema-accent); color:var(--aithema-on-accent); box-shadow:none; }
.qopt.likely, .qopt.likely:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-accent) 13%,transparent); font-weight:600; }
.qopt:focus-visible { border-radius:10px; outline-offset:-2px; }
.qopt[aria-disabled="true"] { opacity:.5; cursor:wait; }
.qopt .tag { font:500 11.5px var(--aithema-font); color:var(--aithema-accent); }
.qhint { margin:0; padding-left:10px; font-size:12.5px; color:var(--aithema-muted); }
.transcript-shell { padding-bottom:calc(1.5rem + var(--aithema-slack-bottom,0px) + var(--question-card-height,0px)); }
`;

export const questionCardMarkup = `<div class="question-card qcard" hidden role="group" aria-labelledby="qtitle" aria-describedby="qtext qhint">
  <div class="qhead"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.5-5.2A8.5 8.5 0 1 1 21 12z"/><path d="M9.7 9.3a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.9-1.1 1.6v.4M12 16.3v.1"/></svg><span id="qtitle"></span></div>
  <p class="qtext" id="qtext"></p><div class="qopts"></div><p class="qhint" id="qhint"></p>
</div>`;

/** Reconcile by reply and option identity; incoming assessments never replace a focused row. */
export class QuestionCard {
  constructor({ root, send, onResize }) {
    this.root = root; this.card = root.querySelector('.qcard'); this.answers = new WeakMap(); this.onResize = onResize;
    this.card.addEventListener('click', event => {
      const button = event.target.closest('.qopt');
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && this.answers.has(button)) send(this.answers.get(button));
    });
    this.connect();
  }
  connect() {
    const Resize = this.root.ownerDocument.defaultView?.ResizeObserver;
    if (Resize) { this.observer ??= new Resize(() => this.reserve()); this.observer.observe(this.card); }
  }
  reserve() {
    // Only the transcript's scroll room changes. The dock and every composer control stay fixed.
    const height = this.card.hidden ? 0 : this.card.getBoundingClientRect().height;
    if (this.height === height) return;
    this.height = height;
    this.root.querySelector('.conversation').style.setProperty('--question-card-height', `${height}px`);
    this.onResize?.();
  }
  update(question, copy, unavailable, sending = false) {
    const focused = this.card.contains(this.root.activeElement);
    this.card.hidden = !question;
    if (!question) {
      this.card.querySelector('.qopts').replaceChildren();
      setText(this.card.querySelector('.qtext'), '');
      this.reserve();
      if (focused) this.root.querySelector('textarea').focus({ preventScroll: true });
      return;
    }
    const c = copy.questionCard;
    setText(this.card.querySelector('#qtitle'), c.heading);
    setText(this.card.querySelector('.qtext'), question.question_short);
    setText(this.card.querySelector('.qhint'), c.hint);
    const options = question.options.map((option, index) => ({ ...option, index }))
      .sort((a, b) => Number(b.likely === true) - Number(a.likely === true));
    reconcile(this.card.querySelector('.qopts'), options.map(option => [`${question.turnId}:${option.index}`, option]), () => {
      const button = node('button', 'qopt'); button.type = 'button'; button.setAttribute('aria-describedby', 'qhint ai-notice');
      const arrow = node('span', 'go'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
      button.append(node('span', 't'), node('span', 'tag'), arrow); return button;
    }, (button, option) => {
      // A pending answer remains focused until its persisted turn closes the card.
      // Native disabled is reserved for unavailable text input; aria-disabled blocks repeat submissions.
      this.answers.set(button, option.text); button.disabled = unavailable;
      button.setAttribute('aria-disabled', String(sending));
      button.classList.toggle('likely', option.likely === true);
      setText(button.querySelector('.t'), option.text); setText(button.querySelector('.tag'), option.likely ? c.suggestion : '');
      button.title = option.likely ? c.likely : '';
    });
    this.reserve();
  }
  destroy() { this.observer?.disconnect(); }
}
