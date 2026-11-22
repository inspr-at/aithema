import { consentSaveEndsConversation } from '../../core/src/settings.js';
import { validateConsentDocument } from '../../core/src/consent-document.js';
import { setText } from './dom.js';
import { featureConsentText } from './consent-line.js';
import { resolveCopy } from './copy-resolve.js';

// AIT-612 r2: host copy bundles that predate host.consentPage.loadFailed get the shipped locale's text.
export const consentLoadFailed = copy => resolveCopy(copy, 'host.consentPage.loadFailed');

// The least scroll that shows the span top..bottom inside the scroller (12 px
// clear); when it does not fit, the top anchors. Scrolling by delta, the top
// needs delta <= top - box.top - gap, the bottom delta >= bottom - box.bottom + gap.
function scrollBetween(scroller, top, bottom, gap = 12) {
  const box = scroller.getBoundingClientRect(), most = top - box.top - gap, least = bottom - box.bottom + gap;
  scroller.scrollTop += least <= most ? Math.min(Math.max(0, least), most) : most;
}

/** The host's current, versioned consent document, edited inside Settings. */
export class ConsentSettings {
  #button; #root; #copy; #ports; #document; #epoch = 0; #busy = false; #feature; #item; #statusText = ''; #stale = false; #savingLabel = null; #placed = null;
  constructor({ root, copy, ports }) {
    this.#root = root; this.#copy = copy; this.#ports = ports;
    root.setAttribute('role', 'form');
    root.innerHTML = '<p class="consent-intro"></p><p class="consent-reason" hidden></p><fieldset class="consent-items" aria-label=""></fieldset><p class="consent-withdrawal"></p><p class="consent-status" role="status"></p><button class="consent-save" type="button"></button>';
    if (ports.saveButton) { root.querySelector('.consent-save').remove(); root.querySelector('.consent-status').removeAttribute('role'); root.querySelector('.consent-status').setAttribute('aria-hidden', 'true'); }
    else root.querySelector('.consent-status').setAttribute('aria-live', 'polite');
    this.#button = ports.saveButton ?? root.querySelector('.consent-save');
    this.#button.addEventListener('click', event => {
      if (ports.saveButton && root.hidden) return;
      if (ports.saveButton) { event.preventDefault(); event.stopImmediatePropagation(); }
      void this.#save();
    }, { capture: true });
    root.addEventListener('change', () => { this.#stale = false; this.#status(''); this.#paintBusy(); });
    this.setCopy(copy);
  }
  setCopy(copy) {
    // AIT-612: a failure on screen follows the page language too.
    const failures = c => [c.host.consentFailed, consentLoadFailed(c)], failure = failures(this.#copy).indexOf(this.#statusText);
    this.#copy = copy; this.#paintReason();
    if (this.#stale) this.#status(copy.host.consentStale); else if (this.#statusText && failure >= 0) this.#status(failures(copy)[failure]);
    if (!this.#ports.saveButton) setText(this.#button, copy.featureConsent.save); this.#root.setAttribute('aria-label', copy.host.consentPage.legend); this.#root.querySelector('fieldset').setAttribute('aria-label', copy.host.consentPage.legend); }
  get busy() { return this.#busy; }
  get status() { return this.#statusText; }
  get stale() { return this.#stale; }
  get saveLabel() { return this.#savingLabel ?? (this.#document && consentSaveEndsConversation(this.#document, this.#selected()) ? this.#copy.featureConsent.withdraw : this.#copy.featureConsent.save); }
  #selected() { return [...this.#root.querySelectorAll('input:checked')].map(box => box.value); }
  get active() { return !this.#root.hidden; }
  close() {
    this.#epoch++; this.#root.hidden = true; this.#stale = false; this.#status(''); this.#savingLabel = null;
    for (const row of this.#root.querySelectorAll('.consent-item--target')) row.classList.remove('consent-item--target');
    if (this.#ports.saveButton) { this.#button.classList.remove('consent-save'); this.#button.disabled = false; }
  }
  async open(feature, { reload = false, item } = {}) {
    const epoch = ++this.#epoch; this.#feature = feature; if (!reload) this.#item = item; this.#busy = true;
    if (!reload) { this.#document = null; this.#stale = false; this.#savingLabel = null; this.#root.querySelector('.consent-items').replaceChildren(); }
    this.#root.hidden = false; this.#button.classList.add('consent-save'); this.#paintReason();
    this.#status(this.#copy.host.consentPage.loading); this.#paintBusy();
    if (!reload) { this.#holdFocus(); this.#placed = this.#root.getRootNode().activeElement; }
    try {
      const described = await this.#ports.load();
      if (epoch !== this.#epoch) return;
      validateConsentDocument(described);
      const shorthand = described.mock === true && described.items === undefined;
      const doc = { ...described };
      const ids = this.#item ? doc.items?.filter(entry => entry.id === this.#item.id && entry.version === this.#item.version).map(entry => entry.id) : doc.features?.[feature];
      if (shorthand) doc.items = [{ id: 'mock-processing', version: 1, title: this.#copy.host.consentTitle,
        recipients: this.#copy.host.consentPage.mockRecipients, text: `${this.#copy.host.consentUse.off} ${this.#copy.host.consentPage.mockConsequence}` }];
      if (!Array.isArray(doc.items) || !Array.isArray(doc.selected) || !ids?.length || !ids.every(id => doc.items.some(item => item.id === id))) throw new Error('Consent document unavailable');
      this.#document = doc;
      const fieldset = this.#root.querySelector('.consent-items');
      const intro = doc.mock ? this.#copy.host.consentPage.intro : this.#copy.processingConsent.intro;
      setText(this.#root.querySelector('.consent-intro'), doc.mock && !shorthand ? `${this.#copy.host.consentPage.mockNotice} ${intro}` : intro);
      setText(this.#root.querySelector('.consent-withdrawal'), doc.mock ? this.#copy.host.consentPage.mockTerms : this.#copy.processingConsent.withdrawal);
      const rows = [];
      for (const item of doc.items) {
        const presentation = typeof this.#ports.presentation === 'function' ? this.#ports.presentation(this.#copy.display.locale, item) : this.#ports.presentation;
        const supplied = presentation?.translations?.find(entry => entry.locale === this.#copy.display.locale)?.consentItem;
        const translated = supplied?.id === item.id ? supplied : this.#copy.processingConsent.items[item.id];
        const legal = translated?.version === item.version ? { ...item, ...translated } : item;
        const row = document.createElement('div'); row.className = 'consent-item';
        const label = document.createElement('label'), box = document.createElement('input'), title = document.createElement('span');
        box.type = 'checkbox'; box.value = item.id; box.checked = doc.selected.includes(item.id);
        title.textContent = legal.title; label.append(box, title);
        const recipients = document.createElement('p'), purpose = document.createElement('p');
        recipients.textContent = legal.recipients; purpose.textContent = legal.text;
        recipients.id = `settings-consent-${rows.length}-recipients`; purpose.id = `settings-consent-${rows.length}-purpose`;
        box.setAttribute('aria-describedby', `${recipients.id} ${purpose.id}`);
        row.append(label, recipients, purpose); rows.push(row);
      }
      fieldset.replaceChildren(...rows);
      this.#busy = false; this.#savingLabel = null; this.#stale = reload;
      this.#status(reload ? this.#copy.host.consentStale : ''); this.#paintBusy();
      const targetId = ids.find(id => !doc.selected.includes(id)) ?? ids[0];
      const target = [...fieldset.querySelectorAll('input')].find(box => box.value === targetId);
      target.closest('.consent-item').classList.add('consent-item--target');
      if (!reload) { const scroller = this.#reveal(target); if (this.#focusIsOurs()) this.#focus(target, scroller); }
    } catch {
      if (epoch !== this.#epoch) return;
      this.#document = null; this.#savingLabel = null; this.#root.querySelector('.consent-items').replaceChildren();
      // AIT-612: a document that cannot be loaded or used is a failed load, not a failed save.
      // r2: a failed reload is no longer the stale-but-loaded state, so a language switch keeps the error.
      this.#stale = false; this.#busy = false; this.#status(consentLoadFailed(this.#copy)); this.#paintBusy();
    }
  }
  // AIT-603: the sheet opened for the text feature shows the host's text-consent
  // sentence in full (the dock may shorten it on phones); other features show none.
  #paintReason() {
    const reason = this.#root.querySelector('.consent-reason'), sentence = this.#feature === 'text' ? featureConsentText(this.#copy, 'text') ?? '' : '';
    setText(reason, sentence); reason.hidden = !sentence;
  }
  /** On open: a host sentence not wholly in `scroller`'s view anchors at its top, so the status and items follow it. */
  revealReason(scroller) {
    const reason = this.#root.querySelector('.consent-reason');
    if (reason.hidden || !scroller) return;
    const gap = 12, { top, bottom } = reason.getBoundingClientRect(), box = scroller.getBoundingClientRect();
    if (top < box.top + gap || bottom > box.bottom - gap) scroller.scrollTop += top - box.top - gap;
  }
  // AIT-603: with the host sentence shown, a loaded document keeps it on screen:
  // the scroll moves the least that shows the sentence and the target checkbox
  // with its label line together (not the purpose below it), and anchors at the
  // sentence when both do not fit. Without it (or without a scrolling ancestor)
  // the target checkbox centres, as on main. Returns the scroller.
  #reveal(target) {
    const reason = this.#root.querySelector('.consent-reason'), view = this.#root.ownerDocument.defaultView;
    let scroller = null;
    for (let n = target.closest('.consent-item')?.parentElement; n && view?.getComputedStyle; n = n.parentElement) {
      if (/(auto|scroll)/u.test(view.getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) { scroller = n; break; }
    }
    if (reason.hidden || !scroller) { target.scrollIntoView({ block: 'center' }); return scroller; }
    scrollBetween(scroller, reason.getBoundingClientRect().top, (target.closest('label') ?? target).getBoundingClientRect().bottom);
    return scroller;
  }
  // AIT-603: a load moves focus only if it is still where the sheet put it on
  // open (the sentence, the element focused then) or nowhere in particular (the
  // page, the sheet itself). Focus the visitor moved while it loaded stays.
  #focusIsOurs() {
    const active = this.#root.getRootNode().activeElement;
    return !active || active === this.#placed || active === this.#root || active === this.#root.querySelector('.consent-reason') || active === this.#root.ownerDocument.body;
  }
  // AIT-603: keyboard focus lands on screen. The target checkbox takes it when
  // the reveal shows it; otherwise (the sentence anchors, the target is below)
  // the host sentence does, as a programmatic stop (tabindex -1: the Tab order
  // is unchanged), and Tab moves on into the items.
  // While the document loads, and after it fails, Save is disabled and focus
  // would fall to the page; with the host sentence shown, it takes focus instead
  // (the same programmatic stop). Focus the visitor moved elsewhere stays.
  #holdFocus() {
    const reason = this.#root.querySelector('.consent-reason'), active = this.#root.getRootNode().activeElement;
    if (reason.hidden || active && active !== this.#button && active !== this.#root.ownerDocument.body) return;
    reason.tabIndex = -1; reason.focus({ preventScroll: true });
  }
  #focus(target, scroller) {
    const reason = this.#root.querySelector('.consent-reason'), view = scroller?.getBoundingClientRect(), box = target.getBoundingClientRect();
    const shown = !view || box.width > 0 && box.height > 0 && box.top >= view.top - .5 && box.bottom <= view.bottom + .5;
    // r3: focusVisible, so the checkbox shows its ring as in the voice cases even
    // when the sheet was opened by pointer and held focus on the sentence first.
    // r4 (gate M2): engines that ignore focusVisible may omit the ring after a
    // pointer open; data-focus-ring draws the same ring until the checkbox blurs.
    if (shown || reason.hidden) {
      target.dataset.focusRing = '';
      target.addEventListener('blur', () => { delete target.dataset.focusRing; }, { once: true });
      target.focus({ preventScroll: true, focusVisible: true });
      // r5 (gate Low): focus did not land, so no marker may ring a later pointer focus.
      const root = target.getRootNode?.() ?? target.ownerDocument;
      if (root && root.activeElement !== target) delete target.dataset.focusRing;
      return;
    }
    reason.tabIndex = -1; reason.focus({ preventScroll: true });
  }
  #status(text) {
    this.#statusText = text;
    // In Settings the shared footer beside Save owns every message, failures included (AIT-612: one error, once,
    // next to the action that failed); standalone, this status sits above the sheet's own Save.
    setText(this.#root.querySelector('.consent-status'), this.#ports.saveButton ? '' : text);
  }
  #paintBusy() {
    const fieldset = this.#root.querySelector('fieldset');
    fieldset.disabled = this.#busy || !this.#document; fieldset.inert = this.#busy;
    this.#root.setAttribute('aria-busy', String(this.#busy));
    // aria-disabled keeps keyboard focus on Save during the asynchronous reload.
    this.#button.disabled = !this.#document;
    this.#button.setAttribute('aria-disabled', String(this.#busy || !this.#document));
    if (!this.#ports.saveButton) setText(this.#button, this.saveLabel);
    this.#ports.changed?.();
  }
  async #save() {
    if (this.#busy || !this.#document) return;
    const epoch = this.#epoch, doc = this.#document;
    const items = this.#selected();
    if (!items.length && !doc.selected.length) { this.#ports.done(); return; }
    this.#savingLabel = this.saveLabel; this.#busy = true; this.#status(this.#copy.host.consentPage.saving); this.#paintBusy();
    try {
      await this.#ports.save({ granted: items.length > 0 && !consentSaveEndsConversation(doc, items), processing: { contract: doc.contract, items, ...(doc.consentRevision !== undefined ? { revision: doc.consentRevision } : {}) } });
      if (epoch === this.#epoch) this.#ports.done();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      if (error.code === 'consent-stale') { await this.open(this.#feature, { reload: true }); return; }
      this.#savingLabel = null; this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
}
