import { activeTurns } from '../../core/src/session.js';
import { emailOfferEligibility, visitorMessageCount } from '../../core/src/email-offer.js';
import { fill, setText } from './dom.js';
import { formatCredits } from './display.js';

/** A UI row owned by the server claim, never a canonical conversation turn. */
export class EmailOffer {
  constructor({ root, copy, verification, request, session, streaming, changed }) {
    Object.assign(this, { root, copy, verification, request, session, streaming, changed });
    this.alive = true; this.connected = true; this.state = {}; this.step = 'capture'; this.message = '';
  }
  get email() { return this.verification.email; }
  get eligibility() {
    return emailOfferEligibility({ privacyCapability: this.email.canCollect, delivery: this.email.delivery,
      lock: this.verification.locked, tiers: this.credits?.tiers, scope: this.credits?.scope,
      canConfirm: this.email.demo === true || this.credits?.tiers?.canConfirm === true });
  }
  get entry() {
    return this.state.open && this.email.canCollect && activeTurns(this.session()).some(turn => turn.id === this.state.at)
      ? { at: this.state.at } : null;
  }
  setCredits(credits) {
    this.credits = credits;
    if (credits.emailOffer && (credits.emailOffer.revision ?? 0) >= (this.state.revision ?? 0)) this.state = credits.emailOffer;
    this.update();
  }
  setCopy(copy) { this.copy = copy; this.paint(); }
  update() {
    if (!this.alive || !this.connected) return;
    this.paint();
    const session = this.session(), count = visitorMessageCount(session);
    if (!session.emailOffer || !this.credits || this.busy || this.state.offered || this.declined === count ||
        this.credits.exhausted || this.credits.dailyCapReached || !this.eligibility.eligible || this.streaming() ||
        count < (session.emailOffer.afterMessages ?? 2) || activeTurns(session).at(-1)?.role !== 'assistant' ||
        (this.credits.emailAskAfter ?? 0) > (this.credits.nowMs ?? Infinity)) return;
    void this.act('show', count);
  }
  async act(action, count) {
    if (this.busy || !this.alive) return;
    this.busy = true;
    const variant = this.eligibility;
    let response;
    try { response = await this.request('email-ask', { action, why: 'offer' }); } catch { /* Retry on a later reply. */ }
    this.busy = false;
    if (!this.alive) return;
    if (response?.ok && response.body?.emailOffer) {
      if ((response.body.emailOffer.revision ?? 0) >= (this.state.revision ?? 0)) this.state = response.body.emailOffer;
      if (response.body.accepted && action === 'show') this.variant = variant;
    }
    if (action === 'show' && !response?.body?.accepted) this.declined = count;
    this.paint(); this.changed?.();
  }
  async dismiss() {
    if (this.busy || !this.state.offered) return;
    const focused = this.row?.contains(this.root.activeElement);
    await this.act('dismiss');
    if (focused && !this.state.open) this.root.querySelector('#message')?.focus({ preventScroll: true });
  }
  paintRow(row) {
    this.row = row; row.className = 'email-offer';
    if (!row.firstChild) {
      row.innerHTML = `<button type="button" class="email-offer__dismiss">×</button>
        <p class="email-offer__lead"></p><form novalidate>
          <label class="m-label" for="email-offer-input"></label>
          <div class="email-offer__row"><input class="m-in" id="email-offer-input" type="email" inputmode="email" autocomplete="email" maxlength="254" spellcheck="false" aria-describedby="email-offer-message email-offer-notice">
            <span class="email-offer__address"></span><button class="email-offer__send" type="submit"><span></span></button></div>
          <p class="email-offer__message" id="email-offer-message" role="status"></p>
          <p class="m-notice" id="email-offer-notice"><span class="m-notice-text"></span> <a class="m-pp" target="_blank" rel="noopener"></a></p>
        </form>`;
      row.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
      row.querySelector('.email-offer__dismiss').addEventListener('click', () => void this.dismiss());
      row.querySelector('input').addEventListener('input', () => { this.invalid = false; this.message = ''; this.paint(); });
      row.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); void this.dismiss(); } });
    }
    this.paint();
  }
  paint() {
    if (!this.row || !this.alive || this.root.host?.hasAttribute('data-aithema-erased')) return;
    const row = this.row, v = this.copy.hostSurface.verify, email = this.email;
    const confirmed = email.identity?.status === 'verified';
    if (confirmed) this.step = 'confirmed';
    else if (this.step === 'confirmed') this.step = 'capture';
    row.dataset.step = this.step;
    const next = this.state.nextTier === undefined ? this.variant?.nextTier ?? this.eligibility.nextTier : this.state.nextTier;
    const delta = this.state.deltaMicro ?? this.variant?.delta ?? this.eligibility.delta;
    setText(row.querySelector('.email-offer__lead'), next && delta > 0
      ? fill(this.copy.hostSurface.usedUp[next === 'emailGiven' ? 'hostGive' : 'hostConfirm'], { delta: formatCredits(delta, this.session().locale ?? 'en') }) : v.lockLead);
    const input = row.querySelector('input'), saved = Boolean(email.address);
    input.hidden = saved; input.disabled = confirmed; input.setAttribute('aria-disabled', String(Boolean(this.saving || confirmed))); input.placeholder = v.placeholder;
    input.setAttribute('aria-invalid', String(Boolean(this.invalid)));
    const address = row.querySelector('.email-offer__address'); address.hidden = !saved; setText(address, email.address);
    setText(row.querySelector('label'), v.label);
    const button = row.querySelector('.email-offer__send');
    button.dataset.send = v.send; button.dataset.resend = v.resend;
    setText(button.querySelector('span'), saved ? v.resend : v.send); button.disabled = confirmed; button.setAttribute('aria-disabled', String(Boolean(this.saving || confirmed)));
    setText(row.querySelector('.email-offer__message'), confirmed ? v.unlocked : this.message || (this.step === 'sent' ? v.sent : ''));
    const dismiss = row.querySelector('.email-offer__dismiss'); dismiss.setAttribute('aria-label', v.close); dismiss.disabled = this.busy || this.saving;
    email.paintNotice(row.querySelector('.m-notice'));
  }
  async save() {
    if (!this.alive || this.saving || !this.email.canCollect || this.email.identity?.status === 'verified') return;
    const address = this.email.address || this.row?.querySelector('input').value.trim();
    if (!address || address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      this.invalid = true; this.message = this.copy.hostSurface.verify.invalid; this.paint(); return;
    }
    const resending = Boolean(this.email.address);
    this.invalid = false; this.saving = true; this.message = resending ? this.copy.hostSurface.verify.sending : this.copy.hostSurface.email.saving; this.paint();
    let response;
    try { response = this.email.address ? await this.verification.resend() : await this.verification.saveAndConfirm(address); }
    catch { response = { ok: false }; }
    if (!this.alive) return;
    this.saving = false;
    if (response?.ok && response.sent) { this.step = 'sent'; this.message = ''; this.row.querySelector('input').value = ''; }
    else if (response?.ok) this.message = this.copy.hostSurface.verify.deliveryFailed;
    else if (!resending) {
      this.invalid = response?.status === 400;
      this.message = this.invalid ? this.copy.hostSurface.verify.invalid : this.copy.hostSurface.email.failed;
    } else this.message = response?.status === 429 ? this.copy.hostSurface.verify.rateLimited : this.copy.hostSurface.verify.failed;
    this.paint(); this.changed?.();
  }
  connect() { this.connected = true; this.update(); }
  disconnect() { this.connected = false; }
  destroy() { this.alive = false; this.disconnect(); this.row = null; }
}

