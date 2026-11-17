import { setText } from './dom.js';

export const MOTION_KEY = 'aithema-motion';
export function motionPreference(storage, reduced = false) {
  try {
    const saved = storage?.getItem(MOTION_KEY);
    if (saved === 'on' || saved === 'off') return saved === 'on';
  } catch { /* Storage is optional. */ }
  return !reduced;
}
export function rememberMotion(storage, on) {
  try { storage?.setItem(MOTION_KEY, on ? 'on' : 'off'); } catch { /* A blocked store never blocks the toggle. */ }
}

/** m:ss until one hour, then h:mm:ss. Wall time avoids interval drift and hidden-tab throttling. */
export function connectionTime(elapsedMs) {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  const tail = String(seconds % 60).padStart(2, '0'), minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${tail}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`;
}
export class ConnectionTimer {
  constructor(element, now = () => Date.now()) { this.element = element; this.now = now; this.since = null; }
  setConnected(on) {
    if (on === (this.since !== null)) return;
    this.destroy(); this.since = on ? this.now() : null;
    this.paint();
    if (on) { this.tick = setInterval(() => this.paint(), 1000); this.tick.unref?.(); }
  }
  paint() { setText(this.element, connectionTime(this.since === null ? 0 : this.now() - this.since)); }
  destroy() { clearInterval(this.tick); this.tick = null; }
}

// The boundaries are shared by the footer's container rules and its tests.
export const FOOTER_WIDTHS = Object.freeze({ voice: 1100, identity: 600, compact: 700, number: 360 });
export function footerMode(width) {
  return { voice: width >= FOOTER_WIDTHS.voice, identity: width >= FOOTER_WIDTHS.identity,
    limit: width >= FOOTER_WIDTHS.compact, connected: width >= FOOTER_WIDTHS.compact, unit: width >= FOOTER_WIDTHS.number };
}

function footerRowGeometry(footer) {
  const row = footer.querySelector('.display-foot__row'), bounds = row.getBoundingClientRect();
  const zones = [...row.children].map(zone => ({ hidden: zone.hidden, visible: Boolean(zone.getClientRects().length), box: zone.getBoundingClientRect() }));
  const boxes = zones.filter(zone => !zone.hidden && zone.visible).map(zone => zone.box);
  const clear = boxes.every((b, i) => b.left >= bounds.left && b.right <= bounds.right && (!i || boxes[i - 1].right <= b.left));
  return { zones: zones.map(({ hidden, box }) => [hidden, box.width]), clear };
}

/** Measure real host copy before yielding optional footer content, in Tick's order. */
export function fitFooter(footer) {
  for (const mode of ['full', 'identity', 'timer', 'role']) {
    footer.dataset.fit = mode;
    // Popup overlays can extend scrollWidth without occupying the footer row.
    if (footerRowGeometry(footer).clear) break;
  }
  return footer.dataset.fit;
}

// The timer uses tabular digits. Equal digit/colon shapes have equal widths;
// all other copy remains exact, including arbitrary host timer labels.
function footerText(row) {
  const walker = row.ownerDocument.createTreeWalker(row, 4), text = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent;
    text.push(node.parentElement?.closest('.connection-timer') && /^\d+:\d{2}(?::\d{2})?$/.test(value) ? value.replace(/\d/g, '0') : value);
  }
  return JSON.stringify(text);
}

// Compact labels have no visible width. Measure the full row offscreen only
// when its width-relevant content/geometry changes; never toggle the live fit to probe it.
function footerGeometry(footer, cache) {
  const row = footer.querySelector('.display-foot__row'), width = footer.clientWidth;
  const { zones, clear } = footerRowGeometry(footer);
  const compact = footer.dataset.fit && footer.dataset.fit !== 'full';
  let natural = [];
  if (compact) {
    const source = JSON.stringify([width, zones, footerText(row)]);
    if (cache.footerNaturalSource !== source) {
      const probe = footer.cloneNode(true);
      probe.dataset.fit = 'full'; probe.inert = true; probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText += `;position:fixed;left:-100000px;top:0;right:auto;bottom:auto;width:${width}px;opacity:0;pointer-events:none;`;
      footer.parentNode.append(probe);
      try {
        const full = footerRowGeometry(probe);
        cache.footerNaturalWidths = full.zones;
        cache.footerNaturalSource = source;
      } finally { probe.remove(); }
    }
    natural = cache.footerNaturalWidths;
  }
  return { key: JSON.stringify([width, zones, natural, clear]), width, clear };
}

/** Hide the middle in place; keep the band operable and both scroll offsets intact through incoming events. */
export class ConversationFold {
  constructor({ root, copy, onChange, canFold = () => true }) {
    this.root = root; this.onChange = onChange; this.canFold = canFold; this.folded = false;
    this.button = root.querySelector('.fold'); this.strip = root.querySelector('.fold-strip');
    this.button.addEventListener('click', () => this.set(!this.folded));
    this.strip.addEventListener('click', () => this.set(false));
    this.setCopy(copy);
  }
  setCopy(copy) { this.copy = copy; this.paint(); }
  paint() {
    const c = this.copy.layout;
    // Keep this edge control focusable: leaving the phone composer must still
    // dismiss its keyboard layout even when folding is unavailable.
    this.button.setAttribute('aria-disabled', String(!this.canFold()));
    this.button.setAttribute('aria-expanded', String(!this.folded));
    this.button.setAttribute('aria-label', this.folded ? c.unfold : c.fold);
    this.button.title = this.folded ? c.unfold : c.fold;
    this.strip.setAttribute('aria-label', c.unfold);
    setText(this.root.querySelector('.fold-question'), c.openQuestion);
  }
  update(session, openQuestion = session.openQuestion) {
    // Capability refreshes can remove drafts while the conversation is folded.
    if (this.folded && !this.canFold()) this.set(false);
    this.paint();
    const last = session.transcript.filter(t => !t.erased).at(-1);
    setText(this.root.querySelector('.fold-text'), last?.content ?? this.copy.layout.noMessage);
    setText(this.root.querySelector('.fold-who'), last?.role === 'user' ? this.copy.you : this.copy.assistant);
    this.root.querySelector('.fold-strip').dataset.speaker = last?.role ?? 'assistant';
    // The current final reply owns this state; background understanding never opens the strip label.
    this.root.querySelector('.fold-question').hidden = !openQuestion;
  }
  set(on) {
    if (this.root.host?.hasAttribute('data-aithema-erased')) return;
    if (on && !this.canFold()) return;
    if (on === this.folded) return;
    const panes = [...this.root.querySelectorAll('.transcript-shell, .analysis-content')];
    const view = this.root.ownerDocument.defaultView;
    if (on) { this.scroll = panes.map(pane => [pane, pane.scrollTop]); this.pageScroll = [view?.scrollX ?? 0, view?.scrollY ?? 0]; }
    this.folded = on; this.root.querySelector('.workspace').toggleAttribute('data-folded', on);
    for (const n of this.root.querySelectorAll('.conversation, .understanding')) n.hidden = on;
    this.root.querySelector('.fold-view').hidden = !on;
    this.paint(); this.onChange?.(on);
    if (!on) {
      for (const [pane, top] of this.scroll ?? []) pane.scrollTop = top;
      // Browsers settle the restored grid before painting the offsets.
      view?.requestAnimationFrame?.(() => {
        if (!this.folded) {
          for (const [pane, top] of this.scroll ?? []) pane.scrollTop = top;
          view.scrollTo?.(...this.pageScroll);
        }
      });
      if (this.root.activeElement === this.strip) this.button.focus({ preventScroll: true });
    }
  }
}

/** Viewport-clamped footer popups; the phone legal dialog opens only on activation. */
export class FooterPopups {
  constructor(root) {
    this.root = root; this.view = root.ownerDocument.defaultView;
    this.entries = [...root.querySelectorAll('[data-footer-popup]')];
    for (const entry of this.entries) {
      const legal = entry.classList.contains('host-legal');
      if (!legal) {
        entry.addEventListener('pointerenter', () => { entry.removeAttribute('data-dismissed'); this.position(entry); this.expanded(entry, true); });
        entry.addEventListener('focusin', () => { if (!this.returningFocus) entry.removeAttribute('data-dismissed'); this.position(entry); this.expanded(entry, !entry.hasAttribute('data-dismissed')); });
        entry.addEventListener('pointerleave', () => { if (!entry.matches(':focus-within')) entry.removeAttribute('data-dismissed'); this.expanded(entry, entry.hasAttribute('data-pinned') || entry.matches(':focus-within')); });
      }
      entry.addEventListener('focusout', event => {
        if (!entry.contains(event.relatedTarget)) {
          if (legal) { if (event.relatedTarget) this.close(entry); }
          else { entry.removeAttribute('data-dismissed'); this.expanded(entry, entry.hasAttribute('data-pinned')); }
        }
      });
      const button = this.button(entry);
      button?.addEventListener('click', () => {
        const pinned = !entry.hasAttribute('data-pinned');
        if (!legal) {
          entry.toggleAttribute('data-pinned', pinned); entry.removeAttribute('data-dismissed'); this.expanded(entry, pinned); this.position(entry); return;
        }
        if (!pinned) { this.close(entry); return; }
        if (legal) this.legalLinks(entry);
        entry.setAttribute('data-pinned', ''); entry.removeAttribute('data-dismissed');
        this.expanded(entry, true); this.position(entry);
        if (legal) entry.querySelector('.legal-popup a')?.focus({ preventScroll: true });
      });
    }
    this.key = event => {
      if (event.key === 'Tab') {
        clearTimeout(this.tabClose);
        this.tabClose = setTimeout(() => {
          for (const entry of this.entries) if (entry.classList.contains('host-legal') && !entry.contains(this.root.activeElement)) this.close(entry);
        }, 0);
      }
      if (event.key === 'Escape') for (const entry of this.entries) {
        const focused = entry.contains(this.root.activeElement);
        this.close(entry);
        const button = this.button(entry);
        if (button && focused) { this.returningFocus = true; button.focus({ preventScroll: true }); this.returningFocus = false; }
      }
    };
    this.outside = event => { for (const entry of this.entries) if (!event.composedPath().includes(entry)) {
      if (entry.classList.contains('host-legal')) this.close(entry);
      else { entry.removeAttribute('data-pinned'); this.expanded(entry, false); }
    } };
    this.resize = () => {
      for (const entry of this.entries) {
        if (entry.classList.contains('host-legal') && !this.view?.matchMedia('(width < 600px)').matches) this.close(entry);
        else this.position(entry);
      }
    };
    this.connect();
  }
  button(entry) { return entry.querySelector('.host-credits__button, .ai-notice, .legal-toggle'); }
  // Read the original anchors at activation, so host order, labels and URL bytes
  // stay current. The desktop slot is never rewritten or moved.
  legalLinks(entry) {
    const source = entry.querySelector('slot').assignedElements().flatMap(n => n.matches('a[href]') ? [n] : [...n.querySelectorAll('a[href]')]);
    const links = source.map(source => {
      const link = source.cloneNode(false);
      for (const name of ['id', 'slot', 'class', 'style', 'aria-labelledby', 'aria-describedby']) link.removeAttribute(name);
      link.textContent = source.getAttribute('aria-label') ?? source.textContent;
      return link;
    });
    entry.querySelector('.legal-popup').replaceChildren(...links);
  }
  close(entry) {
    entry.removeAttribute('data-pinned'); entry.setAttribute('data-dismissed', ''); this.expanded(entry, false);
  }
  expanded(entry, value) {
    if (value && this.view?.matchMedia('(width < 600px)').matches) for (const other of this.entries) if (other !== entry) this.close(other);
    this.button(entry)?.setAttribute('aria-expanded', String(value));
    if (entry.classList.contains('host-legal')) entry.querySelector('.legal-popup').hidden = !value;
  }
  connect() {
    if (this.entries.some(entry => !entry.hidden)) this.root.ownerDocument.addEventListener('click', this.outside);
    this.root.addEventListener('keydown', this.key); this.view?.addEventListener('resize', this.resize);
    this.view?.addEventListener('scroll', this.resize, { passive: true });
  }
  position(entry) {
    const popup = entry.querySelector('.footer-popup'); if (!popup) return;
    const anchor = entry.getBoundingClientRect(), box = popup.getBoundingClientRect(), width = this.view?.innerWidth ?? 320;
    const origin = entry.classList.contains('host-legal') ? width - box.width - 12
      : entry.classList.contains('footer-info') ? anchor.left : anchor.left + anchor.width / 2 - box.width / 2;
    const left = Math.min(Math.max(12, origin), Math.max(12, width - box.width - 12));
    popup.style.left = `${left}px`;
    popup.style.bottom = `${Math.max(12, (this.view?.innerHeight ?? 900) - anchor.top + (entry.classList.contains('footer-info') ? 8 : 6))}px`;
  }
  destroy() {
    clearTimeout(this.tabClose);
    this.root.ownerDocument.removeEventListener('click', this.outside);
    this.root.removeEventListener('keydown', this.key); this.view?.removeEventListener('resize', this.resize);
    this.view?.removeEventListener('scroll', this.resize);
  }
}

// One sizing owner for native content measurement and the scrollHeight fallback.
// Measure offscreen so the live field changes only inside the caller's pointer
// anchor transaction; native field-sizing must not resize it before that snapshot.
class ComposerSize {
  constructor(root, { following, resize, changed, painted, questionPending }) {
    Object.assign(this, { root, following, resize, changed, painted, questionPending });
    this.view = root.ownerDocument.defaultView;
    this.input = root.querySelector('.composer textarea');
    this.onInput = () => { this.fit(true); this.painted(); };
  }
  connect() { this.input?.addEventListener('input', this.onInput); }
  destroy() { this.input?.removeEventListener('input', this.onInput); }
  fit(visitor = false) {
    if (!this.input || this.fitting) return;
    const workspace = this.root.querySelector('.workspace');
    const combined = workspace.dataset.entrance === 'combined';
    if (workspace.dataset.stage !== 'live' && !combined || this.root.querySelector('.conversation').hidden) return;
    const visual = this.view.visualViewport;
    if (visual && visual.scale !== 1) return;
    const form = this.root.querySelector('.composer'), shell = this.root.querySelector('.transcript-shell');
    const field = this.input.getBoundingClientRect(), composer = form.getBoundingClientRect();
    if (!(field.width > 0 && field.height > 0 && composer.height > 0)) return;
    const css = this.view.getComputedStyle(this.input), shellCSS = this.view.getComputedStyle(shell);
    const phone = this.view.matchMedia('(max-width:600px)').matches;
    const viewport = visual?.height ?? this.view.innerHeight;
    const short = phone && workspace.hasAttribute('data-phone-short');
    const keyboard = workspace.hasAttribute('data-phone-keyboard');
    const minimum = parseFloat(css.minHeight) || (short ? 44 : 56);
    const actualChrome = composer.height - field.height;
    const card = this.root.querySelector('.qcard');
    // Readiness is scrollable in combined mode; it must yield to a draft just
    // like transcript content. Live mode still counts the card margin once.
    const entrancePane = combined && workspace.dataset.stage !== 'live' && this.root.querySelector('.conversation-scroll');
    const available = phone ? viewport + (visual?.offsetTop ?? 0)
      - this.root.querySelector('.band').getBoundingClientRect().height
      - this.root.querySelector('.display-foot').getBoundingClientRect().height
      - this.root.querySelector('.concept-bar').getBoundingClientRect().height - 32
      : entrancePane ? entrancePane.getBoundingClientRect().height + composer.height
        : shell.getBoundingClientRect().height + (parseFloat(shellCSS.marginBottom) || 0) + composer.height;
    const baselineContext = [field.width, viewport, short, keyboard, workspace.dataset.stage, minimum, css.font, css.lineHeight].join('/');
    const context = [baselineContext, actualChrome.toFixed(1), available.toFixed(1)].join('/');
    // A card closing or a notice arriving is not a visitor edit. In particular,
    // an answer-chip send cannot expand a retained draft into newly free space.
    if (!visitor && this.value === this.input.value && this.context === context) return;
    this.value = this.input.value; this.context = context;
    // First publication compares against the real pre-fit box. An unchanged
    // default size must not notify a resize and turn initial reading into follow.
    const following = this.following(), previousEffective = this.effective ?? composer.height;
    const line = parseFloat(css.lineHeight) || 24;
    const padding = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
    // The hidden used-up peer can stretch the live form. Measure intrinsic
    // chrome independently, so growing the field does not require a second fit.
    const probe = form.cloneNode(true), probeInput = probe.querySelector('textarea');
    const prepare = element => {
      element.removeAttribute('id'); element.inert = true; element.setAttribute('aria-hidden', 'true');
      for (const child of element.querySelectorAll('[id]')) child.removeAttribute('id');
      element.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${composer.width}px;min-height:0;max-height:none;height:auto;`;
    };
    prepare(probe); probeInput.removeAttribute('placeholder'); probeInput.value = this.input.value;
    const native = this.view.CSS?.supports?.('field-sizing', 'content');
    probeInput.style.cssText = `min-height:${minimum}px;max-height:none;height:${native ? 'auto' : `${minimum}px`};field-sizing:${native ? 'content' : 'fixed'};overflow:hidden;`;
    form.parentNode.append(probe);
    let natural, chrome;
    try {
      const measured = probeInput.getBoundingClientRect().height;
      natural = native ? measured : probeInput.scrollHeight;
      chrome = probe.getBoundingClientRect().height - measured;
      // Only responsive modes reset the empty baseline. Visitor-added chrome
      // remains growth, including attachment rows measured by this same owner.
      if (this.baselineContext !== baselineContext) {
        let peerFloor = 0;
        const peer = this.root.querySelector('.composer-out'), style = peer && this.view.getComputedStyle(peer);
        if (peer && style.display !== 'none' && !['absolute', 'fixed'].includes(style.position)) {
          const peerProbe = peer.cloneNode(true); prepare(peerProbe); peer.parentNode.append(peerProbe);
          try {
            const peerCSS = this.view.getComputedStyle(peerProbe);
            // The phone peer overlaps the card with a negative margin. Its
            // grid contribution, rather than its border box, sets the floor.
            peerFloor = peerProbe.getBoundingClientRect().height
              + (parseFloat(peerCSS.marginTop) || 0) + (parseFloat(peerCSS.marginBottom) || 0);
          }
          finally { peerProbe.remove(); }
        }
        this.baselineContext = baselineContext; this.baseline = Math.max(chrome + minimum, peerFloor);
      }
    } finally { probe.remove(); }
    // A visitor can type the next draft before the preceding answer arrives.
    // Reserve its future card on that edit, so an asynchronous question never
    // has to shrink the draft or surrender the answer/reply floors.
    const visibleCard = card && !card.hidden;
    let cardMinimum = !short && (visibleCard || this.questionPending()) ? 150 : 0;
    if (phone && cardMinimum && !visibleCard) {
      // The next question can use all three lines and a translated two-line
      // hint. Reserve that expanded phone minimum before its text is known;
      // later visitor edits with a visible card still use the normal cap.
      const cardCSS = this.view.getComputedStyle(card);
      cardMinimum = Math.max(cardMinimum,
        3 * parseFloat(this.view.getComputedStyle(card.querySelector('.qtext')).lineHeight)
        + 2 * parseFloat(this.view.getComputedStyle(card.querySelector('.qhint')).lineHeight) + 66
        + parseFloat(cardCSS.paddingTop) + parseFloat(cardCSS.paddingBottom) + 2 * parseFloat(cardCSS.rowGap) + 2);
    }
    const cardGap = phone && cardMinimum ? parseFloat(this.view.getComputedStyle(shell.querySelector('ol')).rowGap) || 0 : 0;
    let cap = Math.min(.4 * viewport, available - cardMinimum - cardGap - (short ? 0 : 128));
    cap = Math.max(minimum, cap - chrome);
    if (short) cap = Math.min(cap, 3 * line + padding);
    const height = Math.max(minimum, Math.min(natural, cap));
    this.fitting = true;
    try {
      this.resize(() => {
        workspace.style.setProperty('--composer-field-height', `${height}px`);
        const effective = form.getBoundingClientRect().height;
        this.effective = effective;
        workspace.style.setProperty('--aithema-composer-height', `${effective}px`);
        workspace.style.setProperty('--aithema-composer-growth', `${Math.max(0, effective - this.baseline)}px`);
        if (Math.abs(field.height - height) > .1 || Math.abs(previousEffective - effective) > .1) {
          this.painted(); this.changed({ following });
        }
      });
    } finally { this.fitting = false; }
  }
}

