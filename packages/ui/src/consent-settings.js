import { consentSaveEndsConversation } from '../../core/src/settings.js';
import { validateConsentDocument } from '../../core/src/consent-document.js';
import { setText } from './dom.js';

/** The host's current, versioned consent document, edited inside Settings. */
export class ConsentSettings {
  #button; #root; #copy; #ports; #document; #epoch = 0; #busy = false;
  constructor({ root, copy, ports }) {
    this.#root = root; this.#copy = copy; this.#ports = ports;
    root.innerHTML = '<p class="consent-intro"></p><fieldset class="consent-items" aria-label=""></fieldset><p class="consent-withdrawal"></p><p class="consent-status" role="status"></p><button class="consent-save" type="button"></button>';
    if (ports.saveButton) root.querySelector('.consent-save').remove();
    this.#button = ports.saveButton ?? root.querySelector('.consent-save');
    this.#button.addEventListener('click', event => {
      if (ports.saveButton && root.hidden) return;
      if (ports.saveButton) { event.preventDefault(); event.stopImmediatePropagation(); }
      void this.#save();
    }, { capture: true });
    root.addEventListener('change', () => this.#paintBusy());
    this.setCopy(copy);
  }
  setCopy(copy) { this.#copy = copy; if (!this.#ports.saveButton) setText(this.#button, copy.featureConsent.save); this.#root.querySelector('fieldset').setAttribute('aria-label', copy.host.consentPage.legend); }
  get saveLabel() { return this.#document && consentSaveEndsConversation(this.#document, this.#selected()) ? this.#copy.featureConsent.withdraw : this.#copy.featureConsent.save; }
  #selected() { return [...this.#root.querySelectorAll('input:checked')].map(box => box.value); }
  get active() { return !this.#root.hidden; }
  close() {
    this.#epoch++; this.#root.hidden = true;
    for (const row of this.#root.querySelectorAll('.consent-item--target')) row.classList.remove('consent-item--target');
    if (this.#ports.saveButton) { this.#button.classList.remove('consent-save'); this.#button.disabled = false; }
  }
  async open(feature) {
    const epoch = ++this.#epoch; this.#document = null; this.#busy = true;
    this.#root.hidden = false; this.#button.classList.add('consent-save'); this.#root.querySelector('.consent-items').replaceChildren();
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
      const intro = doc.intro ?? (doc.mock ? this.#copy.host.consentPage.intro : this.#copy.processingConsent.intro);
      setText(this.#root.querySelector('.consent-intro'), doc.mock && !shorthand ? `${this.#copy.host.consentPage.mockNotice} ${intro}` : intro);
      setText(this.#root.querySelector('.consent-withdrawal'), doc.withdrawal ?? (doc.mock ? this.#copy.host.consentPage.mockTerms : this.#copy.processingConsent.withdrawal));
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
        recipients.id = `settings-consent-${fieldset.children.length}-recipients`; purpose.id = `settings-consent-${fieldset.children.length}-purpose`;
        box.setAttribute('aria-describedby', `${recipients.id} ${purpose.id}`);
        row.append(label, recipients, purpose); fieldset.append(row);
      }
      this.#busy = false; this.#status(''); this.#paintBusy();
      const targetId = ids.find(id => !doc.selected.includes(id)) ?? ids[0];
      const target = [...fieldset.querySelectorAll('input')].find(box => box.value === targetId);
      target.closest('.consent-item').classList.add('consent-item--target');
      target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' });
    } catch {
      if (epoch !== this.#epoch) return;
      this.#document = null; this.#root.querySelector('.consent-items').replaceChildren();
      this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
  #status(text) { setText(this.#root.querySelector('.consent-status'), text); }
  #paintBusy() {
    this.#root.querySelector('fieldset').disabled = this.#busy || !this.#document;
    this.#button.disabled = this.#busy || !this.#document;
    if (!this.#ports.saveButton) setText(this.#button, this.saveLabel);
    this.#ports.changed?.();
  }
  async #save() {
    if (this.#busy || !this.#document) return;
    const epoch = this.#epoch, doc = this.#document;
    const items = this.#selected();
    if (!items.length && !doc.selected.length) { this.#ports.done(); return; }
    this.#busy = true; this.#status(this.#copy.host.consentPage.saving); this.#paintBusy();
    try {
      await this.#ports.save({ granted: items.length > 0 && !consentSaveEndsConversation(doc, items), processing: { contract: doc.contract, items } });
      if (epoch === this.#epoch) this.#ports.done();
    } catch {
      if (epoch !== this.#epoch) return;
      this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
}
