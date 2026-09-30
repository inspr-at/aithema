import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindTextUi, POLL_MS, POLL_LIMIT, REFRESH_REGIONS } from '../workspace/text-ui-client.js';
import { parseHtml } from './workspace-dom.test.js';

// Only the DOM operations used by this client. Detaching a focused subtree
// resets activeElement to body, as in a browser, so focus regressions are real
// failures here rather than no-op replaceWith/focus stubs.
class Element {
  constructor(node, doc) {
    this.doc = doc;
    this.tag = node.tag;
    this.attrs = { ...node.attrs };
    this.text = node.text;
    this.children = (node.children ?? []).map((child) => new Element(child, doc));
    for (const child of this.children) child.parent = this;
    this.value = this.attrs.value ?? (this.tag === 'textarea' ? this.textContent : '');
    this.scrollHeight = 100;
    this.scrollTop = 0;
  }
  get id() { return this.attrs.id; }
  set id(value) { this.attrs.id = value; }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = value; }
  get innerHTML() { return this.html ?? this.textContent; }
  set innerHTML(value) { this.html = value; }
  get elements() { return { message: this.querySelector('[name="message"]') }; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    assert.ok(attr, `unsupported selector ${selector}`);
    return Object.hasOwn(this.attrs, attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
  }
  querySelectorAll(selector) {
    const space = selector.indexOf(' ');
    if (space !== -1) return this.querySelector(selector.slice(0, space))?.querySelectorAll(selector.slice(space + 1)) ?? [];
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.doc.activeElement = this; }
  append(node) { node.parent = this; this.children.push(node); }
  remove() {
    if (!this.parent) return;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node) {
    const parent = this.parent;
    const at = parent.children.indexOf(this);
    this.remove();
    node.parent = parent;
    parent.children.splice(at, 0, node);
  }
  after(node) {
    node.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node);
  }
  snapshot() { return { tag: this.tag, attrs: this.attrs, text: this.text, children: this.children.map((child) => child.snapshot()) }; }
}

