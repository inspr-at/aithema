import { resolveCopy } from './copy-resolve.js';
import { node, setText } from './dom.js';
import { WARNING_ICON } from './concept-view.js';
import { stagedImage } from '../../core/src/image-input.js';

/** Owns erasable previews and bounded refusal records; never changes conversation input. */
export class ImageInputView {
  #ports; #copy; #tiles; #records = []; #refusalVersion = 0; #urls = new Map(); #loads = new Map(); #epoch = 0; #reserve; #reserveObserver;
  constructor(ports) {
    this.#ports = ports; this.#copy = ports.copy;
    this.#tiles = node('div', 'staged-images'); this.#tiles.hidden = true;
    ports.form.prepend(this.#tiles);
    this.#reserve = node('span', 'image-feedback-reserve');
    this.#reserve.setAttribute('aria-hidden', 'true'); this.#reserve.inert = true;
    const fit = () => {
      const height = Math.ceil(this.#reserve.getBoundingClientRect().height);
      if (height > 0) ports.form.style.setProperty('--image-feedback-height', `${height}px`);
    };
    const Observer = ports.form.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) { this.#reserveObserver = new Observer(fit); this.#reserveObserver.observe(this.#reserve); }
    for (const upload of ports.session().uploads) this.receive(upload);
  }
  get refusalVersion() { return this.#refusalVersion; }
  get hasRefusals() { return this.#records.length > 0; }
  get pending() { return this.#ports.session().uploads.some(u => stagedImage(u) && !u.erased && u.state === 'staged-pending'); }
  get attachments() { return this.#ports.session().uploads.filter(u => u.kind === 'image' && !u.erased && u.state === 'staged-ready').map(u => u.id); }
  refuse(records) {
    for (const record of records) {
      const key = `${record.id ?? record.name}:${record.reason}`;
      this.#records = this.#records.filter(prior => prior.key !== key);
      this.#records.push({ ...record, key, version: ++this.#refusalVersion });
    }
    this.#records = this.#records.slice(-8);
  }
  clear(through = this.#refusalVersion) { this.#records = this.#records.filter(record => record.version > through); }
  receive(upload) { if (upload.kind === 'image' && upload.state === 'staged-refused' && !upload.erased) this.refuse([{ id: upload.id, name: upload.filename, reason: upload.reason }]); }
  #text(key, legacy) { return resolveCopy(this.#copy, key, legacy, this.#ports.session().locale); }
  refusalText(reason) { return this.#text(`imageRefusals.${reason}`, reason === 'model' ? 'imageUnsupportedModel' : reason === 'live-call' ? 'imageLiveCall' : undefined) ?? this.#text('imageRefusals.unavailable'); }
  #refusal(record) {
    const row = node('span', 'image-refusal');
    const name = node('span', 'image-refusal__name', record.name ? `${record.name}: ` : ''); name.title = record.name ?? '';
    row.append(name, node('span', 'image-refusal__reason', this.refusalText(record.reason)));
    return row;
  }
  #reserveFeedback() {
    // Hosts without image input have no feedback slot to measure. Build its
    // localized candidates only once that layout is active.
    if (!this.#ports.form.hasAttribute('data-image-input')) {
      this.#reserve.remove();
      this.#ports.form.style.removeProperty('--image-feedback-height');
      return;
    }
    if (!this.#reserve.parentElement) this.#ports.form.querySelector('.composer-feedback').append(this.#reserve);
    const reasons = ['batch', 'unsupported', 'size', 'limit', 'empty', 'malformed', 'dimensions', 'deadline', 'cancelled', 'unavailable', 'session', 'model', 'live-call', 'paused'];
    const key = JSON.stringify([reasons.map(reason => this.refusalText(reason)), this.#copy.uploads.discard]);
    if (this.#reserve.dataset.copy !== key) {
      this.#reserve.dataset.copy = key;
      this.#reserve.replaceChildren(...reasons.map(reason => {
        const row = node('span', 'image-refusals-reserve__row');
        const icon = node('span', 'image-refusals__icon');
        const list = node('span', 'image-refusals__list'); list.append(this.#refusal({ name: 'file', reason }));
        row.append(icon, list, node('span', 'image-refusals__dismiss', this.#copy.uploads.discard));
        return row;
      }));
    }
    const height = Math.ceil(this.#reserve.getBoundingClientRect().height);
    if (height > 0) this.#ports.form.style.setProperty('--image-feedback-height', `${height}px`);
  }
  paintRefusals(line) {
    let region = line.querySelector('.image-refusals');
    if (!region) {
      region = node('span', 'image-refusals'); region.tabIndex = 0;
      const glyph = node('span', 'image-refusals__icon'); glyph.innerHTML = WARNING_ICON;
      const list = node('span', 'image-refusals__list');
      const dismiss = node('button', 'consent-action image-refusals__dismiss'); dismiss.type = 'button';
      dismiss.addEventListener('click', () => { this.clear(); this.#ports.changed(); });
      region.append(glyph, list, dismiss); line.replaceChildren(region);
    }
    const list = region.querySelector('.image-refusals__list');
    const signature = JSON.stringify([this.#records, this.#copy.display?.locale, this.#records.map(record => this.refusalText(record.reason))]);
    if (list.dataset.records !== signature) {
      list.replaceChildren(...this.#records.map(record => this.#refusal(record)));
      list.dataset.records = signature;
    }
    setText(region.querySelector('button'), this.#copy.uploads.discard); delete line.dataset.consentFeature;
  }
  update(copy = this.#copy) {
    this.#copy = copy; this.#reserveFeedback();
    const session = this.#ports.session(), images = session.uploads.filter(u => stagedImage(u) && !u.erased && u.state !== 'staged-discarded');
    this.#tiles.hidden = !images.length;
    const active = new Set((this.#ports.canRead() ? session.uploads : []).filter(u => u.kind === 'image' && !u.erased && ['staged-ready', 'sent'].includes(u.state)).map(u => `${u.id}:${u.digest}`));
    for (const [key, url] of this.#urls) if (!active.has(key)) { URL.revokeObjectURL(url); this.#urls.delete(key); }
    const rows = new Map([...this.#tiles.children].map(row => [row.dataset.id, row]));
    for (const image of images) {
      let row = rows.get(image.id); rows.delete(image.id);
      if (!row) {
        row = node('div', 'staged-image'); row.dataset.id = image.id;
        const preview = node('span', 'staged-image__preview'), status = node('span', 'staged-image__status');
        const remove = node('button', 'staged-image__remove', '×'); remove.type = 'button';
        remove.addEventListener('click', () => this.#ports.remove(image.id));
        row.append(preview, status, remove); this.#tiles.append(row);
      }
      row.dataset.state = image.state;
      row.querySelector('button').setAttribute('aria-label', this.#text('imageRemove').replace('{name}', image.filename ?? ''));
      row.querySelector('button').title = this.#text('imageRemove').replace('{name}', image.filename ?? '');
      setText(row.querySelector('.staged-image__status'), image.state === 'staged-pending' ? this.#text('imagePreparing')
        : image.filename ?? '');
      if (image.state === 'staged-ready') this.#paintImage(row.querySelector('.staged-image__preview'), image);
      else row.querySelector('.staged-image__preview').replaceChildren();
    }
    for (const row of rows.values()) row.remove();
  }
  paintTurn(row, turn) {
    const ids = turn.erased || turn.withdrawn ? [] : turn.attachments ?? [];
    let strip = row.querySelector('.turn-images');
    if (!ids.length) { strip?.remove(); return; }
    if (!strip) { strip = node('span', 'turn-images'); row.querySelector('.turn-text').after(strip); }
    const kept = new Set(ids);
    for (const tile of strip.children) if (!kept.has(tile.dataset.id)) tile.remove();
    for (const id of ids) {
      let tile = [...strip.children].find(tile => tile.dataset.id === id);
      if (!tile) { tile = node('span', 'turn-image'); tile.dataset.id = id; strip.append(tile); }
      const image = this.#ports.session().uploads.find(u => u.id === id);
      if (!this.#ports.canRead() || !image || image.state !== 'sent' || image.erased || image.withdrawn) {
        tile.dataset.withheld = ''; tile.style.width = ''; tile.style.height = '';
        tile.replaceChildren(node('span', '', this.#text('imageWithheld'))); continue;
      }
      delete tile.dataset.withheld;
      tile.style.width = `${Math.max(24, Math.round(72 * image.w / Math.max(image.w, image.h)))}px`;
      tile.style.height = `${Math.max(24, Math.round(72 * image.h / Math.max(image.w, image.h)))}px`;
      this.#paintImage(tile, image);
    }
  }
  #paintImage(tile, image) {
    if (!this.#ports.canRead()) { tile.replaceChildren(); return; }
    const key = `${image.id}:${image.digest}`, url = this.#urls.get(key);
    if (url) {
      let img = tile.querySelector('img');
      if (!img) { img = node('img', 'image-thumbnail'); img.width = image.w; img.height = image.h; tile.replaceChildren(img); }
      img.alt = image.filename ?? ''; if (img.getAttribute('src') !== url) img.src = url;
      return;
    }
    if (this.#loads.has(key)) return;
    const epoch = this.#epoch, sessionId = this.#ports.session().id;
    const pending = this.#ports.fetchImage(image.id).then(async response => {
      if (!response.ok) return;
      const blob = await response.blob();
      if (this.#epoch !== epoch || this.#ports.session().id !== sessionId || !this.#ports.session().uploads.some(u => u.id === image.id && u.digest === image.digest && !u.erased && ['staged-ready', 'sent'].includes(u.state))) return;
      const url = URL.createObjectURL(blob); this.#urls.set(key, url); this.#ports.changed();
    }).catch(() => {}).finally(() => this.#loads.delete(key));
    this.#loads.set(key, pending);
  }
  destroy() { this.#reserveObserver?.disconnect(); this.#epoch++; for (const url of this.#urls.values()) URL.revokeObjectURL(url); this.#urls.clear(); this.#records = []; }
}
