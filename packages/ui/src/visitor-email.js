import { reasonSeparator } from './consent-line.js';
// Settings reserves only the acknowledged visitor-address states reachable in each mode.
import { setText, fill } from './dom.js';
import { formatCredits } from './display.js';
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const INFO = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5"/><circle cx="10" cy="6" r=".8" fill="currentColor"/></svg>';
const valid = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

// Emphasize the server's tier amounts without treating copy or values as HTML.
export function setTierText(container, template, values) {
  if (container.textContent === fill(template, values)) return;
  container.replaceChildren(...template.split(/(\{\w+\})/u).map(part => {
    const key = /^\{(\w+)\}$/u.exec(part)?.[1];
    if (!key || !Object.hasOwn(values, key)) return container.ownerDocument.createTextNode(part);
    const strong = container.ownerDocument.createElement('strong'); strong.textContent = values[key]; return strong;
  }));
}

/** Identity is the verification evidence; visitor is the owner-wide saved address. */
export class VisitorEmail {
  #delivery = true;
  #settings = null;
  constructor({ root, entry, copy, request, openDialog, changed, demo = false, delivery = true, privacyDocumentConfigured, handover = false, locale }) {
    Object.assign(this, { root, entry, copy, request, openDialog, changed, demo, delivery, privacyDocumentConfigured, handover, locale });
    this.alive = true; this.ui = { editing: false, deleting: false, busy: false, message: '', invalid: false, failed: false };
    entry.id = 'email'; entry.classList.add('host-mail');
    entry.innerHTML = `<h3 class="verify-entry-title" id="email-heading" tabindex="-1"></h3><div class="m-stack">
      <form class="m-view m-form" data-view="capture" novalidate>
        <p class="m-lead m-two"><span class="m-lead-save"></span><span class="m-lead-edit"></span></p>
        <label class="m-label" for="email-input"></label><input class="m-in" id="email-input" type="email" autocomplete="email" maxlength="254" spellcheck="false" aria-describedby="email-message email-notice">
        <button class="m-save" type="submit"></button><button class="m-act m-cancel" type="button"></button>
        <p class="m-msg" id="email-message" role="status"><span class="m-ico"></span><span class="m-msg-text"></span></p>
        <p class="m-notice" id="email-notice"><span class="m-notice-text"></span> <a class="m-pp" target="_blank" rel="noopener"></a></p>
      </form>
      <div class="m-view" data-view="saved"><p class="m-addr"></p><p class="m-tier">${CHECK}<span></span></p>
        <div class="m-acts"><button class="m-act m-change" type="button"></button><span class="m-dot" aria-hidden="true">·</span><button class="m-act m-delete" type="button"></button></div></div>
      <div class="m-view" data-view="confirm" role="group" aria-labelledby="email-delete-question"><p class="m-q" id="email-delete-question"></p>
        <p class="m-cons m-two"><span class="m-delete-normal"></span><span class="m-delete-over"></span></p>
        <div class="m-acts"><button class="m-del" type="button"></button><button class="m-act m-keep" type="button"></button></div>
        <p class="m-delete-message" role="status"></p></div>
      <div class="m-view" data-view="mail"><div class="m-mail-stack">
        <p class="m-lead m-lead-mail"></p><p class="verify-entry-state m-addr"><span class="m-sent-prefix"></span><span class="verify-entry-address"></span></p></div>
        <p class="m-tier m-mail-tier"><span class="m-mail-tier-state"><span class="verify-done">${CHECK}<span></span></span><span class="m-mail-tier-text"></span></span><span class="m-mail-tier-measure" aria-hidden="true"></span></p>
        <span class="verify-entry-status sr-only"></span><div class="m-acts"><button class="m-act verify-entry" type="button" aria-haspopup="dialog"></button>
          <button class="m-act m-change-mail" type="button" aria-haspopup="dialog"></button><span class="m-dot m-mail-dot" aria-hidden="true">·</span><button class="m-act m-delete-mail" type="button"></button></div>
        <p class="m-notice m-mail-notice"><span class="m-notice-text"></span> <a class="m-pp" target="_blank" rel="noopener"></a></p>
      </div>
      <div class="m-view" data-view="unavailable"><p class="m-unavailable"></p><p class="m-unavailable-message" role="status"></p></div>
    </div>`;
    entry.setAttribute('aria-labelledby', 'email-heading');
    this.q('.m-form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.q('#email-input').addEventListener('input', () => { if (!this.ui.busy) { this.ui.invalid = false; this.ui.failed = false; this.ui.message = ''; this.paint(); } });
    this.q('.m-change').addEventListener('click', () => { if (!this.canCollect || this.ui.busy) return; this.ui.editing = true; this.ui.message = ''; this.paint(); const input = this.q('#email-input'); input.value = this.address; input.focus({ preventScroll: true }); input.select(); });
    this.q('.m-cancel').addEventListener('click', () => { if (this.ui.busy) return; this.ui.editing = false; this.ui.message = ''; this.paint(); this.q('.m-change').focus({ preventScroll: true }); });
    for (const selector of ['.m-delete', '.m-delete-mail']) this.q(selector).addEventListener('click', () => { if (this.canDelete !== true || this.ui.busy) return; this.ui.deleting = true; this.ui.message = ''; this.paint(); this.q('.m-keep').focus({ preventScroll: true }); });
    this.q('.m-keep').addEventListener('click', () => { if (this.ui.busy) return; this.ui.deleting = false; this.ui.message = ''; this.paint(); this.q(this.viewDelivery ? '.m-delete-mail' : '.m-delete').focus({ preventScroll: true }); });
    this.q('.m-del').addEventListener('click', () => void this.remove());
    for (const selector of ['.verify-entry', '.m-change-mail']) this.q(selector).addEventListener('click', event => this.openDialog(event.currentTarget));
    this.legalSlot = root.querySelector('slot[name="legal"]');
    this.legalChanged = () => { this.paint(); this.changed?.({ refresh: false }); };
    this.legalSlot?.addEventListener('slotchange', this.legalChanged);
    const Observer = root.ownerDocument.defaultView?.MutationObserver;
    if (Observer && root.host) { this.legalObserver = new Observer(this.legalChanged); this.legalObserver.observe(root.host, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-aithema-privacy', 'rel'] }); }
    this.paint();
  }
  q(selector) { return this.entry.querySelector(selector); }
  get e() { return this.copy.hostSurface.email; }
  get address() { return this.visitor?.address ?? this.identity?.address ?? ''; }
  get privacyLink() {
    const nodes = [...new Set([...(this.legalSlot?.assignedElements?.({ flatten: true }) ?? []), ...(this.root.host?.querySelectorAll('[slot="legal"]') ?? [])])];
    for (const node of nodes) {
      const link = node.matches?.('a[data-aithema-privacy],a[rel~="privacy-policy"]') ? node : node.querySelector?.('a[data-aithema-privacy],a[rel~="privacy-policy"]');
      const href = link?.getAttribute('href');
      if (href) { try { const url = new URL(href, this.root.ownerDocument.baseURI); if (['http:', 'https:'].includes(url.protocol)) return href; } catch { /* Empty/legal text is not a document. */ } }
    }
    return null;
  }
  // Optional confirmation follows the host tiers. The explicit demo-only
  // assessment lock keeps its fake-outbox flow, independent of credit tiers.
  get delivery() { return this.#delivery && (this.demo && this.identity?.verificationRequired === true || this.tiers?.canConfirm !== false); }
  set delivery(value) { this.#delivery = value; }
  get viewDelivery() { return this.#settings?.delivery ?? this.delivery; }
  /** General's first visit owns its mode and grid reservation until Settings closes. */
  beginSettings() {
    if (this.#settings) return;
    this.#settings = { delivery: this.delivery, unknown: !this.tiers };
    this.paint();
  }
  endSettings() {
    if (!this.#settings) return;
    this.#settings = null; this.paint();
  }
  get canCollect() { return this.demo || this.privacyDocumentConfigured === true && Boolean(this.privacyLink); }
  get state() { return this.canDelete === true && this.ui.deleting && this.address ? 'confirm' : !this.canCollect && !this.address ? 'unavailable' : this.viewDelivery ? 'mail' : this.address && !this.ui.editing ? 'saved' : this.canCollect ? 'capture' : 'saved'; }
  set(values) { Object.assign(this, values); this.paint(); }
  format(value) { return Number.isFinite(value) ? formatCredits(value, this.locale?.() ?? this.copy.display.locale) : ''; }
  get numbers() { const a = this.tiers?.allowancesMicro; return { base: this.format(a?.anonymous), email: this.format(a?.emailGiven), confirmed: this.format(a?.emailConfirmed) }; }
  noticeText() { return [this.viewDelivery ? this.e.noticeMail : this.e.noticeSave, this.handover ? this.e.noticeHandover : ''].filter(Boolean).join(' '); }
  paintNotice(container) {
    // Preserve the old save paragraph's wrapped height, including its legal link.
    // The visible copy and the aria-hidden measure share the same grid cell.
    let content = container.querySelector('.m-notice-content');
    if (!content) {
      content = container.ownerDocument.createElement('span'); content.className = 'm-notice-content';
      content.append(...container.childNodes); container.append(content);
      const measure = container.ownerDocument.createElement('span'); measure.className = 'm-notice-measure';
      measure.setAttribute('aria-hidden', 'true'); measure.inert = true;
      const text = container.ownerDocument.createElement('span'); text.className = 'm-notice-old';
      const privacy = container.ownerDocument.createElement('span'); privacy.className = 'm-pp';
      measure.append(text, ' ', privacy); container.append(measure);
    }
    container.dataset.noticeMode = this.viewDelivery ? 'mail' : 'save';
    setText(container.querySelector('.m-notice-old'), [this.e.notice, this.handover ? this.e.noticeHandover : ''].filter(Boolean).join(' '));
    const measuredLink = container.querySelector('.m-notice-measure .m-pp');
    setText(measuredLink, this.e.privacy); measuredLink.hidden = !this.privacyLink;
    setText(container.querySelector('.m-notice-text'), this.noticeText());
    const link = content.querySelector('.m-pp'), href = this.privacyLink;
    setText(link, this.e.privacy); link.hidden = !href;
    if (href) link.setAttribute('href', href); else link.removeAttribute('href');
  }
  paintLead(selector, template, values) {
    const lead = this.q(selector), status = !this.tiers && ['loading', 'failed'].includes(this.creditsState);
    if (lead.classList.contains('m-credit-status') !== status) lead.classList.toggle('m-credit-status', status);
    for (const [attribute, value] of [['role', 'status'], ['aria-live', 'polite']]) {
      if (status) { if (lead.getAttribute(attribute) !== value) lead.setAttribute(attribute, value); }
      else if (lead.hasAttribute(attribute)) lead.removeAttribute(attribute);
    }
    const failure = this.canCollect ? this.viewDelivery ? this.e.creditFailedMail : this.e.creditFailedSave : this.e.creditFailed;
    // The guarded text writer preserves the live region across repeated paints.
    setTierText(lead, status ? this.creditsState === 'failed' ? failure : this.e.creditLoading : template, values);
  }
  paint() {
    const e = this.e, v = this.copy.hostSurface.verify, state = this.state, n = this.numbers;
    this.entry.dataset.emailState = state === 'mail' ? this.identity?.status === 'verified' ? 'confirmed' : this.address ? 'pending' : 'mailnone' : state;
    this.entry.dataset.emailMode = this.viewDelivery ? 'mail' : 'save';
    this.entry.dataset.emailReservation = this.#settings?.unknown ? 'union' : this.viewDelivery ? 'mail' : 'save';
    this.entry.dataset.emailHelp = !this.canCollect && !this.address ? 'general' : this.address && (!this.viewDelivery || this.identity?.status === 'verified') ? 'generalEmailManage' : this.viewDelivery ? 'generalEmail' : 'generalEmailSave';
    setText(this.q('h3'), v.section);
    for (const view of this.entry.querySelectorAll('.m-stack > .m-view')) { const shown = view.dataset.view === state; view.classList.toggle('on', shown); view.inert = !shown; view.setAttribute('aria-hidden', String(!shown)); }
    this.q('.m-form').classList.toggle('editing', this.ui.editing);
    const givenRaises = this.tiers?.allowancesMicro?.emailGiven > this.tiers?.allowancesMicro?.anonymous;
    this.paintLead('.m-lead-save', this.tiers ? givenRaises ? e.leadSave : e.tier : '', { ...n, tier: n.email });
    this.paintLead('.m-lead-edit', this.tiers ? e.leadEdit : '', n);
    setText(this.q('.m-label'), v.label); this.q('#email-input').placeholder = v.placeholder;
    this.q('#email-input').setAttribute('aria-invalid', String(this.ui.invalid));
    for (const [selector, key] of [['.m-save', 'save'], ['.m-cancel', 'cancel'], ['.m-change', 'change'], ['.m-delete', 'delete'], ['.m-q', 'deleteQuestion'], ['.m-del', 'deleteConfirm'], ['.m-keep', 'cancel'], ['.m-change-mail', 'change'], ['.m-delete-mail', 'delete'], ['.m-unavailable', 'unavailable']]) setText(this.q(selector), e[key]);
    for (const selector of ['.m-save', '.m-del']) this.q(selector).setAttribute('aria-disabled', String(this.ui.busy));
    setText(this.q('.m-addr'), this.address);
    setText(this.q('.m-tier > span'), this.tiers ? fill(e.tier, { tier: n.email }) : '');
    const base = this.tiers?.allowancesMicro?.anonymous, spent = this.balance?.committedMicro;
    const over = Number.isFinite(base) && Number.isFinite(spent) && spent >= base;
    this.q('.m-cons').classList.toggle('over', over);
    setText(this.q('.m-delete-normal'), this.canDelete === true && this.tiers && Number.isFinite(spent) ? fill(e.deleteDrop, { ...n, available: this.format(Math.max(0, base - spent)) }) : '');
    setText(this.q('.m-delete-over'), this.canDelete === true && Number.isFinite(spent) ? fill(e.deleteOver, { spent: this.format(spent) }) : '');
    setText(this.q('.m-msg-text'), this.ui.message); this.q('.m-ico').innerHTML = this.ui.message && !this.ui.busy ? this.ui.invalid || this.ui.failed ? INFO : CHECK : '';
    setText(this.q('.m-delete-message'), this.ui.deleting ? this.ui.message : '');
    setText(this.q('.m-unavailable-message'), state === 'unavailable' ? this.ui.message : '');
    this.paintNotice(this.q('#email-notice')); this.paintNotice(this.q('.m-mail-notice'));
    const verified = this.identity?.status === 'verified', pending = this.identity?.status === 'verification-pending';
    this.q('[data-view="mail"]').dataset.address = String(Boolean(this.address));
    this.paintLead('.m-lead-mail', this.tiers ? this.tiers.canConfirm ? e.leadMail : givenRaises ? e.leadSave : e.tier : '', { ...n, tier: n.email });
    setText(this.q('.m-sent-prefix'), pending ? e.sentTo + ' ' : ''); setText(this.q('.verify-entry-address'), this.address);
    setText(this.q('.verify-entry-status'), pending ? v.linkSent : v.unverified); this.q('.verify-entry-status').hidden = verified;
    setText(this.q('.verify-done > span'), this.tiers ? e.confirmedLabel : v.verifiedShort); this.q('.verify-done').hidden = !verified;
    setText(this.q('.m-mail-tier-text'), this.tiers && this.address ? verified ? reasonSeparator + fill(e.tier, { tier: this.format(this.tiers.allowancesMicro[this.tiers.current]) }) : this.tiers.canConfirm ? fill(e.pendingTier, n) : fill(e.tier, { tier: n.email }) : '');
    // Reserve the pending tier even before an address exists or after confirmation.
    setText(this.q('.m-mail-tier-measure'), this.viewDelivery && this.tiers ? fill(e.pendingTier, n) : '');
    const button = this.q('.verify-entry'); button.hidden = !this.viewDelivery || !this.canCollect || verified;
    setText(button, pending ? v.resendOrChange : v.entry);
    this.q('.m-change-mail').hidden = !verified || !this.canCollect;
    for (const selector of ['.m-delete', '.m-delete-mail']) {
      const button = this.q(selector); button.disabled = this.canDelete !== true;
      if (this.canDelete !== true) { button.setAttribute('aria-disabled', 'true'); button.tabIndex = -1; }
      else { button.removeAttribute('aria-disabled'); button.removeAttribute('tabindex'); }
    }
    this.q('.m-delete-mail').hidden = !this.address; this.q('.m-mail-dot').hidden = !this.address;
    this.q('.m-mail-notice').style.visibility = this.address && this.canDelete === true ? 'hidden' : '';
    if (this.address && this.canDelete !== true) {
      const notice = this.q('.m-mail-notice');
      const text = notice.querySelector('.m-notice-content .m-notice-text') ?? notice.querySelector('.m-notice-text');
      const link = notice.querySelector('.m-notice-content .m-pp') ?? notice.querySelector('.m-pp');
      const [before, after] = e.deleteUnavailable.split('{privacy}');
      setText(text, before); setText(link, e.deletePrivacy); link.hidden = false;
      if (this.privacyLink) link.href = this.privacyLink; else link.removeAttribute('href');
      let tail = notice.querySelector('.m-delete-tail');
      if (!tail) { tail = notice.ownerDocument.createElement('span'); tail.className = 'm-delete-tail'; link.after(tail); }
      setText(tail, after ?? '');
      let savedReason = this.q('.m-delete-reason');
      if (!savedReason) { savedReason = notice.cloneNode(true); savedReason.className = 'm-delete-reason m-notice'; this.q('[data-view="saved"]').append(savedReason); }
      savedReason.innerHTML = notice.innerHTML; savedReason.style.visibility = '';
    } else { this.q('.m-delete-reason')?.remove(); this.q('.m-delete-tail')?.remove(); }
    this.q('.m-mail-notice').inert = Boolean(this.address && this.canDelete === true);
    this.q('.m-change').setAttribute('aria-disabled', String(!this.canCollect));
  }
  focus() { const target = this.state === 'capture' ? '#email-input' : this.state === 'saved' ? '.m-change' : this.state === 'mail' ? this.identity?.status === 'verified' ? '.m-change-mail' : '.verify-entry' : 'h3'; this.q(target)?.focus({ preventScroll: true }); }
  async save() {
    if (this.ui.busy || !this.canCollect) return;
    const input = this.q('#email-input'), address = input.value.trim();
    if (!valid(address)) { this.ui.invalid = true; this.ui.message = this.copy.hostSurface.verify.invalid; this.paint(); input.focus({ preventScroll: true }); return; }
    this.ui.busy = true; this.ui.failed = false; this.ui.invalid = false; this.ui.message = this.e.saving; this.paint();
    let response; try { response = await this.request('/api/visitor/email', { address, noticeVersion: this.notice?.version }, 'PUT'); } catch { /* Keep the prior acknowledged address. */ }
    if (!this.alive) return;
    this.ui.busy = false;
    if (response?.ok && response.body?.visitor) {
      this.visitor = response.body.visitor; this.identity = { ...this.identity, address: this.visitor.address, status: 'guest' };
      this.ui.editing = false; this.ui.message = ''; input.value = ''; this.paint();
      await this.changed?.({ refresh: true }); if (this.alive) this.q('.m-change').focus({ preventScroll: true });
    } else { this.ui.failed = true; this.ui.message = response?.status === 400 ? this.copy.hostSurface.verify.invalid : this.e.failed; this.ui.invalid = response?.status === 400; this.paint(); }
  }
  async remove() {
    if (this.ui.busy || !this.address || this.canDelete !== true) return;
    this.ui.busy = true; this.ui.failed = false; this.ui.message = this.e.deleting; this.paint();
    let response; try { response = await this.request('/api/visitor/email', {}, 'DELETE'); } catch { /* Deletion is acknowledged before clearing the UI. */ }
    if (!this.alive) return;
    this.ui.busy = false;
    if (response?.ok && response.body?.visitor) {
      this.visitor = response.body.visitor; this.identity = { ...this.identity, address: null, status: 'guest' };
      this.ui.deleting = false; this.ui.editing = false;
      this.q('#email-input').value = '';
      const over = this.balance?.committedMicro >= this.tiers?.allowancesMicro?.anonymous;
      this.ui.message = over ? this.e.deletedOut : fill(this.e.deleted, this.numbers); this.paint();
      await this.changed?.({ refresh: true }); if (this.alive) this.focus();
    } else { this.ui.failed = true; this.ui.message = this.e.deleteFailed; this.paint(); }
  }
  destroy() { this.alive = false; this.legalSlot?.removeEventListener('slotchange', this.legalChanged); this.legalObserver?.disconnect(); }
  async persist(address) {
    if (!this.canCollect || !this.notice?.version) return { ok: false };
    let response;
    try { response = await this.request('/api/visitor/email', { address, noticeVersion: this.notice.version }, 'PUT'); } catch { return { ok: false }; }
    if (!this.alive || !response?.ok || !response.body?.visitor) return response ?? { ok: false };
    this.visitor = response.body.visitor;
    return response;
  }
}
