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
    const limit = 9 * line;
    const measured = box.width > 0 && box.height > 0 && Number.isFinite(limit) && limit > 0;
    const overflow = measured && text.scrollHeight > limit + .5;
    text.toggleAttribute('data-collapsed', overflow && !this.expanded);
    this.button.hidden = !overflow;
    this.button.setAttribute('aria-expanded', String(this.expanded));
    setText(this.button, resolveCopy(this.copy, this.expanded ? 'showLess' : 'summaryMore', null, this.locale));
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
