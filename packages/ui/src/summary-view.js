import { resolveCopy } from './copy-resolve.js';
import { setText } from './dom.js';

// The preference belongs to the mounted conversation, not the assessment bytes.
// Overflow uses the rendered text's scroll extent, including while expanded.
export class SummaryView {
  constructor({ root, expanded = false, onChange, anchor }) {
    this.root = root; this.text = root.querySelector('.summary-text');
    this.button = root.querySelector('.summary-toggle'); this.expanded = expanded;
    this.onChange = onChange; this.anchor = anchor;
    this.view = root.ownerDocument.defaultView;
    this.refresh = () => this.anchor(() => this.measure());
    this.button.addEventListener('click', () => {
      this.expanded = !this.expanded; this.onChange(this.expanded); this.measure();
    });
  }
  connect() {
    if (this.connected || this.frozen) return;
    this.connected = true;
    const Resize = this.view?.ResizeObserver;
    if (Resize) {
      this.observer = new Resize(this.refresh);
      this.observer.observe(this.text);
      this.observer.observe(this.root.querySelector('.analysis-content'));
      this.observer.observe(this.root.querySelector('#summary-title'));
      this.observer.observe(this.root.querySelector('.signals'));
    }
    this.view?.addEventListener('resize', this.refresh);
    const fonts = this.root.ownerDocument.fonts;
    fonts?.addEventListener?.('loadingdone', this.refresh);
    fonts?.ready?.then(() => { if (this.connected) this.refresh(); });
    this.refresh();
  }
  render(copy, locale) {
    this.copy = copy; this.locale = locale; this.measure();
  }
  measure() {
    if (this.frozen || !this.copy) return;
    const text = this.text, box = text.getBoundingClientRect();
    const style = this.view.getComputedStyle(text), line = parseFloat(style.lineHeight);
    if (!(box.width > 0 && box.height > 0 && Number.isFinite(line) && line > 0)) {
      this.button.hidden = true;
      return;
    }
    setText(this.button, resolveCopy(this.copy, this.expanded ? 'showLess' : 'summaryMore', null, this.locale));
    // Subtract the paragraph's current height from the first signal's position:
    // the remaining footprint includes the heading, gaps and localized toggle.
    // This also measures expanded text without temporarily collapsing it.
    // Scroll position and anchoring slack are not pane budget.
    const pane = this.root.querySelector('.analysis-content');
    const heading = this.root.querySelector('#summary-title');
    const signal = this.root.querySelector('.signals li');
    this.button.hidden = false;
    const paneBox = pane.getBoundingClientRect(), headingBox = heading.getBoundingClientRect();
    const signalBox = signal?.getBoundingClientRect();
    let lines = 9;
    if (paneBox.width > 0 && paneBox.height > 0 && headingBox.width > 0 && headingBox.height > 0 &&
        signalBox?.width > 0 && signalBox.height > 0) {
      const slack = parseFloat(this.view.getComputedStyle(pane).getPropertyValue('--aithema-slack-top')) || 0;
      const end = signalBox.bottom - paneBox.top + pane.scrollTop - slack;
      const room = paneBox.height - (end - text.getBoundingClientRect().height);
      lines = Math.max(3, Math.min(9, Math.floor(room / line)));
    }
    text.style.setProperty('--summary-lines', String(lines));
    const overflow = text.scrollHeight > lines * line + .5;
    text.toggleAttribute('data-collapsed', overflow && !this.expanded);
    this.button.hidden = !overflow;
    this.button.setAttribute('aria-expanded', String(this.expanded));
  }
  freeze() {
    this.frozen = true; this.expanded = false;
    this.button.hidden = true; this.button.setAttribute('aria-expanded', 'false');
    this.disconnect();
  }
  disconnect() {
    this.connected = false; this.observer?.disconnect();
    this.view?.removeEventListener('resize', this.refresh);
    this.root.ownerDocument.fonts?.removeEventListener?.('loadingdone', this.refresh);
  }
}