class Document {
  constructor(html) {
    this.root = new Element(parseHtml(html), this);
    this.body = this.root.querySelector('#body');
    this.activeElement = this.body;
    this.listeners = new Map();
  }
  getElementById(id) { return this.root.querySelector(`#${id}`); }
  querySelectorAll(selector) { return this.root.querySelectorAll(selector); }
  createElement(tag) { return new Element({ tag, attrs: {}, children: [] }, this); }
  importNode(node) { return new Element(node.snapshot(), this); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  async submit(form) {
    let prevented = false;
    await this.listeners.get('submit')?.({ target: form, preventDefault() { prevented = true; } });
    return prevented;
  }
}

function page({ seqs = [], pending = true, label = 'old', confirmed = false, question = false } = {}) {
  return `<body id="body">
    <div id="text-status"><p id="text-durability" data-durability="${pending ? 'pending' : 'durable'}">${label}</p><div id="text-live"></div></div>
    <div id="text-transcript">${seqs.length ? seqs.map((seq) => `<article data-seq="${seq}">Reply ${seq}${question ? '<p data-canonical-question="true">Canonical question: Who may export?</p>' : ''}</article>`).join('') : '<p data-empty>No messages.</p>'}</div>
    <div id="text-current-question"><a id="question-link" href="#question">${label}</a></div>
    <form id="text-turn-form" action="/projects/p1/text/turns" data-text-turn-form><textarea name="message" id="text-turn-input">Draft input</textarea></form>
    <section id="text-confirmation"><h2 id="text-confirmation-h">${label}</h2>${confirmed ? '' : '<form id="confirm-form" action="/projects/p1/text/confirm" data-text-confirm-form><input name="binding" value="REQ-1@1@digest"><button id="confirm-button">Confirm item</button></form>'}</section>
    <section id="text-review"><a id="review-link" href="#item">${label}</a></section>
  </body>`;
}

const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

function harness(t, { response = { message: 'Message saved.' }, ok = true, initial = {}, snapshots = [{}], postError = false, refreshError = false } = {}) {
  const doc = new Document(page(initial));
  const timers = [];
  const requests = [];
  let index = 0;
  const win = {
    location: { pathname: '/projects/p1', search: '?notice=old', hash: '#item' }, URLSearchParams,
    FormData: class {
      constructor(form) { this.rows = form.querySelectorAll('[name]').map((node) => [node.getAttribute('name'), node.value]); }
      [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
    },
    DOMParser: class { parseFromString(html) { return new Document(html); } },
    setTimeout(callback, ms) { timers.push({ callback, ms }); },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      if (postError) throw new Error('offline');
      return { ok, json: async () => response };
    }
    if (refreshError) return { ok: false };
    return { ok: true, text: async () => page(snapshots[Math.min(index++, snapshots.length - 1)]) };
  };
  const ui = bindTextUi(doc, win, fetchImpl);
  t.after(() => ui.destroy());
  return { doc, timers, requests, ui, async tick(ms) {
    const at = timers.findIndex((timer) => timer.ms === ms);
    assert.ok(at >= 0, `expected timer ${ms}`);
    timers.splice(at, 1)[0].callback();
    await flush();
  } };
}

describe('text UI client with an executable DOM stub', () => {
  it('posts the message, refreshes in order without duplicate transcript entries, announces, and focuses the composer', async (t) => {
    const h = harness(t, { initial: { seqs: ['1'] }, snapshots: [{ seqs: ['1', '2'], question: true, label: 'new' }, { seqs: ['1', '2'], pending: false, label: 'durable' }] });
    const form = h.doc.getElementById('text-turn-form');
    assert.equal(await h.doc.submit(form), true);
    assert.equal(h.requests[0].url, '/projects/p1/text/turns');
    assert.equal(h.requests[0].options.credentials, 'same-origin');
    assert.equal(h.requests[0].options.headers.accept, 'application/json');
    assert.equal(h.requests[0].options.body.get('message'), 'Draft input');
    assert.equal(h.requests[1].url, '/projects/p1');
    assert.equal(h.requests[1].options.credentials, 'same-origin');
    assert.equal(h.doc.getElementById('text-turn-input').value, '');
    assert.equal(h.doc.activeElement.id, 'text-turn-input');
    assert.equal(form.getAttribute('aria-busy'), null);
    assert.deepEqual(h.doc.getElementById('text-transcript').querySelectorAll('[data-seq]').map((n) => n.getAttribute('data-seq')), ['1', '2']);
    assert.equal(h.doc.getElementById('text-transcript').querySelector('[data-empty]'), null);
    assert.equal(h.doc.getElementById('text-transcript').scrollTop, 100);
    for (const id of REFRESH_REGIONS) assert.match(h.doc.getElementById(id).textContent, /new/);
    await h.tick(50);
    assert.equal(h.doc.getElementById('text-live').textContent, 'Message saved.');
    await h.tick(50);
    assert.equal(h.doc.getElementById('text-live').textContent, 'New reply from the AI assistant. Canonical question: Who may export?');
    await h.tick(POLL_MS);
    assert.equal(h.doc.getElementById('text-durability').getAttribute('data-durability'), 'durable');
    assert.equal(h.doc.getElementById('text-durability').innerHTML, 'durable');
    assert.equal(h.doc.getElementById('text-transcript').querySelectorAll('[data-seq]').length, 2);
    assert.equal(h.timers.filter((timer) => timer.ms === POLL_MS).length, 0, 'durable stops polling');
  });

  for (const [region, control] of [['text-current-question', 'question-link'], ['text-confirmation', 'confirm-button'], ['text-review', 'review-link']]) {
    it(`preserves focus and displayed bindings inside ${region} during polling, then updates after focus leaves`, async (t) => {
      const h = harness(t, { snapshots: [{ label: 'first' }, { label: 'second', seqs: ['1'] }, { label: 'third', seqs: ['1'], pending: false }] });
      await h.doc.submit(h.doc.getElementById('text-turn-form'));
      const focused = h.doc.getElementById(control);
      const current = h.doc.getElementById(region);
      focused.focus();
      await h.tick(POLL_MS);
      assert.equal(h.doc.activeElement, focused, 'poll must not detach the keyboard target');
      assert.equal(h.doc.getElementById(region), current);
      assert.match(current.textContent, /first/);
      for (const id of REFRESH_REGIONS.filter((id) => id !== region)) assert.match(h.doc.getElementById(id).textContent, /second/);
      assert.equal(h.doc.getElementById('text-transcript').querySelectorAll('[data-seq]').length, 1, 'the log still refreshes');
      h.doc.getElementById('text-turn-input').focus();
      await h.tick(POLL_MS);
      assert.notEqual(h.doc.getElementById(region), current);
      assert.match(h.doc.getElementById(region).textContent, /third/);
      assert.equal(h.doc.activeElement.id, 'text-turn-input');
    });
  }

  it('refreshes a successful confirmation and focuses its new section heading after the old button disappears', async (t) => {
    const h = harness(t, { response: { message: 'Confirmed 1 item.' }, snapshots: [{ confirmed: true, pending: false, label: 'confirmed' }] });
    const form = h.doc.getElementById('confirm-form');
    const oldHeading = h.doc.getElementById('text-confirmation-h');
    h.doc.getElementById('confirm-button').focus();
    assert.equal(await h.doc.submit(form), true);
    assert.equal(h.requests[0].options.body.get('binding'), 'REQ-1@1@digest');
    assert.equal(h.doc.getElementById('confirm-button'), null);
    assert.notEqual(h.doc.getElementById('text-confirmation-h'), oldHeading);
    assert.equal(h.doc.activeElement.id, 'text-confirmation-h');
    assert.equal(h.doc.activeElement.tabIndex, -1);
    await h.tick(50);
    assert.equal(h.doc.getElementById('text-live').textContent, 'Confirmed 1 item.');
  });

  it('announces plain new replies and removes the empty transcript placeholder', async (t) => {
    const h = harness(t, { response: {}, snapshots: [{ seqs: ['1'], pending: false }] });
    await h.doc.submit(h.doc.getElementById('text-turn-form'));
    assert.equal(h.doc.getElementById('text-transcript').querySelector('[data-empty]'), null);
    await h.tick(50);
    assert.equal(h.doc.getElementById('text-live').textContent, 'New reply from the AI assistant.');
  });

  it('shows and focuses a refused request, retains draft input, and refreshes without polling', async (t) => {
    const h = harness(t, { ok: false, response: { error: '<img src=x> refused' }, snapshots: [{ pending: false }] });
    const form = h.doc.getElementById('text-turn-form');
    await h.doc.submit(form);
    const error = h.doc.getElementById('page-error');
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(error.textContent, '<img src=x> refused');
    assert.equal(h.doc.activeElement, error);
    assert.equal(form.elements.message.value, 'Draft input');
    assert.equal(form.getAttribute('aria-busy'), null);
    assert.equal(h.requests.length, 2);
    assert.equal(h.timers.length, 0);
  });

  it('keeps input and focuses the error if the POST or subsequent refresh fails', async (t) => {
    for (const failure of [{ postError: true }, { refreshError: true }]) {
      const h = harness(t, failure);
      await h.doc.submit(h.doc.getElementById('text-turn-form'));
      assert.equal(h.doc.getElementById('text-turn-input').value, 'Draft input');
      assert.equal(h.doc.activeElement.id, 'page-error');
      assert.match(h.doc.activeElement.textContent, /Could not reach the server/);
    }
  });

  it('bounds pending polling and destroys the listener and outstanding poll', async (t) => {
    const h = harness(t);
    await h.doc.submit(h.doc.getElementById('text-turn-form'));
    for (let i = 0; i < POLL_LIMIT; i += 1) await h.tick(POLL_MS);
    assert.equal(h.requests.length, POLL_LIMIT + 2);
    assert.equal(h.timers.filter((timer) => timer.ms === POLL_MS).length, 0);
    await h.doc.submit(h.doc.getElementById('text-turn-form'));
    const count = h.requests.length;
    h.ui.destroy();
    assert.equal(h.doc.listeners.has('submit'), false);
    await h.tick(POLL_MS);
    assert.equal(h.requests.length, count);
    assert.equal(await h.doc.submit(h.doc.getElementById('text-turn-form')), false);
  });
});
