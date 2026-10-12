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
export const FOOTER_WIDTHS = Object.freeze({ voice: 1000, identity: 680, compact: 600, number: 360 });
export function footerMode(width) {
  return { voice: width >= FOOTER_WIDTHS.voice, identity: width >= FOOTER_WIDTHS.identity,
    limit: width >= FOOTER_WIDTHS.compact, connected: width >= FOOTER_WIDTHS.compact, unit: width >= FOOTER_WIDTHS.number };
}

/** Hide the middle in place; keep the band operable and both scroll offsets intact through incoming events. */
export class ConversationFold {
  constructor({ root, copy, onChange }) {
    this.root = root; this.onChange = onChange; this.folded = false;
    this.button = root.querySelector('.fold'); this.strip = root.querySelector('.fold-strip');
    this.button.addEventListener('click', () => this.set(!this.folded));
    this.strip.addEventListener('click', () => this.set(false));
    this.setCopy(copy);
  }
  setCopy(copy) { this.copy = copy; this.paint(); }
  paint() {
    const c = this.copy.layout;
    this.button.setAttribute('aria-expanded', String(!this.folded));
    this.button.setAttribute('aria-label', this.folded ? c.unfold : c.fold);
    this.button.title = this.folded ? c.unfold : c.fold;
    this.strip.setAttribute('aria-label', c.unfold);
    setText(this.root.querySelector('.fold-question'), c.openQuestion);
    setText(this.root.querySelector('.canvas-empty span'), c.canvasEmpty);
  }
  update(session, openQuestion = session.openQuestion) {
    const last = session.transcript.filter(t => !t.erased).at(-1);
    setText(this.root.querySelector('.fold-text'), last?.content ?? this.copy.layout.noMessage);
    setText(this.root.querySelector('.fold-who'), last?.role === 'user' ? this.copy.you : this.copy.assistant);
    this.root.querySelector('.fold-strip').dataset.speaker = last?.role ?? 'assistant';
    // The current final reply owns this state; background understanding never opens the strip label.
    this.root.querySelector('.fold-question').hidden = !openQuestion;
  }
  set(on) {
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

/** Viewport-clamped tooltips, shared by notice/build, wallet and preset; hover changes only opacity. */
export class FooterPopups {
  constructor(root) {
    this.root = root; this.view = root.ownerDocument.defaultView;
    this.entries = [...root.querySelectorAll('[data-footer-popup]')];
    for (const entry of this.entries) {
      entry.addEventListener('pointerenter', () => { entry.removeAttribute('data-dismissed'); this.position(entry); });
      entry.addEventListener('focusin', () => { entry.removeAttribute('data-dismissed'); this.position(entry); });
      entry.addEventListener('pointerleave', () => entry.removeAttribute('data-dismissed'));
    }
    this.key = event => {
      if (event.key === 'Escape') for (const entry of this.entries) entry.setAttribute('data-dismissed', '');
    };
    this.resize = () => { for (const entry of this.entries) this.position(entry); };
    this.connect();
  }
  connect() {
    this.root.addEventListener('keydown', this.key); this.view?.addEventListener('resize', this.resize);
    this.view?.addEventListener('scroll', this.resize, { passive: true });
  }
  position(entry) {
    const popup = entry.querySelector('.footer-popup'); if (!popup) return;
    const anchor = entry.getBoundingClientRect(), box = popup.getBoundingClientRect(), width = this.view?.innerWidth ?? 320;
    const left = Math.min(Math.max(12, anchor.left + anchor.width / 2 - box.width / 2), Math.max(12, width - box.width - 12));
    popup.style.left = `${left}px`;
    popup.style.bottom = `${Math.max(12, (this.view?.innerHeight ?? 900) - anchor.top + 6)}px`;
  }
  destroy() {
    this.root.removeEventListener('keydown', this.key); this.view?.removeEventListener('resize', this.resize);
    this.view?.removeEventListener('scroll', this.resize);
  }
}