/** Keep the phone dock in the visual viewport, including keyboards that resize
 * only that viewport. Geometry comes from the existing band, footer and dock. */
export class PhoneComposerViewport {
  constructor(root, { onNoticesChange = () => {}, onCompactChange = () => {}, followsTranscript = () => true,
    resizeComposer = update => update(), onComposerResize = () => {}, questionPending = () => false } = {}) {
    this.onNoticesChange = onNoticesChange; this.followsTranscript = followsTranscript;
    this.resizeContent = resizeComposer;
    this.composerSize = new ComposerSize(root, { following: followsTranscript, resize: resizeComposer, changed: onComposerResize, painted: () => this.paint(), questionPending });
    this.root = root; this.view = root.ownerDocument.defaultView;
    this.paint = () => {
      const view = this.view, viewport = view?.visualViewport;
      const height = viewport?.height ?? view?.innerHeight ?? 0;
      // Pinch zoom is a reading gesture; do not move controls while zooming.
      if (viewport && viewport.scale !== 1) return;
      const workspace = root.querySelector('.workspace');
      const footer = root.querySelector('.display-foot');
      const geometry = footerGeometry(footer, this);
      const footerFocused = root.ownerDocument.activeElement === root.host && footer.contains(root.activeElement);
      // A clear compact row can only expand at the same width, even if full
      // still does not fit. Keep every such expansion out from under the user.
      // Resize, overflow and overlap always refit, even with held focus/hover.
      const deferExpansion = (footer.matches(':hover') || footerFocused) &&
        this.footerFitWidth === geometry.width && geometry.clear && footer.dataset.fit !== 'full';
      if (this.footerFitKey !== geometry.key && !deferExpansion) {
        fitFooter(footer); this.footerFitKey = footerGeometry(footer, this).key;
        this.footerFitWidth = geometry.width;
      }
      this.footerTextKey = footerText(footer.querySelector('.display-foot__row'));
      // Recovery notices share transcript end reservation at every width.
      // A voice binding alone never consumes a concept-bar row.
      const phone = view?.matchMedia('(max-width:600px)').matches;
      // Size the input before measuring the dock/footer, independent of cards.
      // Updating both in this paint avoids a second resize losing bottom-follow.
      const short = Boolean(phone && height <= 620), compactChanged = workspace.hasAttribute('data-phone-short') !== short;
      workspace.toggleAttribute('data-phone-short', short);
      workspace.toggleAttribute('data-phone-overlay', Boolean(phone && (view?.innerHeight ?? height) - height - (viewport?.offsetTop ?? 0) >= 150));
      const notices = root.querySelector('.voice-notices');
      const parent = root.querySelector('.transcript-shell');
      const movedNotices = Boolean(notices && notices.parentNode !== parent);
      if (movedNotices) parent.append(notices);
      if (notices) root.querySelector('.transcript-shell ol').style.paddingBottom = '';
      // Track the unobstructed phone viewport across resize-only keyboards too.
      // Set the attribute before measuring: footer and transcript change together.
      const touch = view?.matchMedia('(pointer:coarse)').matches || view?.navigator.maxTouchPoints > 0;
      const active = root.ownerDocument.activeElement === root.host ? root.activeElement : null;
      const editing = active?.matches('textarea,input,[contenteditable="true"]') || active?.closest('.composer');
      const width = view?.innerWidth, orientation = view?.screen.orientation?.angle;
      if (width !== this.viewportWidth || orientation !== this.viewportOrientation || !editing) {
        this.fullHeight = Math.max(view?.innerHeight ?? height, height);
        this.viewportWidth = width; this.viewportOrientation = orientation;
      } else this.fullHeight = Math.max(this.fullHeight ?? 0, view?.innerHeight ?? height, height);
      workspace.toggleAttribute('data-phone-keyboard', Boolean(phone && touch && editing && this.fullHeight - height >= 150));
      this.composerSize.fit();
      const outBody = root.querySelector('.composer-out__body');
      // Only clipped copy needs its own keyboard scroll target. Fitting copy
      // keeps the original DOM, including the AIT-411 default panel contract.
      if (outBody) {
        if (outBody.scrollHeight > outBody.clientHeight) outBody.tabIndex = 0;
        else outBody.removeAttribute('tabindex');
      }
      const values = {
        '--phone-height': height + (viewport?.offsetTop ?? 0),
        '--phone-bottom': Math.max(0, (view?.innerHeight ?? height) - height - (viewport?.offsetTop ?? 0)),
        '--phone-band': root.querySelector('.band').getBoundingClientRect().height,
        '--phone-footer': root.querySelector('.display-foot').getBoundingClientRect().height,
        '--phone-dock': root.querySelector('.composer-dock').getBoundingClientRect().height,
      };
      for (const [key, value] of Object.entries(values)) {
        // Folding hides the dock; keep its reservation so unfolding cannot
        // briefly enlarge the transcript and clamp its saved scroll position.
        if (key === '--phone-dock' && value === 0) continue;
        workspace.style.setProperty(key, `${value}px`);
      }
      this.clearHeaderMessage(phone);
      // A breakpoint changes the notice reservation without changing its
      // children. The next transcript event must not reuse the desktop height
      // and scroll past a pointer anchor established in the phone viewport.
      if (compactChanged) onCompactChange();
      if (movedNotices && this.endHeight) {
        this.noticeHeight = this.endHeight();
        this.noticeScrollTop = root.querySelector('.transcript-shell').scrollTop;
      }
    };
    // focusout fires before activeElement changes; settle it in this frame.
    this.focusOut = () => queueMicrotask(() => { if (this.connected) this.paint(); });
    this.connect();
  }
  connect() {
    this.connected = true;
    this.composerSize.connect();
    this.root.addEventListener('focusin', this.paint);
    this.root.querySelector('.display-foot').addEventListener('pointerleave', this.paint);
    this.root.addEventListener('focusout', this.focusOut);
    this.view?.addEventListener('resize', this.paint);
    this.view?.visualViewport?.addEventListener('resize', this.paint);
    this.view?.visualViewport?.addEventListener('scroll', this.paint);
    const Observer = this.view?.ResizeObserver;
    this.observer?.disconnect();
    if (Observer) {
      this.observer = new Observer(this.paint);
      for (const selector of ['.band', '.display-foot', '.composer-dock', '.audio-rail .voice-state']) {
        const node = this.root.querySelector(selector);
        if (node) this.observer.observe(node);
      }
    }
    this.footerObserver?.disconnect();
    const FooterMutation = this.view?.MutationObserver;
    if (FooterMutation) {
      this.footerObserver = new FooterMutation(records => {
        const row = this.root.querySelector('.display-foot__row');
        if (this.connected && (records.some(record => record.type === 'attributes') || footerText(row) !== this.footerTextKey)) this.paint();
      });
      this.footerObserver.observe(this.root.querySelector('.display-foot__row'), {
        subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['hidden'],
      });
    }
    this.noticesObserver?.disconnect();
    const Mutation = this.view?.MutationObserver;
    if (Mutation) {
      const notices = this.root.querySelector('.voice-notices'), shell = this.root.querySelector('.transcript-shell');
      const list = shell.querySelector('ol');
      const phoneNotices = () => notices?.parentNode === shell;
      const reservation = () => phoneNotices() ? notices.style.minHeight : list.style.paddingBottom;
      const reserve = value => { if (phoneNotices()) notices.style.minHeight = value; else list.style.paddingBottom = value; };
      const inlineHeight = () => {
        const actions = this.root.querySelector('.turn:last-child > .reply-actions, .turn > .voice-reply-actions');
        return actions?.getBoundingClientRect().height ?? 0;
      };
      const endHeight = this.endHeight = () => inlineHeight() + (phoneNotices()
        ? notices.getBoundingClientRect().height : parseFloat(list.style.paddingBottom) || 0);
      this.noticeHeight = endHeight();
      this.noticeScrollTop = shell.scrollTop;
      const release = () => {
        this.uploadReservation = false;
        if (!reservation()) return;
        reserve('');
        // Compare future mutations against the released height.
        this.noticeHeight = endHeight();
        this.onNoticesChange();
      };
      // Remember the actual row before a mutation can clamp scrollTop and
      // change hit testing beneath a stationary pointer.
      this.noticePointerOver = event => { this.noticeUpload = event.target.closest?.('.upload') ?? null; };
      this.noticePointerOut = event => {
        if (!this.noticeUpload || this.noticeUpload.contains(event.relatedTarget)) return;
        this.noticeUpload = null;
        if (this.uploadReservation) release();
      };
      this.noticeWheel = release;
      this.noticeScroll ??= () => {
        const moved = shell.scrollTop !== this.noticeScrollTop;
        this.noticeScrollTop = shell.scrollTop;
        // Restoring a clamped offset also queues scroll events. Only a new
        // offset or wheel gesture releases a resting upload's reservation.
        if (reservation() && (this.uploadReservation ? moved : this.followsTranscript())) release();
      };
      this.root.addEventListener('pointerover', this.noticePointerOver);
      this.root.addEventListener('pointerout', this.noticePointerOut);
      shell.addEventListener('wheel', this.noticeWheel, { passive:true });
      shell.addEventListener('scroll', this.noticeScroll, { passive:true });
      this.noticesObserver = new Mutation(records => {
        // Reflected hidden assignments also report idempotent renders. They
        // are not new notices and must not move a row under the pointer.
        const actions = this.root.querySelector('.voice-reply-actions');
        const changed = records.some(record => {
          // Transcript uploads and text paints do not own the action row.
          // Observe the list only to see that existing row move in or out.
          const relevant = notices?.contains(record.target) || actions?.contains(record.target) ||
            record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node === actions || node.matches?.('.reply-actions'));
          return relevant && (record.type !== 'attributes' ||
            record.oldValue !== record.target.getAttribute(record.attributeName));
        });
        // Inline reply controls and recovery notices are end content
        // at every width. Run after render, without a pointer.
        // Same-size label/text renders must not undo a transcript pointer anchor.
        const height = endHeight();
        if (changed && height !== this.noticeHeight) {
          const holdUpload = this.noticeUpload && height < this.noticeHeight;
          if (height > this.noticeHeight || this.followsTranscript() && !holdUpload) {
            // Growth already supplies the old room naturally. Keep readers at
            // their offset without leaving an obsolete minimum behind.
            reserve('');
            if (!this.followsTranscript()) shell.scrollTop = this.noticeScrollTop;
          }
          else {
            // Shrinking end content must not clamp a resting upload out from
            // under the pointer, even when already following the bottom.
            this.uploadReservation = Boolean(holdUpload);
            reserve(`${Math.max(0, this.noticeHeight - inlineHeight())}px`);
            shell.scrollTop = this.noticeScrollTop;
          }
          this.onNoticesChange();
        }
        this.noticeHeight = endHeight();
        this.noticeScrollTop = shell.scrollTop;
      });
      const options = { subtree:true, childList:true, characterData:true, attributes:true, attributeOldValue:true, attributeFilter:['hidden'] };
      if (notices) this.noticesObserver.observe(notices, options);
      this.noticesObserver.observe(shell.querySelector('ol'), options);
    }
    this.paint();
  }
  clearHeaderMessage(phone) {
    const shell = this.root.querySelector('.transcript-shell');
    const message = this.root.querySelector('.audio-rail[data-message] .voice-state');
    const card = this.root.querySelector('.qcard');
    let inset = 0;
    // Only short, top-aligned conversations can use the free room. A visible
    // header message owns this temporary content inset, never the pane frame.
    if (!phone && message && shell.querySelector('li.turn') && (!card || card.hidden)) {
      const box = message.getBoundingClientRect(), pane = shell.getBoundingClientRect();
      const css = this.view.getComputedStyle(shell);
      const current = parseFloat(shell.style.getPropertyValue('--transcript-message-inset')) || 0;
      const slackTop = parseFloat(css.getPropertyValue('--aithema-slack-top')) || 0;
      const slackBottom = parseFloat(css.getPropertyValue('--aithema-slack-bottom')) || 0;
      const top = (parseFloat(css.paddingTop) || 0) - current - slackTop;
      const bottom = (parseFloat(css.paddingBottom) || 0) - slackBottom;
      // Round outward: independent fractional font/layout rounding must not
      // paint the first bubble across the visible message boundary.
      const needed = Math.ceil(Math.max(0, box.bottom - pane.top - top));
      const list = shell.querySelector('ol').getBoundingClientRect();
      const notices = shell.querySelector('.voice-notices')?.getBoundingClientRect();
      const latest = shell.querySelector('.transcript-latest');
      const latestCSS = latest && this.view.getComputedStyle(latest);
      const endRoom = latest && latestCSS.display !== 'none' && !['absolute', 'fixed'].includes(latestCSS.position)
        ? Math.max(0, latest.getBoundingClientRect().height + (parseFloat(latestCSS.marginTop) || 0)
          + (parseFloat(latestCSS.marginBottom) || 0)) : 0;
      if (box.width > 0 && box.height > 0 && pane.width > 0 && pane.height > 0 &&
          this.view.getComputedStyle(message).visibility === 'visible' &&
          list.height + (notices?.height ?? 0) + endRoom + top + bottom + needed <= shell.clientHeight) inset = needed;
    }
    const value = inset ? `${inset}px` : '';
    if (shell.style.getPropertyValue('--transcript-message-inset') === value) return;
    this.resizeContent(() => {
      if (value) shell.style.setProperty('--transcript-message-inset', value);
      else shell.style.removeProperty('--transcript-message-inset');
    });
    this.onNoticesChange();
  }
  sizeComposer() { this.composerSize.fit(true); this.paint(); }
  recordTranscriptAnchor() {
    this.noticeScrollTop = this.root.querySelector('.transcript-shell').scrollTop;
  }
  destroy() {
    this.connected = false;
    this.composerSize.destroy();
    this.root.removeEventListener('focusin', this.paint);
    this.root.querySelector('.display-foot').removeEventListener('pointerleave', this.paint);
    this.root.removeEventListener('focusout', this.focusOut);
    this.root.querySelector('.transcript-shell').removeEventListener('scroll', this.noticeScroll);
    this.root.querySelector('.transcript-shell').removeEventListener('wheel', this.noticeWheel);
    this.root.removeEventListener('pointerover', this.noticePointerOver);
    this.root.removeEventListener('pointerout', this.noticePointerOut);
    this.noticesObserver?.disconnect();
    this.observer?.disconnect();
    this.footerObserver?.disconnect();
    this.view?.removeEventListener('resize', this.paint);
    this.view?.visualViewport?.removeEventListener('resize', this.paint);
    this.view?.visualViewport?.removeEventListener('scroll', this.paint);
  }
}
