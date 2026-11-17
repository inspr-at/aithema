import { paintConsentLine } from './consent-line.js';
import { overviewStatusCandidates } from './overview-status-copy.js';

// Reserve the longest reachable status before a state changes. The probe uses
// the real status/action styles at the current pane width and inherited font.
export class OverviewStatusSize {
  constructor(root) {
    this.root = root; this.view = root.ownerDocument.defaultView;
    this.slot = root.querySelector('.overview-status');
    this.pane = root.querySelector('.analysis-content');
    this.refresh = () => this.measure();
    this.fontsChanged = () => { this.signature = null; this.measure(); };
  }
  connect() {
    if (this.connected) return;
    this.connected = true;
    const Resize = this.view?.ResizeObserver;
    if (Resize) {
      this.observer = new Resize(this.refresh);
      this.observer.observe(this.slot);
      this.observer.observe(this.slot.querySelector('.notice-text'));
      this.observer.observe(this.root.querySelector('.analysis-stack'));
    }
    this.view?.addEventListener('resize', this.refresh);
    const fonts = this.root.ownerDocument.fonts;
    fonts?.addEventListener?.('loadingdone', this.fontsChanged);
    fonts?.ready?.then(() => { if (this.connected) this.fontsChanged(); });
    this.measure();
  }
  render(copy, locale) {
    if (this.copy !== copy || this.locale !== locale) this.signature = null;
    this.copy = copy; this.locale = locale; this.measure();
  }
  measure() {
    if (!this.copy || !this.connected) return;
    const style = this.view.getComputedStyle(this.slot), box = this.slot.getBoundingClientRect();
    // Flex is selected only by the definite-height compact contact container.
    if (style.display !== 'flex' || !(box.width > 0 && box.height > 0)) return;
    const textStyle = this.view.getComputedStyle(this.slot.querySelector('.notice-text'));
    const signature = [box.width, style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.columnGap,
      textStyle.fontFamily, textStyle.fontSize, textStyle.fontWeight, textStyle.lineHeight, textStyle.letterSpacing].join('|');
    if (this.signature === signature) { this.growToRendered(); return; }
    this.signature = signature;
    const copy = this.copy, locale = this.locale;
    const variants = overviewStatusCandidates(copy, locale);
    const probe = this.slot.cloneNode(false), text = this.root.ownerDocument.createElement('span');
    text.className = 'notice-text'; probe.removeAttribute('role'); probe.removeAttribute('aria-label');
    probe.setAttribute('aria-hidden', 'true'); probe.inert = true;
    Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', width: `${box.width}px`,
      height: 'auto', minHeight: '0', margin: '0', overflow: 'visible', visibility: 'hidden' });
    probe.append(text); this.slot.after(probe);
    let height = 0;
    try {
      for (const variant of variants) {
        probe.replaceChildren(text);
        paintConsentLine(text, { copy, feature: 'analysis', separator: '', text: variant.text,
          verdict: { available: !variant.consent, reason: 'current processing consent required' }, open: () => {} });
        for (const node of probe.querySelectorAll('[id]')) node.removeAttribute('id');
        if (variant.retry) {
          const retry = this.root.ownerDocument.createElement('button'); retry.className = 'overview-retry';
          retry.type = 'button'; retry.textContent = copy.understandingRetry; probe.append(retry);
        }
        height = Math.max(height, probe.getBoundingClientRect().height);
      }
    } finally { probe.remove(); }
    if (height > 0) this.pane.style.setProperty('--overview-status-height', `${height}px`);
    this.growToRendered();
  }
  // Unknown provider copy must remain readable even if it was not catalogued.
  // This cheap visible-DOM guard never shrinks the reserve on a state change.
  growToRendered() {
    const children = [...this.slot.children].filter(node => !node.hidden);
    const height = Math.max(0, ...children.map(node => Math.max(node.scrollHeight, node.getBoundingClientRect().height)));
    const reserved = parseFloat(this.pane.style.getPropertyValue('--overview-status-height')) || 0;
    if (height > reserved + .5) this.pane.style.setProperty('--overview-status-height', `${height}px`);
  }
  disconnect() {
    this.connected = false; this.observer?.disconnect();
    this.view?.removeEventListener('resize', this.refresh);
    this.root.ownerDocument.fonts?.removeEventListener?.('loadingdone', this.fontsChanged);
  }
}
