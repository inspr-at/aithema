// Email verification (AIT-104 B2), after START EmailLock.astro, the v2 identify card and
// v2-verification-recovery.ts. The server owns every fact: the component sends an address or
// a resend request and shows the identity view the server acknowledges (also over SSE).
// One form is built twice: inline on the understanding pane while host policy locks the
// assessment, and in a small dialog behind the quiet entry in the host bar otherwise.
import { node, setText, showOne, fill } from './dom.js';

// START EmailLock, without its motion: a closed padlock in the accent colour.
const LOCK = '<svg viewBox="0 0 32 36" width="22" height="25" fill="none" aria-hidden="true"><path d="M9 16V10a7 7 0 0 1 14 0v6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><rect x="4" y="15" width="24" height="18" rx="5" fill="currentColor"/><path d="M16 22v4" stroke="var(--aithema-surface)" stroke-width="2.6" stroke-linecap="round"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
export const POLL_MS = 4000;

export class Verification {
  #copy; #request; #status; #onChange; #focusAfterUnlock; #pollMs; #root; #notice;
  #identity = null; #at = 0; #ui = { editing: false, busy: false, message: '', error: false };
  #forms = []; #entry; #lock; #dialog; #opener = null; #tick = null; #poll = null; #alive = true; #connected = false; #locked = false;
  /** request(path, body?) reaches the session's own host routes and resolves {ok,status,body}; notice() is the AI notice line. */
  constructor({ root, copy, request, status, onChange, focusAfterUnlock, entry, lock, dialog, identity, pollMs = POLL_MS, notice }) {
    this.#root = root; this.#copy = copy; this.#request = request; this.#status = status; this.#onChange = onChange;
    this.#focusAfterUnlock = focusAfterUnlock; this.#pollMs = pollMs; this.#notice = notice;
    this.#entry = entry; this.#lock = lock; this.#dialog = dialog;
    this.#mountEntry(); this.#mountLock(); this.#mountDialog();
    this.set(identity ?? null, { quiet: true });
  }
  get #v() { return this.#copy.hostSurface.verify; }
  /** A host identity port exists for this conversation (erased identities count as none). */
  get enabled() { return Boolean(this.#identity) && !this.#identity.erased; }
  /** Host policy holds the assessment until the address is verified. */
  get locked() { return this.enabled && this.#identity.verificationRequired === true && this.#identity.assessmentUnlocked !== true; }
  get identity() { return this.#identity ? structuredClone(this.#identity) : null; }
  async load() {
    if (this.enabled) return;
    try {
      const response = await this.#request('identity');
      if (this.#alive && response.ok && response.body?.identity) this.set(response.body.identity);
    } catch { /* No identity port: the entry stays away. */ }
  }
  set(identity, { quiet = false } = {}) {
    const before = this.#identity;
    this.#identity = identity && !identity.erased ? structuredClone(identity) : null; this.#at = Date.now();
    // A new verification round or a changed address ends a stale message.
    if (before?.verificationRevision !== this.#identity?.verificationRevision || before?.status !== this.#identity?.status) {
      if (!this.#ui.busy) this.#ui.message = '';
    }
    if (this.#identity?.status === 'verified') this.#ui.editing = false;
    const wasLocked = this.#locked, focusInLock = this.#lock.contains(this.#root.activeElement);
    this.#locked = this.locked;
    this.#paint(); this.#schedule();
    if (wasLocked !== this.#locked && !quiet) {
      this.#onChange?.();
      if (!this.#locked && focusInLock) this.#focusAfterUnlock?.();
    }
  }
  receive(event) {
    if (event.type === 'identity.state') this.set(event.data);
    else if (event.type === 'identity.unlocked') this.#status(event.data?.manualPaused ? this.#v.unlockedPaused : this.#v.unlocked);
    else if (event.type === 'identity.resend-blocked') { this.#ui.message = this.#v.rateLimited; this.#ui.error = true; this.#paint(); }
  }
  connect() { this.#connected = true; this.#schedule(); }
  disconnect() { this.#connected = false; clearTimeout(this.#poll); this.#poll = null; }
  destroy() { this.#alive = false; this.disconnect(); clearInterval(this.#tick); this.#tick = null; if (this.#dialog.open) this.#dialog.close(); }
  openDialog(opener = this.#entry.querySelector('button')) {
    if (!this.enabled) return;
    this.#opener = opener; this.#paint();
    setText(this.#dialog.querySelector('.verify-dialog__notice'), this.#notice?.() ?? '');
    if (!this.#dialog.open) this.#dialog.showModal?.();
    this.#focusForm(this.#forms.find(f => f.root.closest('dialog')));
  }
  // Remaining resend cooldown, counted down from the moment the view arrived.
  #cooldown() { return Math.max(0, Math.ceil(((this.#identity?.resendAfterMs ?? 0) - (Date.now() - this.#at)) / 1000)); }
  #mode() {
    const status = this.#identity?.status;
    if (status === 'verified') return 'verified';
    return status === 'verification-pending' && this.#identity.address && !this.#ui.editing ? 'pending' : 'capture';
  }
  #mountEntry() {
    const button = node('button', 'verify-entry'); button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => this.openDialog(button));
    const done = node('span', 'verify-done'); done.innerHTML = CHECK; done.append(node('span'));
    this.#entry.replaceChildren(button, done);
  }
  #mountLock() {
    const icon = node('span', 'verify-lock__icon'); icon.innerHTML = LOCK;
    const title = node('h3', 'verify-lock__title'); title.id = 'verify-lock-title';
    this.#lock.setAttribute('role', 'region'); this.#lock.setAttribute('aria-labelledby', 'verify-lock-title');
    this.#lock.replaceChildren(icon, title, node('p', 'verify-lock__lead'), this.#form('verify-lock'));
  }
  #mountDialog() {
    const v = this.#v, frame = node('div', 'verify-dialog__frame'), head = node('header', 'verify-dialog__head');
    const title = node('h2', '', v.title); title.id = 'verify-dialog-title';
    const close = node('button', 'verify-dialog-close', v.close); close.type = 'button';
    close.addEventListener('click', () => this.#dialog.close());
    // The modal covers the conversation's AI notice, so the dialog repeats it in view; the sending
    // controls stay described by the original (AIT-119), hence hidden from assistive technology here.
    const notice = node('p', 'verify-dialog__notice'); notice.setAttribute('aria-hidden', 'true');
    head.append(title, close); frame.append(head, notice, this.#form('verify-dialog'));
    this.#dialog.setAttribute('aria-labelledby', 'verify-dialog-title'); this.#dialog.replaceChildren(frame);
    this.#dialog.addEventListener('close', () => { const opener = this.#opener; this.#opener = null; if (opener?.isConnected) opener.focus(); });
  }
  #form(prefix) {
    const v = this.#v, form = node('form', 'verify-form'); form.noValidate = true;
    const field = node('div', 'verify__field');
    const capture = node('div', 'verify__capture'), label = node('label', 'verify__label', v.label), input = node('input', 'verify__input');
    label.htmlFor = input.id = `${prefix}-email`; input.type = 'email'; input.autocomplete = 'email'; input.maxLength = 254; input.spellcheck = false;
    input.placeholder = v.placeholder; input.setAttribute('aria-describedby', `${prefix}-message`);
    capture.append(label, input);
    const pending = node('p', 'verify__pending'), change = node('button', 'verify-change', v.change); change.type = 'button';
    pending.append(node('span', '', v.sentTo), ' ', node('strong', 'verify__address'), ' ', change);
    const done = node('p', 'verify__done'); done.innerHTML = CHECK; done.append(node('span', '', v.confirmed));
    field.append(capture, pending, done);
    const actions = node('div', 'verify__actions'), primary = node('div', 'verify__primary');
    // Verification starts the AI assessment, so the notice describes the sending controls (AIT-119).
    const send = node('button', 'verify-send', v.send); send.type = 'submit'; send.setAttribute('aria-describedby', `${prefix}-message ai-notice`);
    const resend = node('button', 'verify-resend', v.resend); resend.type = 'button'; resend.setAttribute('aria-describedby', `${prefix}-note ai-notice`);
    const cancel = node('button', 'verify-cancel', v.cancel); cancel.type = 'button';
    primary.append(send, resend); actions.append(primary, cancel);
    const message = node('p', 'verify__message'); message.id = `${prefix}-message`; message.setAttribute('role', 'status');
    const note = node('p', 'verify__note'); note.id = `${prefix}-note`;
    form.append(field, actions, message, note);
    form.addEventListener('submit', event => { event.preventDefault(); void this.#send(entry); });
    resend.addEventListener('click', () => void this.#resend(entry));
    change.addEventListener('click', () => { this.#ui = { ...this.#ui, editing: true, message: '' }; input.value = this.#identity?.address ?? ''; this.#paint(); input.focus(); input.select?.(); });
    cancel.addEventListener('click', () => { this.#ui = { ...this.#ui, editing: false, message: '' }; this.#paint(); change.focus(); });
    const entry = { root: form, input, send, resend, cancel, change, capture, pending, done, message, note };
    this.#forms.push(entry);
    return form;
  }
  #focusForm(entry) {
    if (!entry) return;
    const mode = this.#mode();
    (mode === 'capture' ? entry.input : mode === 'pending' ? entry.resend : entry.root.closest('dialog')?.querySelector('.verify-dialog-close'))?.focus();
  }
  async #send(entry) {
    const v = this.#v, address = entry.input.value.trim();
    if (this.#ui.busy) return;
    if (!address || !entry.input.checkValidity?.() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      this.#ui = { ...this.#ui, message: v.invalid, error: true }; this.#paint(); entry.input.focus(); return;
    }
    const command = this.#identity?.status === 'guest' || !this.#identity?.address ? 'request' : 'change';
    await this.#post(`identity/${command}`, { address }, () => { this.#ui.editing = false; entry.input.value = ''; });
    if (this.#alive) this.#focusForm(entry);
  }
  async #resend(entry) {
    if (this.#ui.busy) return;
    if (this.#cooldown() > 0) { this.#ui = { ...this.#ui, message: this.#v.rateLimited, error: true }; this.#paint(); return; }
    await this.#post('identity/resend', {});
    if (this.#alive && entry.root.isConnected && this.#mode() === 'pending') entry.resend.focus();
  }
  async #post(path, body, accepted = () => {}) {
    const v = this.#v;
    this.#ui = { ...this.#ui, busy: true, message: v.sending, error: false }; this.#paint();
    let response;
    try { response = await this.#request(path, body); } catch { response = null; }
    if (!this.#alive) return;
    this.#ui.busy = false;
    if (response?.body?.identity) { if (response.ok || response.status === 429) accepted(); this.set(response.body.identity); }
    this.#ui.error = !response?.ok;
    this.#ui.message = response?.ok ? '' : response?.status === 429 ? v.rateLimited : response?.status === 400 ? v.invalid : v.failed;
    this.#paint();
  }
  #stateText() {
    const v = this.#v, identity = this.#identity, mode = this.#mode();
    if (this.#ui.message) return this.#ui.message;
    if (mode === 'verified') return '';
    if (mode !== 'pending') return '';
    if (identity.expired) return v.expired;
    if (identity.delivery === 'failed') return v.deliveryFailed;
    if (identity.confirmationAttemptsRemaining === 0) return v.attemptsUsed;
    return identity.delivery === 'requested' ? v.sending : this.locked ? v.saved : v.sent;
  }
  #paint() {
    const v = this.#v, identity = this.#identity, mode = this.#mode(), cooldown = this.#cooldown();
    // Bar entry: a quiet action until verified, then a plain line with a check.
    const [button, done] = this.#entry.children;
    button.hidden = !identity || mode === 'verified'; done.hidden = !identity || mode !== 'verified';
    setText(button, identity?.status === 'verification-pending' ? v.pending : v.entry); setText(done.lastChild, v.verified);
    // Lock pane: shown exactly while host policy holds the assessment.
    this.#lock.hidden = !this.locked;
    setText(this.#lock.querySelector('.verify-lock__title'), v.lockTitle);
    setText(this.#lock.querySelector('.verify-lock__lead'), v.lockLead);
    const text = this.#stateText(), note = mode === 'pending' && cooldown > 0 ? fill(v.cooldown, { seconds: cooldown }) : mode === 'verified' ? '' : v.hint;
    for (const form of this.#forms) {
      form.root.dataset.mode = mode;
      const shown = { capture: form.capture, pending: form.pending, verified: form.done }[mode];
      showOne(shown, ...[form.capture, form.pending, form.done].filter(n => n !== shown));
      setText(form.root.querySelector('.verify__address'), identity?.address ?? '');
      if (mode === 'pending') showOne(form.resend, form.send); else showOne(form.send, form.resend);
      form.root.querySelector('.verify__actions').style.visibility = mode === 'verified' ? 'hidden' : '';
      form.root.querySelector('.verify__actions').toggleAttribute('inert', mode === 'verified');
      form.cancel.style.visibility = this.#ui.editing && mode === 'capture' ? '' : 'hidden';
      form.cancel.toggleAttribute('inert', !(this.#ui.editing && mode === 'capture'));
      // Busy and cooling down stay focusable (aria-disabled): a disabled button would drop focus.
      form.send.setAttribute('aria-disabled', String(this.#ui.busy));
      form.resend.setAttribute('aria-disabled', String(this.#ui.busy || cooldown > 0));
      setText(form.message, text); form.message.dataset.error = String(Boolean(this.#ui.error && this.#ui.message));
      setText(form.note, note);
    }
  }
  // The cooldown counts down each second; polling asks the host whether the link was confirmed.
  #schedule() {
    const counting = this.#mode() === 'pending' && this.#cooldown() > 0;
    if (counting && !this.#tick) this.#tick = setInterval(() => { if (!this.#alive) return; this.#paint(); if (this.#cooldown() === 0) { clearInterval(this.#tick); this.#tick = null; } }, 1000);
    if (!counting && this.#tick) { clearInterval(this.#tick); this.#tick = null; }
    clearTimeout(this.#poll); this.#poll = null;
    if (!this.#alive || !this.#connected || !this.#identity?.pollVerification) return;
    this.#poll = setTimeout(async () => {
      this.#poll = null;
      if (globalThis.document?.visibilityState !== 'hidden') {
        try {
          const response = await this.#request('identity/unlock', {});
          if (this.#alive && response.ok && response.body?.identity) { this.set(response.body.identity); return; }
        } catch { /* Polling resumes on the next round. */ }
      }
      if (this.#alive) this.#schedule();
    }, this.#pollMs);
  }
}
