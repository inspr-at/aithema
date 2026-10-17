import { node, setText } from './dom.js';

const ROLES = ['private', 'company', 'representative', 'agency'];
const sparkle = '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3c1.1 7.6 3.4 9.9 11 11-7.6 1.1-9.9 3.4-11 11C12.9 17.4 10.6 15.1 3 14c7.6-1.1 9.9-3.4 11-11Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const chevron = '<svg class="actor-chevron" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const spinner = '<svg class="actor-spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/><path d="M8 1.75A6.25 6.25 0 0 1 14.25 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const alertIcon = '<svg class="actor-status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6v4.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.1" r=".9" fill="currentColor"/></svg>';
const refreshIcon = '<svg class="actor-status-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 6.4A5.4 5.4 0 0 0 3.1 5.3M2.8 9.6a5.4 5.4 0 0 0 10.1 1.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 2.6v2.9h2.9M13 13.4v-2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';


/** Host labels and account content, module mechanics. Only command acknowledgements
 * change the footer; focus movement never writes. No scenario/sample data lives here. */
export class ActorRole {
  #root; #copy; #options; #session; #request; #settings; #view = null; #phase = 'idle'; #pending = null; #attempt = null;
  #command = null; #alive = true; #read = 0; #generation = 0; #opener; #outside; #escape; #account; #accountParent; #slotChange;
  constructor({ root, copy, options, session, request, settings }) {
    this.#root = root; this.#copy = copy; this.#options = options; this.#session = session; this.#request = request; this.#settings = settings;
    this.element = node('div', 'actor-role');
    this.element.innerHTML = '<span class="actor-reservation" aria-hidden="true"></span><button class="actor-trigger" type="button" aria-expanded="false" aria-controls="actor-popover" hidden><span class="actor-trigger-text"><span class="actor-key"></span><span class="actor-value"></span></span><span class="actor-spark">'+sparkle+'</span>'+chevron+'</button><div class="actor-popover actor-surface" id="actor-popover" hidden></div>';
    root.querySelector('.footer-left').append(this.element);
    this.sheet = node('dialog', 'actor-sheet');
    this.sheet.innerHTML = '<header><h2></h2><button type="button" class="actor-close" aria-label="'+copy.actorRole.close+'">×</button></header><section class="actor-sheet-section actor-surface"></section><section class="actor-processing"><h3></h3><button type="button"></button></section>';
    root.append(this.sheet);
    for (const [index, surface] of this.#surfaces().entries()) {
      surface.innerHTML = (index ? '<h3 class="actor-title"></h3>' : '<div class="actor-account" hidden></div>') +
        '<div class="actor-context"><p class="actor-why"><span class="actor-why-spark">'+sparkle+'</span><span class="actor-reason"></span></p></div><fieldset class="actor-radios"><legend class="visually-hidden"></legend></fieldset><p class="actor-status" role="status"></p>';
      for (const role of ROLES) {
        const label = node('label', 'actor-option'); label.dataset.role = role;
        label.innerHTML = '<span class="actor-dot"><input type="radio" name="actor-role-'+index+'" value="'+role+'">'+spinner+'</span><span class="actor-option-text"></span>';
        surface.querySelector('fieldset').append(label);
      }
      surface.addEventListener('keydown', event => {
        if (!event.target.matches('input[type=radio]')) return;
        const inputs = [...surface.querySelectorAll('input')];
        const direction = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (direction) {
          event.preventDefault(); if (this.#phase === 'saving') return;
          const next = inputs[(inputs.indexOf(event.target) + direction + inputs.length) % inputs.length];
          inputs.forEach(input => { input.tabIndex = input === next ? 0 : -1; }); next.focus();
        } else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); void this.choose(event.target.value); }
      });
      surface.addEventListener('click', event => {
        if (event.target.matches('input')) { const role = event.target.value; this.#paint(); void this.choose(role); }
        if (event.target.closest('.actor-retry')) void this.choose(this.#attempt);
      });
    }
    this.#trigger.addEventListener('click', event => { this.popover.hidden ? this.open(event.detail === 0) : this.close(); });
    let tabbing = false;
    this.element.addEventListener('keydown', event => { if (event.key === 'Tab') tabbing = true; });
    this.element.addEventListener('pointerdown', () => { tabbing = false; });
    this.element.addEventListener('focusout', event => {
      if (event.relatedTarget ? !this.element.contains(event.relatedTarget) : tabbing) this.close();
      tabbing = false;
    });
    this.sheet.querySelector('.actor-close').addEventListener('click', () => this.closeSheet());
    this.sheet.addEventListener('cancel', event => { event.preventDefault(); this.closeSheet(); });
    this.sheet.addEventListener('click', event => { if (event.target === this.sheet) this.closeSheet(); });
    this.sheet.querySelector('.actor-processing button').addEventListener('click', () => { const opener = this.#opener; this.closeSheet(); this.#settings(opener); });
    this.#outside = event => { if (!event.composedPath().includes(this.element)) this.close(); };
    this.#escape = event => { if (event.key === 'Escape' && !this.popover.hidden) { event.preventDefault(); this.close(true); } };
    root.ownerDocument.addEventListener('click', this.#outside); root.addEventListener('keydown', this.#escape);
    this.#account = root.querySelector('slot[name="account"]'); this.#accountParent = this.#account?.parentNode;
    this.#slotChange = () => this.#paintAccount(); this.#account?.addEventListener('slotchange', this.#slotChange);
    this.set(session().roleChoice ?? null); this.setCopy(copy);
  }
  get #trigger() { return this.element.querySelector('.actor-trigger'); }
  get popover() { return this.element.querySelector('.actor-popover'); }
  #surfaces() { return [this.popover, this.sheet.querySelector('.actor-sheet-section')]; }
  #labels() { const labels = this.#options?.labels?.[this.#session().locale]; return labels && ROLES.every(role => typeof labels[role] === 'string' && labels[role].trim()) ? labels : null; }
  get available() { return this.#view?.available === true && Boolean(this.#labels()); }
  setCopy(copy) {
    this.#copy = copy;
    const c = copy.actorRole;
    setText(this.sheet.querySelector('h2'), copy.settings.title);
    this.sheet.querySelector('.actor-close').setAttribute('aria-label', copy.actorRole.close);
    setText(this.sheet.querySelector('.actor-title'), c.label);
    setText(this.sheet.querySelector('.actor-processing h3'), copy.actorRole.processing);
    setText(this.sheet.querySelector('.actor-processing button'), copy.presets[this.#session().processingPreset] ?? copy.settings.open);
    const labels = this.#labels(); const reservation = this.element.querySelector('.actor-reservation'); reservation.replaceChildren();
    if (labels) for (const role of ROLES) {
      const row = node('span'); row.append(node('span', '', c.label+': '), node('span', 'actor-value', labels[role]));
      const spark = node('span', 'actor-spark'); spark.innerHTML = sparkle; row.append(spark); row.insertAdjacentHTML('beforeend', chevron); reservation.append(row);
    }
    for (const surface of this.#surfaces()) {
      setText(surface.querySelector('legend'), c.label);
      for (const role of ROLES) setText(surface.querySelector('[data-role="'+role+'"] .actor-option-text'), labels?.[role] ?? '');
    }
    for (const surface of this.#surfaces()) delete surface.querySelector('.actor-status').dataset.phase;
    this.#paint();
  }
  set(view) {
    if (view && (!this.#view || view.revision === undefined || view.revision >= (this.#view.revision ?? -1))) this.#view = structuredClone(view);
    this.#paint();
  }
  async load() {
    const read = ++this.#read, generation = this.#generation;
    try {
      const response = await this.#request('identity');
      if (this.#alive && read === this.#read && generation === this.#generation) {
        if (response.ok) this.set(response.body?.roleChoice ?? { available: false });
        else if (response.status === 503) this.set({ available: false });
      }
    } catch { /* A failed read keeps the last acknowledged projection. */ }
  }
  sync() {
    const session = this.#session();
    if (this.#view && this.#phase !== 'saving') {
      const actor = session.actor;
      this.set({ ...this.#view, revision: session.seq, role: actor?.type ?? null,
        source: actor?.evidence === 'selected' ? 'chosen' : 'inferred', reasoning: actor?.reasoning ?? null });
    }
  }
  open(focus = false) {
    if (!this.available || this.#phone()) return;
    this.#paint(); this.popover.hidden = false; this.#trigger.setAttribute('aria-expanded', 'true');
    if (focus) (this.popover.querySelector('input:checked') ?? this.popover.querySelector('input')).focus();
    void this.load();
  }
  close(focus = false) { this.popover.hidden = true; this.#trigger.setAttribute('aria-expanded', 'false'); if (focus && this.available) this.#trigger.focus(); }
  #phone() { return this.#root.ownerDocument.defaultView.matchMedia('(max-width: 599px)').matches; }
  openSheet(opener) {
    if (!this.available || !this.#phone()) return false;
    this.close(); this.#opener = opener; this.#paint(); this.sheet.showModal(); void this.load(); return true;
  }
  closeSheet() { this.sheet.close(); this.#opener?.focus(); }
  async choose(role) {
    if (!this.available || this.#phase === 'saving' || !ROLES.includes(role)) return;
    if (role === this.#view.role && this.#view.source === 'chosen') { this.close(true); return; }
    const retry = this.#phase === 'error' && this.#command?.role === role;
    this.#phase = 'saving'; this.#pending = this.#attempt = role; const generation = ++this.#generation; this.#read++;
    const command = retry ? this.#command : { role, baseRevision: this.#view.revision, clientEventId: crypto.randomUUID() };
    this.#command = command;
    this.#paint();
    try {
      const response = await this.#request('identity/role', command);
      if (!this.#alive || generation !== this.#generation) return;
      if (response.ok && response.body?.roleChoice) {
        this.set(response.body.roleChoice); this.#phase = this.sheet.open ? 'saved' : 'idle'; this.#pending = null; this.#paint();
        if (!this.sheet.open) this.close(true);
      } else if (response.status === 409 && response.body?.error === 'role-conflict' && response.body.roleChoice) {
        this.set(response.body.roleChoice); this.#phase = 'stale'; this.#pending = null; this.#paint();
      } else if (response.status === 503 && response.body?.error === 'role-unavailable') {
        this.#phase = 'idle'; this.#pending = null; this.set({ available: false });
      } else { this.#phase = 'error'; this.#pending = null; this.#paint(); }
    } catch { if (this.#alive && generation === this.#generation) { this.#phase = 'error'; this.#pending = null; this.#paint(); } }
  }
  #paintAccount() {
    const account = this.popover.querySelector('.actor-account');
    const present = this.available && this.#account?.assignedNodes().some(n => n.nodeType === 1 || n.textContent.trim());
    account.hidden = !present;
    const parent = this.available ? account : this.#accountParent;
    if (this.#account && this.#account.parentNode !== parent) parent.append(this.#account);
  }
  #paint() {
    if (!this.element || !this.sheet) return;
    this.element.dataset.phase = this.#phase;
    this.#trigger.hidden = !this.available;
    this.element.toggleAttribute('data-unavailable', !this.available);
    if (!this.available) { this.close(); if (this.sheet.open) this.closeSheet(); }
    const c = this.#copy.actorRole, labels = this.#labels();
    setText(this.element.querySelector('.actor-key'), c.label+': ');
    setText(this.element.querySelector('.actor-trigger .actor-value'), labels?.[this.#view?.role] ?? '');
    const spark = this.element.querySelector('.actor-spark'); spark.hidden = this.#view?.source !== 'inferred'; spark.setAttribute('aria-label', c.inferred); spark.setAttribute('role', 'img');
    for (const surface of this.#surfaces()) {
      surface.dataset.phase = this.#phase;
      const inferred = this.#view?.source === 'inferred'; surface.querySelector('.actor-why').dataset.kind = inferred ? 'inferred' : 'chosen';
      const reason = surface.querySelector('.actor-reason');
      if (inferred) reason.replaceChildren(node('b', '', c.why), document.createTextNode(' '+(this.#view?.reasoning ?? '')));
      else setText(reason, c.chosen);
      const why = surface.querySelector('.actor-why'); if (inferred && this.#view?.reasoning) why.title = this.#view.reasoning; else why.removeAttribute('title');
      for (const input of surface.querySelectorAll('input')) {
        input.checked = input.value === (this.#pending ?? this.#view?.role);
        input.disabled = this.#phase === 'saving' && input.value !== this.#pending;
        input.tabIndex = input.checked || !this.#view?.role && input.value === ROLES[0] ? 0 : -1;
        input.closest('label').toggleAttribute('data-pending', this.#phase === 'saving' && input.value === this.#pending);
        input.setAttribute('aria-busy', String(this.#phase === 'saving' && input.value === this.#pending));
      }
      const status = surface.querySelector('.actor-status');
      const key = this.#phase === 'idle' ? 'hint' : this.#phase;
      if (status.dataset.phase !== key) {
        status.dataset.phase = key; status.replaceChildren();
        if (key === 'error') {
          const message = node('span'); message.innerHTML = alertIcon; message.append(document.createTextNode(c.error));
          status.append(message, node('span', 'actor-status-sep', ' · '));
          const retry = node('button', 'actor-retry', c.retry); retry.type = 'button'; status.append(retry);
        } else if (key === 'stale') {
          const message = node('span'); message.innerHTML = refreshIcon; message.append(document.createTextNode(c.stale)); status.append(message);
        }
        else setText(status, (key === 'saved' ? '✓ ' : '')+c[key]);
      }
    }
    this.#paintAccount();
  }
  destroy() {
    this.#alive = false; this.#generation++; this.#read++;
    this.#root.ownerDocument.removeEventListener('click', this.#outside); this.#root.removeEventListener('keydown', this.#escape);
    this.#account?.removeEventListener('slotchange', this.#slotChange); if (this.#account) this.#accountParent.append(this.#account);
    this.element.remove(); this.sheet.remove();
  }
}
