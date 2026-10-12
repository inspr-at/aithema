import { node, setText, reconcile } from './dom.js';
import { icon } from './icons.js';

/** Owner-authenticated recent conversations; menu keys never bind document-wide single keys or browser shortcuts. */
export class ConversationsMenu {
  #root; #copy; #request; #current; #locale; #newLocale; #adopt; #manage; #status; #alive = true; #load = 0; #busy = false;
  #button; #menu; #outside; #connected = false;
  constructor({ root, copy, request, current, locale, newLocale, adopt, manage, status }) {
    this.#root = root; this.#copy = copy; this.#request = request; this.#current = current; this.#locale = locale; this.#newLocale = newLocale;
    this.#adopt = adopt; this.#manage = manage; this.#status = status;
    this.#button = root.querySelector('.conversations-toggle'); this.#menu = root.querySelector('.conversations-menu');
    this.#button.innerHTML = `${icon('conversations')}<span></span>${icon('chevron')}`;
    root.querySelector('.conversations-new').innerHTML = `${icon('plus')}<span></span>`;
    this.setCopy(copy);
    this.#button.addEventListener('click', () => this.#menu.hidden ? this.open() : this.close());
    this.#button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); this.open(event.key === 'ArrowUp' ? -1 : 0); }
    });
    this.#menu.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); return; }
      if (event.key === 'Tab') { this.close(); return; }
      const items = this.#items(), index = items.indexOf(root.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    root.querySelector('.conversations-new').addEventListener('click', () => void this.#choose('/api/library', { locale: this.#newLocale() }, 'new'));
    root.querySelector('.library-open-dialog').addEventListener('click', () => { this.close(); this.#manage(this.#button); });
    this.#outside = event => { if (!event.composedPath().includes(root.querySelector('.conversations-wrap'))) this.close(); };
    this.connect();
    this.#button.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.#menu.hidden) { event.preventDefault(); this.close(true); } });
  }
  setCopy(copy) {
    this.#copy = copy; const c = copy.display;
    setText(this.#button.querySelector('span'), copy.hostSurface.library.open); this.#button.title = copy.hostSurface.library.open;
    this.#menu.setAttribute('aria-label', copy.hostSurface.library.open);
    setText(this.#root.querySelector('.conversations-new span'), c.newConversation);
    setText(this.#root.querySelector('.library-open-dialog'), c.manageConversations);
  }
  #items() { return [...this.#menu.querySelectorAll('[role="menuitem"]')]; }
  open(index = 0) {
    this.#menu.hidden = false; this.#button.setAttribute('aria-expanded', 'true');
    const items = this.#items(); items[index < 0 ? items.length - 1 : index]?.focus();
    void this.#recent();
  }
  close(focus = false) { this.#menu.hidden = true; this.#button.setAttribute('aria-expanded', 'false'); if (focus) this.#button.focus(); }
  connect() {
    if (this.#connected || !this.#alive) return;
    this.#connected = true; this.#root.ownerDocument.addEventListener('click', this.#outside);
  }
  disconnect() {
    this.#connected = false; this.#load++; this.close(); this.#root.ownerDocument.removeEventListener('click', this.#outside);
  }
  destroy() { this.#alive = false; this.disconnect(); }
  async #recent() {
    const load = ++this.#load;
    try {
      const response = await this.#request('/api/library?search=&offset=0&limit=5');
      if (!this.#alive || load !== this.#load || this.#menu.hidden || !response.ok || !Array.isArray(response.body?.items)) return;
      const items = [...response.body.items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
      reconcile(this.#root.querySelector('.conversations-recent'), items.map(item => [item.id, item]), () => {
        const button = node('button', 'conversations-recent-item'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
        button.append(node('span'), node('small'));
        button.addEventListener('click', () => {
          if (button.dataset.key === this.#current()) { this.close(true); return; }
          void this.#choose(`/api/library/${encodeURIComponent(button.dataset.key)}`, undefined, 'open');
        });
        return button;
      }, (button, item) => {
        setText(button.querySelector('span'), item.title?.trim() || this.#copy.hostSurface.library.untitled);
        button.toggleAttribute('data-current', item.id === this.#current());
        const at = Date.parse(item.updatedAt);
        setText(button.querySelector('small'), item.id === this.#current() ? this.#copy.display.currentConversation
          : Number.isFinite(at) ? new Intl.DateTimeFormat(this.#locale(), { day: 'numeric', month: 'short' }).format(at) : '');
      });
    } catch { /* New and Manage remain available when the recent list cannot be read. */ }
  }
  async #choose(path, body, reason) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const response = await this.#request(path, body);
      if (!this.#alive) return;
      if (!response.ok || !response.body?.session) throw new Error('Conversation unavailable');
      this.close(); this.#adopt(response.body.session, reason);
    } catch { if (this.#alive) this.#status(this.#copy.hostSurface.library.actionFailed); }
    finally { this.#busy = false; }
  }
}
