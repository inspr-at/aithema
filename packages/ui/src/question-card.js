import { node, reconcile, setText } from './dom.js';
import { icon } from './icons.js';

// The card and composer share a dock; only the visible card takes transcript room.
export const questionCardStyles = `
.composer-dock { position:relative; min-width:0; }
.phone-dock-backdrop { display:none; }
/* Without a visual rail, the transcript and composer own the two remaining rows. */
.workspace[data-stage="live"]:not(:has(.audio-rail)) .conversation:has(> .concept-bar[data-no-drafts]) { grid-template-rows:minmax(0,1fr) auto; }
@media(max-width:600px) {
  .workspace[data-stage="live"]:not(:has(.audio-rail)) .conversation:has(> .concept-bar[data-no-drafts]) { grid-template-rows:minmax(0,1fr); }
}
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
    height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,138px) - 32px);
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
.qcard { position:absolute; inset:auto 0 100%; z-index:2; display:grid; grid-template-rows:auto minmax(0,1fr) auto; gap:8px;
  padding:14px 16px 12px; border-radius:18px 18px 0 0; max-height:min(440px,var(--question-card-limit,440px),calc(100dvh - 280px));
  overflow:hidden;
  background:color-mix(in srgb,var(--aithema-accent) 7%,var(--aithema-surface));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--aithema-accent) 28%,transparent); }
.qcard:not([hidden]) + .composer, .qcard:not([hidden]) + .composer-shell, .qcard:not([hidden]) + .composer-shell :is(.composer,.composer-out) { border-radius:0 0 18px 18px; }
/* Long summaries stay available to AT and in the assistant reply. */
.qtext { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; margin:0; font-size:15.5px; line-height:1.4; text-wrap:balance; overflow-wrap:anywhere; }
.qopts { display:grid; grid-auto-rows:max-content; align-content:start; min-height:0; gap:2px; margin-top:2px; overflow-y:auto; overscroll-behavior:contain;
  scrollbar-width:thin; scrollbar-color:var(--aithema-line-strong) transparent;
  --qfade-start:0px; --qfade-end:0px;
  mask-image:linear-gradient(to bottom,transparent,#000 var(--qfade-start),#000 calc(100% - var(--qfade-end)),transparent); }
.qopts[data-more-start] { --qfade-start:24px; }
.qopts[data-more-end] { --qfade-end:24px; }
.workspace[data-stage="live"] .conversation { row-gap:.5rem; }
.conversation:has(.qcard:not([hidden])) .transcript-shell { display:flex; flex-direction:column; padding-bottom:0; }
.conversation:has(.qcard:not([hidden])) .transcript-shell > ol { flex:none; margin-top:auto; }
.conversation:has(.qcard:not([hidden])) .transcript-shell > .voice-notices { flex:none; margin-top:0; }
.turn[data-start-only] { padding-block:0; }
.turn[data-start-only] > strong { display:none; }
.voice-signal[data-read-full] :is(.voice-state,.voice-caption,.voice-wave) { visibility:hidden; }
.band .audio-rail .voice-read-full-mini { position:absolute; inset:0; z-index:1; width:100%; height:44px; min-height:44px;
  padding:0; border:0; border-radius:0; background:none; font-size:12px; line-height:1.2;
  color:var(--aithema-accent); text-decoration:underline; }
.turn-read-full { position:sticky; bottom:0; display:block; min-height:44px; padding:8px 0;
  font-size:.8rem; color:var(--aithema-accent); text-decoration:underline; background:var(--aithema-paper); }
/* Latest is a floating action, never an invisible row below the last turn. */
.conversation:has(.qcard:not([hidden])) .transcript-latest { position:sticky; bottom:0; flex:none; align-self:flex-end;
  height:44px; margin:-44px 0 0 auto; }
@media(max-width:600px) {
  .qcard { max-height:min(35dvh,var(--question-card-limit,35dvh),calc(var(--phone-height,100dvh) - 220px)); padding:10px 12px; gap:6px; }
  .qcard:not([data-compact]) .qopts { min-height:var(--question-options-floor,66px); }
  /* When a vertical list cannot show a whole answer and a scroll hint, retain
     the question and one horizontal row. The next chip peeks into view. */
  .qcard[data-compact] { max-height:none; grid-template-rows:auto 44px; padding:6px 10px; gap:4px; }
  .qcard[data-compact] .qtext { -webkit-line-clamp:1; }
  .qcard[data-compact] .qopts { display:flex; gap:6px; height:44px; margin:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:none;
    mask-image:linear-gradient(to right,transparent,#000 var(--qfade-start),#000 calc(100% - var(--qfade-end)),transparent); }
  .qcard[data-compact] .qopt { flex:0 0 auto; max-width:calc(100% - 24px); grid-template-columns:minmax(0,1fr) 30px; }
  .qcard[data-compact] .qopt .t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .qcard[data-compact] .tag { display:none; }
  .qcard[data-compact] .qhint { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  /* A short keyboard viewport needs the input and its 44px actions on one row
     as well, leaving a strip of the latest reply above the answer chips. */
  /* This is a viewport decision, independent of the question's presence or size. */
  .workspace[data-phone-short][data-phone-overlay] .display-foot { display:none; }
  .workspace[data-phone-short] .composer { grid-template-columns:minmax(0,1fr) auto; padding:6px; gap:6px 2px; }
  .workspace[data-phone-short] textarea { height:44px; min-height:44px; padding-block:10px; }
  .workspace[data-phone-short] .composer-actions { gap:0; }
  .workspace[data-phone-short] .composer-shell:not([data-used-up]) .composer-out { position:absolute; inset:0; }
  .workspace[data-phone-short] .composer-reason { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  /* Keep its expanded height measurable without giving it a grid row or a
     focus/accessibility target while the compact transcript uses that space. */
  .workspace[data-question-compact] .concept-bar { position:absolute; inset:0 0 auto; visibility:hidden; pointer-events:none; }
  .workspace[data-question-compact] .conversation { row-gap:0; grid-template-rows:minmax(0,1fr);
    height:calc(var(--phone-height,100dvh) - var(--phone-band,128px) - var(--phone-footer,57px) - var(--phone-dock,58px) - 26px); }
  .workspace[data-question-compact] .transcript-shell { padding-block:4px; mask-image:none; }
  .workspace[data-question-compact] .transcript-shell > .voice-notices { margin-top:0; }
}
.qopt { display:grid; grid-template-columns:minmax(0,1fr) auto 30px; align-items:center; gap:10px;
  min-height:44px; padding:0 10px; border:0; border-radius:10px; background:transparent; color:var(--aithema-ink);
  font:14.5px var(--aithema-font); text-align:left; }
/* The dock's generic page scroll margins must not push rows out of this nested scrollport. */
.qcard .qopts .qopt { scroll-margin:2px; }
.qopt .t { overflow-wrap:anywhere; }
.qopt:hover:not(:disabled):not([aria-disabled="true"]) { background:color-mix(in srgb,var(--aithema-accent) 10%,transparent); }
.qopt .go { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; color:var(--aithema-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--aithema-accent) 40%,transparent); }
.qopt .go svg { width:14px; height:14px; }
.qopt:hover:not(:disabled):not([aria-disabled="true"]) .go, .qopt:focus-visible .go, .qopt.likely .go {
  background:var(--aithema-accent); color:var(--aithema-on-accent); box-shadow:none; }
.qopt.likely, .qopt.likely:hover:not(:disabled) { background:color-mix(in srgb,var(--aithema-accent) 13%,transparent); }
.qopt:focus-visible { border-radius:10px; outline-offset:-2px; }
.qopt[aria-disabled="true"] { opacity:.5; cursor:wait; }
.qopt .tag { font:500 11.5px var(--aithema-font); color:var(--aithema-accent); }
.qhint { margin:0; padding-left:10px; font-size:12.5px; color:var(--aithema-muted); }
/* Reserve outside the scrollport: even keyboard scrolling cannot put a bubble
   underneath the card. The grid gives up only transcript room, never the dock. */
.transcript-shell { margin-bottom:var(--question-card-height,0px); }
@media(min-width:601px) and (max-width:59.99rem) {
  .transcript-shell { height:calc(clamp(20rem,60svh,36rem) - var(--question-card-height,0px)); }
}
`;

