import { node, setText } from './dom.js';
import { plural, resolveCopy } from './copy-resolve.js';

/** Fits complete notices into the existing cell; the same nodes own sheet actions. */
export class UploadNotices {
  #form; #reason; #slot; #dialog; #body; #title; #close; #more;
  #rows = []; #placements = []; #sources = []; #visible = 0; #copy; #locale; #observer; #focused;
  constructor(form) {
    this.#form = form; this.#slot = form.querySelector('.composer-feedback');
    this.#reason = this.#slot.querySelector(':scope > .composer-reason');
    this.#dialog = node('dialog', 'upload-notices-sheet'); this.#dialog.id = 'upload-notices-sheet';
    this.#dialog.setAttribute('aria-labelledby', 'upload-notices-title'); this.#dialog.setAttribute('aria-modal', 'true');
    const header = node('div', 'upload-notices-header');
    this.#title = node('h2'); this.#title.id = 'upload-notices-title';
    this.#close = node('button', 'upload-notices-close'); this.#close.type = 'button';
    this.#close.addEventListener('click', () => this.#dialog.close());
    header.append(this.#title, this.#close); this.#body = node('div', 'upload-notices-body');
    this.#dialog.append(header, this.#body); form.getRootNode().append(this.#dialog);
    this.#more = node('button', 'upload-notices-more'); this.#more.type = 'button';
    this.#more.setAttribute('aria-haspopup', 'dialog'); this.#more.setAttribute('aria-controls', this.#dialog.id);
    this.#more.addEventListener('click', () => {
      this.#showRows(); this.#dialog.showModal(); this.#close.focus({ preventScroll: true });
    });
    this.#dialog.addEventListener('close', () => {
      this.#putRowsBack(); this.fit();
      const target = this.#more.isConnected ? this.#more : form.querySelector('textarea');
      target.focus({ preventScroll: true });
    });
    this.#dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const actions = [...this.#dialog.querySelectorAll('button:not(:disabled)')].filter(button => !button.closest('[hidden]'));
      const first = actions[0], last = actions.at(-1), active = form.getRootNode().activeElement;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    });
    const Observer = form.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) { this.#observer = new Observer(() => this.fit()); this.#observer.observe(this.#slot); }
  }
  #text(key) { return resolveCopy(this.#copy, `uploads.${key}`, undefined, this.#locale); }
  /** Restore the painter's original tree before it updates any state or action. */
  prepare() {
    const active = this.#form.getRootNode().activeElement;
    this.#focused = active && this.#reason.contains(active) ? active : null;
    for (const { element, marker } of this.#placements) marker.replaceWith(element);
    this.#placements = [];
    for (const [element, hidden] of this.#sources) element.hidden = hidden;
    this.#sources = [];
    for (const row of this.#rows) row.remove(); this.#rows = [];
    this.#more.remove(); this.#reason.removeAttribute('data-notice-layout');
  }
  #row(elements) {
    const row = node('span', `upload-notice-row${elements[0]?.classList?.contains('image-refusal-item') ? ' image-refusals' : ''}`);
    for (const element of elements) {
      const marker = this.#form.ownerDocument.createComment('notice'); element.before(marker);
      this.#placements.push({ element, marker }); row.append(element);
    }
    this.#reason.append(row); return row;
  }
  update(copy, locale) {
    this.#copy = copy; this.#locale = locale;
    // Plain feedback and hidden measuring lines never enter the tab order.
    this.#reason.removeAttribute('tabindex');
    this.#reason.removeAttribute('data-feedback-scroll'); this.#reason.removeAttribute('data-feedback-more');
    if (!this.#reason.hasAttribute('data-upload-feedback')) { if (this.#dialog.open) this.#dialog.close(); return; }
    const box = this.#slot.getBoundingClientRect();
    // Layout-free consumers still use the original semantic tree.
    if (!(box.width > 1 && box.height > 1)) return;
    const held = this.#reason.hasAttribute('data-held-consent'), images = this.#reason.querySelectorAll('.image-refusal-item');
    if (!held && !images.length && this.#reason.scrollHeight <= this.#slot.clientHeight
      && this.#reason.getBoundingClientRect().height <= box.height) return;
    this.#reason.setAttribute('data-notice-layout', '');
    const sources = [...this.#reason.childNodes];
    const groups = [];
    if (held || images.length) {
      const notice = this.#reason.querySelector('.held-upload-notice');
      if (notice?.textContent.trim()) groups.push([notice]);
      for (const item of [...images].reverse()) groups.push([item]);
      const retry = this.#reason.querySelector('.upload-retry-copy');
      if (retry) groups.push([retry, this.#reason.querySelector('.upload-retry-actions')].filter(Boolean));
      const consent = this.#reason.querySelector('.held-upload-consent'); if (consent) groups.push([consent]);
    } else groups.push(sources);
    this.#rows = groups.map(elements => this.#row(elements));
    // Empty original containers remain reusable by the painter, without paint or focus.
    for (const element of sources.filter(element => element.nodeType === 1 && element.parentNode === this.#reason)) {
      this.#sources.push([element, element.hidden]); element.hidden = true;
    }
    setText(this.#title, this.#text('noticesTitle')); setText(this.#close, this.#text('closeNotices'));
    this.fit();
    if (this.#dialog.open) this.#showRows();
    if (this.#focused && (!this.#focused.isConnected || this.#focused.closest('[hidden]'))) {
      (this.#more.isConnected ? this.#more : this.#form.querySelector('textarea')).focus({ preventScroll: true });
    }
  }
  fit() {
    if (!this.#rows.length || this.#dialog.open) return;
    for (const row of this.#rows) { row.hidden = false; row.inert = false; }
    this.#more.remove();
    const available = this.#slot.clientHeight;
    const heights = this.#rows.map(row => row.getBoundingClientRect().height);
    const total = heights.reduce((sum, height) => sum + height, 0);
    this.#visible = this.#rows.length;
    if (total > available + .25) {
      let used = 0; this.#visible = 0;
      for (const height of heights) {
        if (used + height + 44 > available + .25) break;
        used += height; this.#visible++;
      }
      const count = this.#rows.length - this.#visible;
      this.#more.replaceChildren(); this.#more.toggleAttribute('data-summary', this.#visible === 0);
      if (!this.#visible) {
        this.#more.append(node('span', '', this.#text('summaryUnavailable')), ' · ', node('span', 'upload-notices-details', this.#text('detailsAction')));
      } else setText(this.#more, plural(this.#text('moreNotices'), count));
      this.#reason.append(this.#more);
    }
    this.#putRowsBack();
  }
  #showRows() {
    for (const row of this.#rows) { row.hidden = false; row.inert = false; this.#body.append(row); }
  }
  #putRowsBack() {
    for (const [index, row] of this.#rows.entries()) {
      row.hidden = index >= this.#visible; row.inert = row.hidden;
      this.#reason.insertBefore(row, this.#more.parentNode === this.#reason ? this.#more : null);
    }
  }
  destroy() { this.#observer?.disconnect(); this.prepare(); this.#dialog.remove(); }
}
