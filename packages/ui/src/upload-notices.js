import { node, setText } from './dom.js';
import { reasonSeparator } from './reason-separator.js';
import { plural, resolveCopy } from './copy-resolve.js';

/** Fits complete notices into the existing cell; the same nodes own sheet actions. */
export class UploadNotices {
  #form; #reason; #slot; #dialog; #body; #title; #close; #more;
  #containers = []; #rows = []; #placements = []; #sources = []; #visible = 0; #copy; #locale; #observer; #focused; #actionLayouts = []; #separators = []; #clippedActions = [];
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
      this.#dialog.showModal(); this.#showRows(); this.#close.focus({ preventScroll: true });
    });
    this.#dialog.addEventListener('close', () => {
      this.#putRowsBack(); this.fit();
      this.#focusFallback()?.focus({ preventScroll: true });
    });
    this.#dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const actions = [...this.#dialog.querySelectorAll('button:not(:disabled)')].filter(button => !button.closest('[hidden]'));
      const first = actions[0], last = actions.at(-1), active = form.getRootNode().activeElement;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    });
    const Observer = form.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) {
      this.#observer = new Observer(() => {
        if (!this.#copy) return;
        // A resumed or newly revealed composer may have had no layout at paint time.
        if (!this.#rows.length) this.update(this.#copy, this.#locale);
        else this.fit();
      });
      this.#observer.observe(this.#slot);
    }
  }
  #text(key) { return resolveCopy(this.#copy, `uploads.${key}`, undefined, this.#locale); }
  /** Restore the painter's original tree before it updates any state or action. */
  prepare() {
    const active = this.#form.getRootNode().activeElement;
    this.#focused = active && (this.#reason.contains(active) || this.#dialog.contains(active)) ? active : null;
    this.#restoreClippedActions();
    for (const [text, original] of this.#separators) text.textContent = original; this.#separators = [];
    for (const source of this.#actionLayouts) { source.removeAttribute('data-notice-action'); source.removeAttribute('data-action-wrap'); source.querySelector(':scope > .upload-notice-join')?.remove(); }
    this.#actionLayouts = [];
    for (const { element, marker } of this.#placements) marker.replaceWith(element);
    this.#placements = [];
    for (const element of this.#containers) element.classList.add('image-refusals'); this.#containers = [];
    for (const [element, hidden] of this.#sources) element.hidden = hidden;
    this.#sources = [];
    for (const row of this.#rows) row.remove(); this.#rows = [];
    this.#more.remove(); this.#reason.removeAttribute('data-notice-layout');
  }
  #row(elements) {
    const image = elements[0]?.classList?.contains('image-refusal-item');
    const row = node('span', `upload-notice-row${image ? ' image-refusals' : ''}`);
    const target = image ? node('span', 'image-refusals__list') : row;
    if (image) row.append(target);
    for (const element of elements) {
      const marker = this.#form.ownerDocument.createComment('notice'); element.before(marker);
      this.#placements.push({ element, marker }); target.append(element);
    }
    this.#reason.append(row); return row;
  }
  #restoreClippedActions() {
    for (const [action, tabIndex] of this.#clippedActions) {
      if (tabIndex === null) action.removeAttribute('tabindex'); else action.setAttribute('tabindex', tabIndex);
    }
    this.#clippedActions = [];
  }
  update(copy, locale) {
    this.#restoreClippedActions();
    this.#copy = copy; this.#locale = locale;
    // Plain feedback and hidden measuring lines never enter the tab order.
    this.#reason.removeAttribute('tabindex');
    // Focus restoration follows live actions after a status becomes a shortcut.
    this.#reason.removeAttribute('data-focus-key');
    this.#reason.removeAttribute('data-feedback-scroll'); this.#reason.removeAttribute('data-feedback-more');
    this.#reason.inert = false;
    const reasonBox = this.#reason.getBoundingClientRect();
    const clipped = reasonBox.width === 1 && reasonBox.height === 1;
    if (clipped && !this.#dialog.open) for (const action of this.#reason.querySelectorAll('button')) {
      this.#clippedActions.push([action, action.getAttribute('tabindex')]); action.tabIndex = -1;
    }
    if (!this.#reason.hasAttribute('data-upload-feedback')) {
      if (this.#dialog.open) this.#dialog.close();
      this.#retainFocus(); return;
    }
    const box = this.#slot.getBoundingClientRect();
    // Layout-free consumers still use the original semantic tree.
    if (!(box.width > 1 && box.height > 1) || clipped) {
      // Visually hidden statuses still announce every message. An open sheet
      // retains its content even when the underlying compact cell disappears.
      if (!this.#dialog.open) { this.#retainFocus(); return; }
    }
    const held = this.#reason.hasAttribute('data-held-consent'), images = this.#reason.querySelectorAll('.image-refusal-item');
    if (!held && !images.length && !this.#dialog.open && this.#fits(box)) { this.#retainFocus(); return; }
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
    this.#containers = [...this.#reason.querySelectorAll('.image-refusals')];
    for (const element of this.#containers) element.classList.remove('image-refusals');
    this.#rows = groups.map(elements => this.#row(elements));
    for (const row of this.#rows) this.#prepareActions(row);
    // Empty original containers remain reusable by the painter, without paint or focus.
    for (const element of sources.filter(element => element.nodeType === 1 && element.parentNode === this.#reason)) {
      this.#sources.push([element, element.hidden]); element.hidden = true;
    }
    setText(this.#title, this.#text('noticesTitle')); setText(this.#close, this.#text('closeNotices'));
    this.fit();
    if (this.#dialog.open) this.#showRows();
    this.#retainFocus();
  }
  #fits(bounds) {
    const outside = (r, b) => r.top < b.top - .5 || r.bottom > b.bottom + .5 || r.left < b.left - .5 || r.right > b.right + .5;
    const document = this.#form.ownerDocument, walker = document.createTreeWalker(this.#reason, 4);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!text.textContent.trim() || text.parentElement.closest('[hidden]')) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        if (outside(rect, bounds)) return false;
        for (let parent = text.parentElement; parent && parent !== this.#slot; parent = parent.parentElement)
          if (/auto|scroll|hidden|clip/u.test(document.defaultView.getComputedStyle(parent).overflowY) && outside(rect, parent.getBoundingClientRect())) return false;
      }
    }
    return this.#reason.scrollHeight <= this.#slot.clientHeight;
  }
  #focusFallback() {
    const candidates = [this.#more, this.#form.querySelector('textarea:not(:disabled)'), this.#form.querySelector('.attach'),
      this.#reason.querySelector(':scope > .consent-action'), this.#form.getRootNode().querySelector('.settings-open')];
    return candidates.find(element => {
      if (!element?.isConnected || element.disabled || element.closest('[hidden], [inert], dialog:not([open])')) return false;
      const box = element.getBoundingClientRect(); return box.width > 1 && box.height > 1;
    });
  }
  #retainFocus() {
    const focused = this.#focused; this.#focused = null;
    if (!focused || this.#form.getRootNode().activeElement === focused) return;
    const retained = focused.isConnected && !focused.closest('[hidden], [inert], dialog:not([open])')
      && focused.matches('button, a[href], input, textarea, select, [tabindex]') && (!this.#dialog.open || this.#dialog.contains(focused));
    (retained ? focused : this.#dialog.open ? this.#close : this.#focusFallback())?.focus({ preventScroll: true });
  }

  #prepareActions(row) {
    for (const action of row.querySelectorAll('.consent-action')) {
      const source = action.parentElement;
      if (!source.matches('.held-upload-consent, .image-refusal-item, .upload-retry-copy')) continue;
      source.setAttribute('data-notice-action', ''); this.#actionLayouts.push(source);
      // The separator belongs to the join, never to the end of a wrapped sentence.
      const walker = this.#form.ownerDocument.createTreeWalker(source, 4);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!action.contains(text) && text.textContent.endsWith(reasonSeparator)) {
          this.#separators.push([text, text.textContent]);
          text.textContent = text.textContent.slice(0, -reasonSeparator.length);
        }
      }
      const join = node('span', 'upload-notice-join', reasonSeparator); join.setAttribute('aria-hidden', 'true');
      action.before(join);
    }
  }
  #layoutActions(row) {
    for (const source of row.querySelectorAll('[data-notice-action]')) {
      source.removeAttribute('data-action-wrap');
      const join = source.querySelector(':scope > .upload-notice-join'); setText(join, reasonSeparator);
      const wrapped = source.scrollWidth > row.clientWidth + .5;
      source.toggleAttribute('data-action-wrap', wrapped);
      if (wrapped) setText(join, '');
    }
  }
  #setMore(count, summary = false) {
    this.#more.replaceChildren(); this.#more.toggleAttribute('data-summary', summary);
    if (summary) {
      const consentOnly = this.#reason.hasAttribute('data-held-only');
      this.#more.append(node('span', '', this.#text(consentOnly ? 'summaryConsent' : 'summaryUnavailable')),
        reasonSeparator, node('span', 'upload-notices-details', this.#text('detailsAction')));
    } else {
      const join = node('span', 'upload-notices-more-join', reasonSeparator); join.setAttribute('aria-hidden', 'true');
      this.#more.append(join, node('span', '', plural(this.#text('moreNotices'), count)));
    }
  }
  fit() {
    if (!this.#rows.length || this.#dialog.open) return;
    const focused = this.#form.getRootNode().activeElement;
    const hadFocus = focused === this.#more || this.#rows.some(row => row.contains(focused));
    this.#more.remove();
    for (const row of this.#rows) {
      row.removeAttribute('data-more-inline'); row.hidden = false; row.inert = false; this.#reason.append(row);
      this.#layoutActions(row);
    }
    const bounds = this.#slot.getBoundingClientRect();
    this.#visible = this.#rows.length;
    if (!this.#fits(bounds)) {
      this.#visible = 0;
      let used = 0, complete = 0;
      for (const row of this.#rows) {
        const height = row.getBoundingClientRect().height;
        if (used + height > this.#slot.clientHeight + .25) break;
        used += height; complete++;
      }
      for (let count = Math.min(complete, this.#rows.length - 1); count > 0; count--) {
        this.#more.remove();
        for (const [index, row] of this.#rows.entries()) {
          row.hidden = index >= count; row.inert = row.hidden; row.removeAttribute('data-more-inline');
        }
        const last = this.#rows[count - 1];
        this.#setMore(this.#rows.length - count); last.append(this.#more);
        // Measure the join with the control; both keep a 44px row-height target.
        last.setAttribute('data-more-inline', '');
        if (last.scrollWidth > last.clientWidth + .5) {
          last.removeAttribute('data-more-inline'); setText(this.#more.querySelector('.upload-notices-more-join'), '');
        }
        if (this.#fits(bounds)) { this.#visible = count; break; }
      }
      if (!this.#visible) {
        this.#more.remove();
        for (const row of this.#rows) { row.hidden = true; row.inert = true; row.removeAttribute('data-more-inline'); }
        this.#setMore(this.#rows.length, true); this.#reason.append(this.#more);
      }
    }
    if (hadFocus) {
      const retained = focused?.isConnected && !focused.closest('[hidden], [inert]');
      (retained ? focused : this.#focusFallback())?.focus({ preventScroll: true });
    }
  }
  #showRows() {
    this.#more.remove();
    for (const row of this.#rows) {
      row.hidden = false; row.inert = false; row.removeAttribute('data-more-inline'); this.#body.append(row);
      this.#layoutActions(row);
    }
  }
  #putRowsBack() {
    for (const [index, row] of this.#rows.entries()) {
      row.hidden = index >= this.#visible; row.inert = row.hidden;
      this.#reason.append(row);
    }
  }
  destroy() { this.#observer?.disconnect(); this.prepare(); this.#dialog.remove(); }
}