export const questionCardMarkup = `<div class="question-card qcard" hidden role="group" aria-labelledby="qtitle" aria-describedby="qtext qhint">
  <span class="qhead visually-hidden" id="qtitle"></span>
  <p class="qtext" id="qtext"></p><div class="qopts" role="region" aria-labelledby="qtitle"></div><p class="qhint" id="qhint"></p>
</div>`;

/** Reconcile by reply and option identity; incoming assessments never replace a focused row. */
export class QuestionCard {
  constructor({ root, send, onResize, followsTranscript = () => true }) {
    this.root = root; this.card = root.querySelector('.qcard'); this.answers = new WeakMap(); this.onResize = onResize; this.followsTranscript = followsTranscript;
    this.card.addEventListener('click', event => {
      const button = event.target.closest('.qopt');
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && this.answers.has(button)) send(this.answers.get(button));
    });
    this.view = root.ownerDocument.defaultView;
    this.scheduleReserve = () => {
      if (this.frame != null) return;
      this.frame = this.view.requestAnimationFrame(() => {
        this.frame = null; this.reserve();
        if (!this.card.hidden && this.followsTranscript()) this.onResize?.({ following: true });
      });
    };
    this.viewportResize = () => {
      if ((this.view.visualViewport?.scale ?? 1) !== 1) return;
      this.followOnResize ??= this.followsTranscript();
      this.scheduleReserve();
    };
    this.optionsScroll = () => this.fadeOptions();
    this.connect();
  }
  connect() {
    this.card.querySelector('.qopts').addEventListener('scroll', this.optionsScroll, { passive: true });
    const Resize = this.root.ownerDocument.defaultView?.ResizeObserver;
    if (Resize) {
      this.observer ??= new Resize(this.scheduleReserve);
      this.observer.observe(this.card); this.observer.observe(this.card.querySelector('.qopts'));
      this.observer.observe(this.root.querySelector('.transcript-shell'));
      const list = this.root.querySelector('.transcript-shell ol');
      if (list) this.observer.observe(list);
    }
    this.view?.addEventListener('resize', this.viewportResize);
    this.view?.visualViewport?.addEventListener('resize', this.viewportResize);
  }
  reserve() {
    if (this.root.querySelector('.conversation').hidden) return;
    const shell = this.root.querySelector('.transcript-shell');
    const viewportChanged = this.followOnResize !== undefined;
    const following = this.followOnResize ?? this.followsTranscript();
    this.followOnResize = undefined;
    const phone = this.view?.matchMedia('(max-width:600px)').matches;
    const visual = this.view.visualViewport;
    const viewport = visual?.scale === 1 ? visual.height : this.view.innerHeight;
    const workspace = this.root.querySelector('.workspace');
    // 620px covers the keyboard-height range. Keep the input's box independent
    // of card state, including after its question has been answered.
    const short = phone && viewport <= 620;
    // Compute expanded capacity from fixed parts in either state. Compact keeps
    // the concept bar measurable outside the grid; changing the live scrollport
    // just to measure it would clamp the reader's scroll position.
    const conversation = this.root.querySelector('.conversation');
    // The compact grid has no gap; the turn list retains the expanded 8px
    // gap, including while the concept bar is measured outside that grid.
    const expandedGap = phone && workspace
      ? parseFloat(this.view.getComputedStyle(shell.querySelector('ol')).rowGap) : 0;
    const conceptHeight = phone && workspace ? this.root.querySelector('.concept-bar').getBoundingClientRect().height : 0;
    const available = phone && workspace
      ? viewport + (visual?.scale === 1 ? visual.offsetTop : 0)
        - this.root.querySelector('.band').getBoundingClientRect().height
        - this.root.querySelector('.display-foot').getBoundingClientRect().height
        - this.root.querySelector('.composer-dock').getBoundingClientRect().height
        - conceptHeight - expandedGap - 32
      : shell.getBoundingClientRect().height + (this.height ?? 0);
    const wasCompact = this.card.hasAttribute('data-compact');
    let compact = phone && short && !this.card.hidden;
    // Short viewports need no expanded measurement. Changing display here
    // would clamp a chip that native keyboard focus has just scrolled into view.
    if (!compact) this.card.removeAttribute('data-compact');
    let minimum = 150;
    if (phone && !this.card.hidden && !short) {
      const style = this.view.getComputedStyle(this.card);
      const rows = [...this.card.querySelectorAll('.qopt')];
      // A bounded list needs room for one complete option and its scroll cue.
      // Measure the translated card before allocating the remaining reply room.
      const floor = Math.max(66, Math.min(...rows.map(row => row.getBoundingClientRect().height + 22)));
      this.card.style.setProperty('--question-options-floor', `${floor}px`);
      minimum = floor + this.card.querySelector('.qtext').getBoundingClientRect().height
        + this.card.querySelector('.qhint').getBoundingClientRect().height
        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2 * parseFloat(style.rowGap) + 2;
    }
    // Include the 12px fade within the 28px clearance above the reply.
    // The two-row rail takes space from the transcript's spare minimum first.
    // Longer replies retain a bounded reading pane and the full-text dialog.
    const latest = shell.querySelector('.turn:last-child');
    const replyFloor = phone ? Math.max(84, 128 - Math.max(0, conceptHeight - 44)) : 128;
    // The read-full projection can hide the author or add a button. Neither
    // changes the reply's reading budget, nor should it resize the card again.
    this.replySizes ??= new WeakMap();
    const bounds = latest?.getBoundingClientRect(), text = latest?.querySelector('.turn-text')?.textContent;
    const readFull = latest?.querySelector('.turn-read-full:not([hidden])');
    const observed = (bounds?.height ?? 0) - (readFull?.getBoundingClientRect().height ?? 0);
    const known = latest && this.replySizes.get(latest);
    const replyHeight = known?.text === text && known.width === bounds?.width ? Math.max(known.height, observed) : observed;
    if (latest) this.replySizes.set(latest, { text, width: bounds.width, height: replyHeight });
    const replyRoom = Math.max(replyFloor, Math.min(replyHeight + 28, available - minimum));
    const limit = Math.max(0, available - replyRoom);
    if (available > 0) this.card.style.setProperty('--question-card-limit', `${limit}px`);
    if (phone && !this.card.hidden && !short) compact = Math.min(limit, .35 * viewport, viewport - 220) < minimum;
    this.card.toggleAttribute('data-compact', compact);
    workspace?.toggleAttribute('data-question-compact', compact);
    this.positionOptions(!wasCompact);
    this.fadeOptions();
    const height = this.card.hidden ? 0 : this.card.getBoundingClientRect().height;
    if (this.height === height) {
      if (viewportChanged && following) this.onResize?.({ following });
      return;
    }
    this.height = height;
    conversation.style.setProperty('--question-card-height', `${height}px`);
    this.onResize?.({ following });
  }
  fadeOptions() {
    const opts = this.card.querySelector('.qopts'), horizontal = this.card.hasAttribute('data-compact');
    const offset = horizontal ? opts.scrollLeft : opts.scrollTop;
    const end = horizontal ? opts.scrollWidth - opts.clientWidth : opts.scrollHeight - opts.clientHeight;
    opts.toggleAttribute('data-more-start', offset > 1);
    opts.toggleAttribute('data-more-end', end - offset > 1);
  }
  positionOptions(reset = false) {
    if (!this.card.hasAttribute('data-compact')) return;
    const opts = this.card.querySelector('.qopts'), active = this.root.activeElement;
    if (opts.contains(active)) active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    else if (reset) opts.scrollLeft = 0;
  }
  update(question, copy, unavailable, sending = false) {
    const focused = this.card.contains(this.root.activeElement);
    this.card.hidden = !question;
    if (!question) {
      this.card.querySelector('.qopts').replaceChildren();
      this.optionSet = undefined;
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
    const optionSet = JSON.stringify([question.turnId, options.map(({ text, likely, index }) => [index, text, likely === true])]);
    const optionsChanged = optionSet !== this.optionSet;
    const optionsFocused = this.card.querySelector('.qopts').contains(this.root.activeElement);
    this.optionSet = optionSet;
    reconcile(this.card.querySelector('.qopts'), options.map(option => [`${question.turnId}:${option.index}`, option]), () => {
      const button = node('button', 'qopt'); button.type = 'button'; button.setAttribute('aria-describedby', 'qhint ai-notice');
      const arrow = node('span', 'go'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
      button.append(node('span', 't'), node('span', 'tag'), arrow); return button;
    }, (button, option) => {
      // A pending answer remains focused until its persisted turn closes the card.
      // Native disabled is reserved for unavailable text input; aria-disabled blocks repeat submissions.
      this.answers.set(button, option.text); button.disabled = unavailable;
      button.setAttribute('aria-disabled', String(sending));
      button.setAttribute('aria-label', option.likely ? `${option.text}, ${c.suggestion}` : option.text);
      button.classList.toggle('likely', option.likely === true);
      setText(button.querySelector('.t'), option.text); setText(button.querySelector('.tag'), option.likely ? c.suggestion : '');
      button.title = option.likely ? c.likely : '';
    });
    this.reserve();
    this.positionOptions(optionsChanged && !optionsFocused);
    this.fadeOptions();
  }
  destroy() {
    this.observer?.disconnect();
    this.view?.removeEventListener('resize', this.viewportResize);
    this.view?.visualViewport?.removeEventListener('resize', this.viewportResize);
    this.card.querySelector('.qopts').removeEventListener('scroll', this.optionsScroll);
    if (this.frame != null) this.view.cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