export const emailOfferStyles = `
.email-offer { position:relative; align-self:start; list-style:none; min-width:0; width:100%; max-width:38rem; padding:16px; margin:0 0 16px;
  border:1px solid var(--aithema-line); border-radius:12px; background:var(--aithema-surface); color:var(--aithema-ink); font-size:14px; line-height:1.5; }
.email-offer__lead { margin:0 32px 10px 0; min-height:3lh; }
.email-offer form { display:grid; gap:6px; margin:0; }
.email-offer form > * { grid-area:auto; min-width:0; }
.email-offer__row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-height:44px; }
.email-offer .m-in { grid-area:auto; min-width:0; }
.email-offer__address { min-width:0; overflow-wrap:anywhere; }
.email-offer__send { display:inline-grid; place-items:center; min-height:44px; padding:8px 12px; border-radius:8px; background:var(--aithema-accent); color:var(--aithema-on-accent); font:inherit; }
.email-offer__send > span,.email-offer__send::before,.email-offer__send::after { grid-area:1/1; }
.email-offer__send::before { content:attr(data-send); visibility:hidden; pointer-events:none; }
.email-offer__send::after { content:attr(data-resend); visibility:hidden; pointer-events:none; }
.email-offer__dismiss { position:absolute; top:6px; right:6px; width:44px; height:44px; padding:0; font-size:22px; color:var(--aithema-muted); background:none; border:0; }
.email-offer__message { min-height:3lh; margin:0; }
.email-offer .m-notice { min-height:3lh; }
.email-offer [hidden] { display:none; }
`;
