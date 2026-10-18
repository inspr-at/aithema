import { consentSaveEndsConversation } from '../../core/src/settings.js';
import { validateConsentDocument } from '../../core/src/consent-document.js';
import { setText } from './dom.js';

/** The host's current, versioned consent document, edited inside Settings. */
export class ConsentSettings {
  #button; #root; #copy; #ports; #document; #epoch = 0; #busy = false; #feature; #statusText = ''; #stale = false; #savingLabel = null;
  constructor({ root, copy, ports }) {
    this.#root = root; this.#copy = copy; this.#ports = ports;
    root.setAttribute('role', 'form');
    root.innerHTML = '<p class="consent-intro"></p><fieldset class="consent-items" aria-label=""></fieldset><p class="consent-withdrawal"></p><p class="consent-status" role="status"></p><button class="consent-save" type="button"></button>';
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
  setCopy(copy) { this.#copy = copy; if (this.#stale) this.#status(copy.host.consentStale); if (!this.#ports.saveButton) setText(this.#button, copy.featureConsent.save); this.#root.setAttribute('aria-label', copy.host.consentPage.legend); this.#root.querySelector('fieldset').setAttribute('aria-label', copy.host.consentPage.legend); }
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
  async open(feature, { reload = false } = {}) {
    const epoch = ++this.#epoch; this.#feature = feature; this.#busy = true;
    if (!reload) { this.#document = null; this.#stale = false; this.#savingLabel = null; this.#root.querySelector('.consent-items').replaceChildren(); }
    this.#root.hidden = false; this.#button.classList.add('consent-save');
    this.#status(this.#copy.host.consentPage.loading); this.#paintBusy();
    try {
      const described = await this.#ports.load();
      if (epoch !== this.#epoch) return;
      validateConsentDocument(described);
      const shorthand = described.mock === true && described.items === undefined;
      const doc = { ...described };
      const ids = doc.features?.[feature];
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
        const supplied = this.#ports.presentation?.translations?.find(entry => entry.locale === this.#copy.display.locale)?.consentItem;
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
      if (!reload) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' }); }
    } catch {
      if (epoch !== this.#epoch) return;
      this.#document = null; this.#savingLabel = null; this.#root.querySelector('.consent-items').replaceChildren();
      this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
  #status(text) {
    this.#statusText = text;
    // The shared footer owns the stale notice; there is only one live message.
    setText(this.#root.querySelector('.consent-status'), this.#ports.saveButton && this.#stale ? '' : text);
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
