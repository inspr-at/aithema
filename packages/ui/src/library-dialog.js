// The owner's conversation library (AIT-104 B2), after START's conversation manager
// (src/lib/auth/conversations.ts and the v2 "Manage conversations" view). The host's library
// port owns listing, search and paging; the dialog shows what the server returns, sorts the
// loaded rows by title or last activity, and opens, renames, deletes, creates and resets.
// Rows are keyed: nothing moves under the pointer, and a confirmation never pushes the list.
// The shown order is fixed when the list is loaded, searched or sorted: a rename (which makes its
// conversation the latest) or a background reload never moves rows; new rows join at the end.
import { node, setText, reconcile, showOne, fill } from './dom.js';

const PAGE = 100;
const escape = id => globalThis.CSS?.escape?.(id) ?? id.replace(/["\\]/gu, '\\$&');
const time = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : 0; };

export class LibraryDialog {
  #dialog; #copy; #request; #current; #locale; #adopt; #notice; #alive = true; #opener = null;
  #items = []; #order = []; #total = 0; #query = ''; #load = 0; #state = 'idle'; #message = '';
  #sort = { key: 'updatedAt', direction: 'descending' }; #renaming = null; #confirm = null; #busy = false; #searchTimer = null;
  /** request(path, body?) reaches /api/library{path}; adopt(session, reason) opens a conversation. */
  constructor({ dialog, copy, request, current, locale, adopt, notice }) {
    this.#dialog = dialog; this.#copy = copy; this.#request = request; this.#current = current; this.#locale = locale;
    this.#adopt = adopt; this.#notice = notice;
    this.#mount();
  }
  get #c() { return this.#copy.hostSurface.library; }
  get open() { return this.#dialog.open; }
  destroy() { this.#alive = false; clearTimeout(this.#searchTimer); if (this.#dialog.open) this.#dialog.close(); }
  show(opener) {
    this.#opener = opener ?? null; this.#renaming = null; this.#confirm = null; this.#message = '';
    setText(this.#dialog.querySelector('.library__notice'), this.#notice?.() ?? '');
    if (!this.#dialog.open) this.#dialog.showModal?.();
    this.#paint(); void this.refresh();
    this.#dialog.querySelector('.library__search input').focus();
  }
  /** A library.state or erasure event: reload the open list so names stay current, rows in place. */
  changed() { if (this.#dialog.open && !this.#renaming) void this.refresh({ keep: true }); }
  /** A load sorts the list afresh; `more` appends a page and `keep` holds the shown order. */
  async refresh({ more = false, keep = false } = {}) {
    const load = ++this.#load, offset = more ? this.#items.length : 0;
    if (!more) { this.#state = this.#items.length ? this.#state : 'loading'; this.#paint(); }
    try {
      const params = new URLSearchParams({ search: this.#query, offset: String(offset), limit: String(PAGE) });
      const response = await this.#request(`?${params}`);
      if (!this.#alive || load !== this.#load) return;
      if (!response.ok || !Array.isArray(response.body?.items)) throw new Error('Library unavailable');
      const seen = new Set(more ? this.#items.map(item => item.id) : []);
      this.#items = [...more ? this.#items : [], ...response.body.items.filter(item => !seen.has(item.id))];
      this.#total = Number.isSafeInteger(response.body.total) ? response.body.total : this.#items.length;
      if (!more && !keep) this.#order = [];
      this.#state = 'ready';
    } catch {
      if (!this.#alive || load !== this.#load) return;
      this.#state = 'failed';
    }
    this.#paint();
  }
  #mount() {
    const c = this.#c, d = this.#dialog;
    // Static trusted markup only; titles and messages are assigned as text.
    d.innerHTML = `<div class="library__frame"><header class="library__head"><div class="library__heading"><h2 id="library-title"></h2>
        <button class="library-close" type="button"></button></div><p class="library__lead"></p><p class="library__notice" aria-hidden="true"></p>
        <div class="library__search"><label class="visually-hidden" for="library-search"></label><input id="library-search" type="search" maxlength="200" autocomplete="off"></div>
        <p class="library__message" role="status"></p></header>
      <div class="library__list"><table><thead><tr><th class="library__col-title" aria-sort="none"><button class="library-sort" type="button" data-sort="title"><span></span><span class="library__arrow" aria-hidden="true"></span></button></th>
        <th class="library__col-when" aria-sort="descending"><button class="library-sort" type="button" data-sort="updatedAt"><span></span><span class="library__arrow" aria-hidden="true"></span></button></th>
        <th class="library__col-actions"><span class="visually-hidden"></span></th></tr></thead><tbody></tbody></table>
        <div class="library__state"><p></p><button class="library-retry" type="button"></button></div>
        <div class="library__more"><span></span><button class="library-more" type="button"></button></div></div>
      <footer class="library__foot"><div class="library__default"><button class="library-new" type="button" aria-describedby="ai-notice"></button>
          <button class="library-reset" type="button" aria-describedby="ai-notice"></button></div>
        <div class="library__confirm" role="group" aria-labelledby="library-confirm-question"><p id="library-confirm-question" class="library__question"></p>
          <p class="library__warning"></p><div class="library__confirm-actions">
          <button class="library-confirm" type="button" aria-describedby="library-confirm-warning"></button><button class="library-confirm-cancel" type="button"></button></div></div></footer></div>`;
    d.setAttribute('aria-labelledby', 'library-title');
    const text = (selector, value) => setText(d.querySelector(selector), value);
    text('#library-title', c.title); text('.library-close', c.close); text('.library__lead', c.lead);
    text('.library__search label', c.search); d.querySelector('#library-search').placeholder = c.search;
    text('[data-sort="title"] span', c.columns.title); text('[data-sort="updatedAt"] span', c.columns.updated);
    text('.library__col-actions span', c.columns.actions); text('.library-retry', c.retry); text('.library-more', c.more);
    text('.library-new', c.new); text('.library-reset', c.reset); text('.library-confirm-cancel', c.cancel);
    // The warning keeps the height of the longer one in this language, whichever is shown (or none).
    const warning = d.querySelector('.library__warning');
    const shown = node('span'); shown.id = 'library-confirm-warning';
    warning.append(shown, ...[c.deleteWarning, c.resetWarning].map(value => { const sizer = node('span', 'library__sizer', value); sizer.setAttribute('aria-hidden', 'true'); return sizer; }));
    d.querySelector('.library-close').addEventListener('click', () => d.close());
    d.querySelector('.library-retry').addEventListener('click', () => void this.refresh());
    d.querySelector('.library-more').addEventListener('click', () => void this.refresh({ more: true }));
    d.querySelector('#library-search').addEventListener('input', event => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => { this.#query = event.target.value.trim(); void this.refresh(); }, 250);
    });
    for (const button of d.querySelectorAll('.library-sort')) button.addEventListener('click', () => {
      const key = button.dataset.sort;
      this.#sort = { key, direction: this.#sort.key === key ? this.#sort.direction === 'ascending' ? 'descending' : 'ascending'
        : key === 'title' ? 'ascending' : 'descending' };
      this.#order = []; this.#paint();
    });
    d.querySelector('.library-new').addEventListener('click', () => void this.#create());
    d.querySelector('.library-reset').addEventListener('click', () => this.#ask({ kind: 'reset', id: this.#current() }));
    d.querySelector('.library-confirm').addEventListener('click', () => void this.#confirmed());
    d.querySelector('.library-confirm-cancel').addEventListener('click', () => this.#cancelConfirm());
    // Escape first ends a rename or a confirmation, and only then closes the dialog.
    d.addEventListener('cancel', event => {
      if (this.#renaming) { event.preventDefault(); this.#stopRename(true); }
      else if (this.#confirm) { event.preventDefault(); this.#cancelConfirm(); }
    });
    d.addEventListener('close', () => {
      this.#renaming = null; this.#confirm = null; this.#paint();
      const opener = this.#opener; this.#opener = null; if (opener?.isConnected) opener.focus();
    });
  }
  #title(item) { return item.title?.trim() || this.#c.untitled; }
  #sorted() {
    const { key, direction } = this.#sort, sign = direction === 'ascending' ? 1 : -1;
    const collator = new Intl.Collator(this.#locale(), { sensitivity: 'base', numeric: true });
    return [...this.#items].sort((a, b) => sign * (key === 'title' ? collator.compare(this.#title(a), this.#title(b)) : time(a.updatedAt) - time(b.updatedAt))
      || a.id.localeCompare(b.id));
  }
  // The shown order: rows keep their place; rows not yet placed follow in sort order.
  #shown() {
    const byId = new Map(this.#items.map(item => [item.id, item])), placed = new Set(this.#order);
    const rows = [...this.#order.filter(id => byId.has(id)).map(id => byId.get(id)), ...this.#sorted().filter(item => !placed.has(item.id))];
    this.#order = rows.map(item => item.id);
    return rows;
  }
  #row() {
    const c = this.#c, row = node('tr');
    const title = node('td', 'library__title-cell'), slot = node('div', 'library__title-slot');
    const open = node('button', 'library-open'); open.type = 'button'; open.setAttribute('aria-describedby', 'ai-notice');
    open.append(node('span', 'library__name'), node('small', 'library__current'));
    const rename = node('span', 'library__rename'), label = node('label', 'visually-hidden', c.renameLabel), input = node('input');
    input.maxLength = 200; input.autocomplete = 'off'; rename.append(label, input);
    slot.append(open, rename); title.append(slot);
    const when = node('td', 'library__when'); when.append(node('time'));
    const actions = node('td', 'library__actions'), stack = node('div', 'library__action-slot');
    const normal = node('span', 'library__row-actions'), editing = node('span', 'library__rename-actions');
    const button = (className, text, handler) => { const b = node('button', className, text); b.type = 'button'; b.addEventListener('click', handler); return b; };
    normal.append(button('library-rename', c.rename, () => this.#startRename(row.dataset.key)), button('library-delete', c.delete, () => this.#ask({ kind: 'delete', id: row.dataset.key })));
    editing.append(button('library-save', c.save, () => void this.#saveRename(row.dataset.key)), button('library-cancel', c.cancel, () => this.#stopRename(true)));
    stack.append(normal, editing); actions.append(stack);
    row.append(title, when, actions);
    open.addEventListener('click', () => void this.#openConversation(row.dataset.key));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void this.#saveRename(row.dataset.key); }
    });
    return row;
  }
  #paintRow(row, item) {
    const c = this.#c, current = item.id === this.#current(), renaming = this.#renaming === item.id;
    const name = this.#title(item), open = row.querySelector('.library-open'), input = row.querySelector('.library__rename input');
    input.id = `library-rename-${item.id}`; row.querySelector('.library__rename label').htmlFor = input.id;
    setText(row.querySelector('.library__name'), name); setText(row.querySelector('.library__current'), current ? c.current : '');
    row.dataset.current = String(current); row.dataset.untitled = String(!item.title?.trim());
    const at = time(item.updatedAt), stamp = row.querySelector('time');
    stamp.dateTime = at ? new Date(at).toISOString() : '';
    setText(stamp, at ? new Intl.DateTimeFormat(this.#locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at) : '');
    const [normal, editing] = row.querySelector('.library__action-slot').children;
    if (renaming) { showOne(row.querySelector('.library__rename'), open); showOne(editing, normal); }
    else { showOne(open, row.querySelector('.library__rename')); showOne(normal, editing); }
    for (const b of row.querySelectorAll('.library__row-actions button, .library-open')) b.setAttribute('aria-disabled', String(this.#busy));
  }
  #paint() {
    const d = this.#dialog, c = this.#c;
    for (const th of d.querySelectorAll('th[aria-sort]')) {
      const key = th.querySelector('.library-sort').dataset.sort, sorted = this.#sort.key === key;
      th.setAttribute('aria-sort', sorted ? this.#sort.direction : 'none');
      setText(th.querySelector('.library__arrow'), sorted ? this.#sort.direction === 'ascending' ? '↑' : '↓' : '');
    }
    const items = this.#state === 'failed' ? [] : this.#shown();
    reconcile(d.querySelector('tbody'), items.map(item => [item.id, item]), () => this.#row(), (row, item) => this.#paintRow(row, item));
    const empty = this.#state === 'loading' && !items.length ? c.loading : this.#state === 'failed' ? c.failed
      : this.#state === 'ready' && !items.length ? this.#query ? c.noResults : c.none : '';
    const state = d.querySelector('.library__state'); state.hidden = !empty;
    setText(state.querySelector('p'), empty); state.querySelector('button').hidden = this.#state !== 'failed';
    const more = d.querySelector('.library__more'); more.hidden = !(this.#state === 'ready' && this.#total > this.#items.length);
    setText(more.querySelector('span'), fill(c.count, { shown: this.#items.length, total: this.#total }));
    setText(d.querySelector('.library__message'), this.#message);
    // The footer keeps one height: the default actions and a confirmation share its cell.
    const [normal, confirm] = d.querySelector('.library__foot').children;
    if (this.#confirm) {
      const item = this.#items.find(entry => entry.id === this.#confirm.id), reset = this.#confirm.kind === 'reset';
      setText(confirm.querySelector('.library__question'), reset ? c.resetQuestion : fill(c.deleteQuestion, { title: item ? this.#title(item) : c.untitled }));
      setText(confirm.querySelector('.library__warning > span'), reset ? c.resetWarning : c.deleteWarning);
      setText(confirm.querySelector('.library-confirm'), reset ? c.resetConfirm : c.deleteConfirm);
      // Resetting, or deleting the open conversation, begins a new one: the AI notice describes it (AIT-119).
      const begins = reset || this.#confirm.id === this.#current();
      confirm.querySelector('.library-confirm').setAttribute('aria-describedby', begins ? 'library-confirm-warning ai-notice' : 'library-confirm-warning');
      showOne(confirm, normal);
    } else showOne(normal, confirm);
    for (const b of d.querySelectorAll('.library__foot button')) b.setAttribute('aria-disabled', String(this.#busy));
  }
  #say(message) { this.#message = message; setText(this.#dialog.querySelector('.library__message'), message); }
  #focusRow(id, selector) { this.#dialog.querySelector(`tbody tr[data-key="${escape(id)}"] ${selector}`)?.focus(); }
  #startRename(id) {
    if (this.#busy) return;
    const item = this.#items.find(entry => entry.id === id); if (!item) return;
    this.#confirm = null; this.#renaming = id; this.#message = '';
    // The row keeps its height while its name is edited.
    const row = this.#dialog.querySelector(`tbody tr[data-key="${escape(id)}"]`);
    row.style.minHeight = ''; row.style.height = `${row.getBoundingClientRect().height}px`;
    this.#paint();
    const input = row.querySelector('.library__rename input'); input.value = item.title ?? ''; input.focus(); input.select?.();
  }
  #stopRename(focus) {
    const id = this.#renaming; this.#renaming = null;
    const row = id && this.#dialog.querySelector(`tbody tr[data-key="${escape(id)}"]`);
    if (row) row.style.height = '';
    this.#paint();
    if (focus && id) this.#focusRow(id, '.library-rename');
  }
  async #saveRename(id) {
    if (this.#busy) return;
    const row = this.#dialog.querySelector(`tbody tr[data-key="${escape(id)}"]`), title = row?.querySelector('.library__rename input').value ?? '';
    this.#busy = true; this.#paint();
    const result = await this.#call(`/${encodeURIComponent(id)}/rename`, { title: title.trim() });
    if (!this.#alive) return;
    this.#busy = false;
    if (result?.id === id) { this.#items = this.#items.map(item => item.id === id ? { ...item, ...result } : item); this.#message = this.#c.renamed; this.#stopRename(true); }
    else { this.#message = this.#c.actionFailed; this.#paint(); row?.querySelector('.library__rename input').focus(); }
  }
  #ask(confirm) {
    if (this.#busy || !confirm.id) return;
    if (this.#renaming) this.#stopRename(false);
    this.#confirm = { ...confirm, from: this.#dialog.getRootNode().activeElement ?? null }; this.#message = '';
    this.#paint();
    this.#dialog.querySelector('.library-confirm-cancel').focus();
  }
  #cancelConfirm() {
    const from = this.#confirm?.from; this.#confirm = null; this.#paint();
    if (from?.isConnected) from.focus(); else this.#dialog.querySelector('#library-search').focus();
  }
  async #confirmed() {
    if (this.#busy || !this.#confirm) return;
    const { kind, id } = this.#confirm, current = id === this.#current();
    this.#busy = true; this.#paint();
    const result = await this.#call(`/${encodeURIComponent(id)}/${kind}`, {});
    if (!this.#alive) return;
    this.#busy = false;
    if (!result) { this.#message = this.#c.actionFailed; this.#paint(); this.#dialog.querySelector('.library-confirm').focus(); return; }
    this.#confirm = null;
    if (kind === 'reset') { this.#finish(result.session, 'reset'); return; }
    const index = this.#shown().findIndex(item => item.id === id);
    this.#items = this.#items.filter(item => item.id !== id); this.#total = Math.max(0, this.#total - 1);
    this.#message = this.#c.deleted; this.#paint();
    // The open conversation is gone for good: a new empty one takes its place.
    if (current) { await this.#create('deleted'); return; }
    const next = this.#shown()[Math.min(index, this.#items.length - 1)];
    if (next) this.#focusRow(next.id, '.library-open'); else this.#dialog.querySelector('.library-new').focus();
  }
  async #create(reason = 'new') {
    if (this.#busy) return;
    this.#busy = true; this.#say(this.#c.opening); this.#paint();
    const result = await this.#call('', { locale: this.#locale() });
    if (!this.#alive) return;
    this.#busy = false;
    if (result?.session) this.#finish(result.session, reason);
    else { this.#message = this.#c.actionFailed; this.#paint(); }
  }
  async #openConversation(id) {
    if (this.#busy) return;
    if (id === this.#current()) { this.#dialog.close(); return; }
    this.#busy = true; this.#say(this.#c.opening); this.#paint();
    const result = await this.#call(`/${encodeURIComponent(id)}`);
    if (!this.#alive) return;
    this.#busy = false;
    if (result?.session) this.#finish(result.session, 'open');
    else { this.#message = this.#c.actionFailed; this.#paint(); void this.refresh({ keep: true }); }
  }
  #finish(session, reason) {
    this.#opener = null; this.#dialog.close(); this.#adopt(session, reason);
  }
  async #call(path, body) {
    try {
      const response = await this.#request(path, body);
      return response.ok ? response.body ?? {} : null;
    } catch { return null; }
  }
}
