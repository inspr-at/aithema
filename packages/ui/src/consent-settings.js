import { setText } from './dom.js';

/** The host's current, versioned consent document, edited inside Settings. */
export class ConsentSettings {
  #root; #copy; #ports; #document; #epoch = 0; #busy = false;
  constructor({ root, copy, ports }) {
    this.#root = root; this.#copy = copy; this.#ports = ports;
    root.innerHTML = '<p class="consent-intro"></p><fieldset class="consent-items" aria-label=""></fieldset><p class="consent-withdrawal"></p><p class="consent-status" role="status"></p><button class="consent-save" type="button"></button>';
    root.querySelector('.consent-save').addEventListener('click', () => void this.#save());
    this.setCopy(copy);
  }
  setCopy(copy) { this.#copy = copy; setText(this.#root.querySelector('.consent-save'), copy.featureConsent.save); this.#root.querySelector('fieldset').setAttribute('aria-label', copy.host.consentPage.legend); }
  close() { this.#epoch++; this.#root.hidden = true; }
  async open(feature) {
    const epoch = ++this.#epoch; this.#document = null; this.#busy = true;
    this.#root.hidden = false; this.#root.querySelector('.consent-items').replaceChildren();
    this.#status(this.#copy.host.consentPage.loading); this.#paintBusy();
    try {
      const doc = await this.#ports.load();
      if (epoch !== this.#epoch) return;
      const ids = doc.features?.[feature];
      if (doc.mock === true) doc.items = [{ id: 'mock-processing', version: 1, title: this.#copy.host.consentTitle,
        recipients: this.#copy.host.consentPage.mockRecipients, text: `${this.#copy.host.consentUse.off} ${this.#copy.host.consentPage.mockConsequence}` }];
      if (!Array.isArray(doc.items) || !Array.isArray(doc.selected) || !ids?.length || !ids.every(id => doc.items.some(item => item.id === id))) throw new Error('Consent document unavailable');
      this.#document = doc;
      const fieldset = this.#root.querySelector('.consent-items');
      setText(this.#root.querySelector('.consent-intro'), doc.mock ? this.#copy.host.consentPage.intro : this.#copy.processingConsent.intro);
      setText(this.#root.querySelector('.consent-withdrawal'), doc.mock ? this.#copy.host.consentPage.mockTerms : this.#copy.processingConsent.withdrawal);
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
      target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' });
    } catch {
      if (epoch !== this.#epoch) return;
      this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
  #status(text) { setText(this.#root.querySelector('.consent-status'), text); }
  #paintBusy() {
    this.#root.querySelector('fieldset').disabled = this.#busy || !this.#document;
    this.#root.querySelector('.consent-save').disabled = this.#busy || !this.#document;
  }
  async #save() {
    if (this.#busy || !this.#document) return;
    const epoch = this.#epoch, doc = this.#document;
    const items = [...this.#root.querySelectorAll('input:checked')].map(box => box.value);
    this.#busy = true; this.#status(this.#copy.host.consentPage.saving); this.#paintBusy();
    try {
      await this.#ports.save({ granted: items.length > 0, processing: { contract: doc.contract, items } });
      if (epoch === this.#epoch) this.#ports.done();
    } catch {
      if (epoch !== this.#epoch) return;
      this.#busy = false; this.#status(this.#copy.host.consentFailed); this.#paintBusy();
    }
  }
}
