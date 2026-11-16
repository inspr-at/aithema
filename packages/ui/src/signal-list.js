import { node, reconcile, setText } from './dom.js';
import { resolveCopy } from './copy-resolve.js';
import { signalKey } from '../../core/src/understanding.js';

/** Presentation state is tab-local; identity and order come from the server. */
export class SignalList {
  #available = true; #section; #list; #button; #anchor; #copy; #locale; #items = []; #pending = null;
  #pointer = false; #sectionPointer = false; #timer; #marked = new Set(); #seenSeq = null;
  constructor(section, { state, anchor }) {
    this.state = state ?? { expanded: false, seen: new Set(), initialized: false };
    this.#section = section; this.#list = section.querySelector('.signals');
    this.#button = section.querySelector('.signals-toggle'); this.#anchor = anchor;
    this.#list.addEventListener('pointerenter', () => { this.#pointer = true; });
    this.#list.addEventListener('pointerleave', () => { this.#pointer = false; this.#flush(); });
    section.addEventListener('pointerenter', () => { this.#sectionPointer = true; });
    section.addEventListener('pointerleave', () => { this.#sectionPointer = false; this.#flush(); });
    section.addEventListener('focusout', event => {
      if (!section.contains(event.relatedTarget)) this.#flush(event.relatedTarget);
    });
    this.#button.addEventListener('click', () => this.#anchor(() => {
      this.state.expanded = !this.state.expanded;
      // An explicit expansion/collapse may apply the pending content in this
      // same input frame; asynchronous arrivals never move the focused action.
      if (this.#pending) this.#apply(this.#pending);
      else this.#paint();
    }));
  }
  #busy(nextFocus = this.#section.getRootNode().activeElement) {
    return this.#pointer || this.#sectionPointer || Boolean(nextFocus && this.#section.contains(nextFocus));
  }
  #flush(nextFocus) {
    if (this.#pending && !this.#busy(nextFocus)) this.#anchor(() => this.#apply(this.#pending));
  }
  update(session, copy, { live = false, available = true } = {}) {
    this.#available = available;
    this.#copy = copy; this.#locale = session.locale;
    const u = session.understanding, byText = new Map((u.signalItems ?? []).map(i => [signalKey(i.text), i]));
    const items = u.signals.map(text => ({ key: signalKey(text), text, ...byText.get(signalKey(text)) }));
    const ledgerKeys = new Set((session.signalLedger ?? items).map(i => i.key));
    // Only source/consent removal can shrink a modern ledger. Forget sensitive
    // keys along with their rendered rows, even while pointer/focus is held.
    const pruned = session.signalLedger && [...this.state.seen].some(key => !ledgerKeys.has(key));
    if (pruned) this.state.seen = new Set([...this.state.seen].filter(key => ledgerKeys.has(key)));
    const added = items.filter(i => !this.state.seen.has(i.key));
    const fresh = live && this.#seenSeq !== session.seq && !u.draft && this.state.initialized && added.length <= 3
      ? added.map(i => i.key) : [];
    this.#seenSeq = session.seq;
    for (const key of ledgerKeys) this.state.seen.add(key);
    for (const item of items) this.state.seen.add(item.key);
    if (items.length) this.state.initialized = true;
    if (session.tombstone || session.consentWithdrawn) { this.clear(); return; }
    // Source/reset assessments must redact immediately; empty finals may defer. They do not reset the
    // conversation's seen identities or its expanded preference.
    if (!u.readinessAssessed || pruned) { this.#pending = null; this.#clearMark(); this.#items = items; this.#paint(); return; }
    const changed = JSON.stringify(items) !== JSON.stringify(this.#items);
    if (changed && this.#busy()) {
      const pendingMarks = this.#pending?.fresh ?? [];
      this.#pending = { items, fresh: [...new Set([...pendingMarks, ...fresh])].filter(key => items.some(i => i.key === key)) };
      this.#paint(); return;
    }
    if (changed) this.#apply({ items, fresh }); else this.#paint();
  }
  #apply({ items, fresh }) {
    this.#pending = null; this.#items = items;
    if (fresh.length > 3) { this.#clearMark(); fresh = []; }
    if (fresh.length) {
      this.#clearMark(); this.#marked = new Set(fresh);
      this.#timer = setTimeout(() => { this.#timer = null; this.#marked.clear(); this.#paint(); }, 2000);
    }
    this.#paint();
  }
  #paint() {
    this.#section.hidden = !this.#available || !this.#items.length;
    const items = this.state.expanded ? this.#items : this.#items.slice(0, 5);
    reconcile(this.#list, items.map(i => [i.key, i]), () => {
      const row = node('li'); row.append(node('span', 'signal-text')); return row;
    }, (row, item) => {
      setText(row.querySelector('.signal-text'), item.text);
      let provenance = row.querySelector('.signal-provenance');
      if (item.basis === 'assistant') {
        if (!provenance) { provenance = node('span', 'signal-provenance'); provenance.append(' ', node('span', 'signal-basis')); row.append(provenance); }
        setText(provenance.querySelector('.signal-basis'), resolveCopy(this.#copy, 'signalUnconfirmed', null, this.#locale));
      } else provenance?.remove();
      row.toggleAttribute('data-signal-new', this.#marked.has(item.key));
    });
    this.#button.hidden = this.#items.length <= 5;
    this.#button.setAttribute('aria-expanded', String(this.state.expanded));
    setText(this.#button, this.state.expanded ? resolveCopy(this.#copy, 'showLess', null, this.#locale)
      : resolveCopy(this.#copy, 'signalsAll', null, this.#locale).replaceAll('{n}', String(this.#items.length)));
  }
  #clearMark() { clearTimeout(this.#timer); this.#timer = null; this.#marked.clear(); }
  clear() {
    this.#clearMark(); this.#items = []; this.#pending = null;
    this.state.expanded = false; this.state.seen.clear(); this.state.initialized = false;
    this.#paint();
  }
  quiet() { this.#clearMark(); if (this.#pending) this.#pending.fresh = []; this.#paint(); }
  suspend() { this.#clearMark(); this.#pending = null; this.#pointer = false; this.#sectionPointer = false; this.#paint(); }
  destroy() { this.#clearMark(); this.#pending = null; this.#items = []; }
}
