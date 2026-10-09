// START AiSettings.astro, ai-settings.ts and settings-controls.ts behaviour, ported
// to a native modal <dialog> inside the component (INSPR D3). The server owns every
// verdict: this dialog sends option ids and shows only acknowledged state.
import { settingsGauges, GAUGES, SETTINGS_OFF, preferredEffort } from '../../core/src/settings.js';

const svg = (body, box = '0 0 24 24') => `<svg viewBox="${box}" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const stars = Array.from({ length: 12 }, (_, i) => `<path d="m0-2 .6 1.3 1.4.2-1 1 .2 1.4L0 1.2l-1.2.7.2-1.4-1-1 1.4-.2Z" transform="translate(${(16 + 10 * Math.sin(i * Math.PI / 6)).toFixed(2)} ${(16 - 10 * Math.cos(i * Math.PI / 6)).toFixed(2)})" fill="currentColor" stroke="none"/>`).join('');
export const ICONS = Object.freeze({
  best: svg('<circle cx="16" cy="16" r="12"/><ellipse cx="16" cy="16" rx="5.5" ry="12"/><path d="M5 11h22M4 17h24M6 23h20"/>', '0 0 32 32'),
  eu: svg(stars, '0 0 32 32'),
  device: svg('<rect x="5" y="5" width="22" height="17" rx="1.5"/><path d="m5 22-3 4h28l-3-4ZM12 26h8"/>', '0 0 32 32'),
  custom: svg('<path d="M4 7h5m6 0h13M4 16h14m6 0h4M4 25h5m6 0h13"/><circle cx="12" cy="7" r="3"/><circle cx="21" cy="16" r="3"/><circle cx="12" cy="25" r="3"/>', '0 0 32 32'),
  general: svg('<path d="M4 7h3m4 0h9M4 17h9m4 0h3"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>'),
  model: svg('<path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 3V5a2 2 0 0 1 2-2Z"/>'),
  local: svg('<path d="M6 4v3m0 4v9m6-16v9m0 4v3m6-16v3m0 4v9"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="18" cy="9" r="2"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1 7 17m10-10 2.1-2.1"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'), chevron: svg('<path d="m6 9 6 6 6-6"/>'), arrow: svg('<path d="M5 12h14m-6-6 6 6-6 6"/>'),
  text: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M6 15h12"/>'),
  off: svg('<circle cx="12" cy="12" r="9"/><path d="m6 18 12-12"/>'),
});
const ETCH = Object.freeze({
  quality: '<path d="m4 11 6-6h12l6 6-12 17ZM4 11h24M10 5l6 23 6-23M10 5l6 6 6-6"/>',
  speed: '<path d="M5 22a11 11 0 1 1 22 0"/><path d="m16 22 6-8"/><circle cx="16" cy="22" r="1.5"/>',
  cost: '<ellipse cx="16" cy="9" rx="9" ry="3.5"/><path d="M7 9v6c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V9M7 15v6c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5v-6"/>',
  privacy: '<path d="M16 3c3 4 7 5 11 5v8c0 6-5 11-11 14C10 27 5 22 5 16V8c4 0 8-1 11-5Z"/><rect x="11" y="14" width="10" height="9" rx="1"/><path d="M13 14v-3a3 3 0 0 1 6 0v3m-3 4v2"/>',
  voice: '<path d="M26 14a10 10 0 0 1-10 10h-3l-6 4 1-7a10 10 0 1 1 18-7Z"/><path d="M10 12v5m4-8v11m4-9v7m4-5v3"/>',
  images: '<rect x="4" y="5" width="24" height="22" rx="2"/><circle cx="21" cy="11" r="2"/><path d="m5 24 8-10 6 7 4-5 4 6"/>',
});
const WAVES = ['M0 18C30 2 70 2 100 18C130 34 170 34 200 18C230 2 270 2 300 18C330 34 370 34 400 18V36H0Z',
  'M0 18C30 30 70 30 100 18C130 6 170 6 200 18C230 30 270 30 300 18C330 6 370 6 400 18V36H0Z'];
export const PRESET_ORDER = Object.freeze(['best', 'eu', 'device', 'custom']);
export const fill = (template, values = {}) => String(template).replace(/\{(\w+)\}/gu, (_, key) => values[key] ?? '');
export const reasonText = (copy, reason) => copy.reasons?.[reason] ?? reason;
const optionId = value => typeof value === 'string' ? value : value?.id ?? null;
/**
 * The acknowledged selection. Stored ids are authoritative; the server's public
 * description only resolves fields that follow the host default (null).
 */
export function activeSelection(session) {
  const engine = session.engine ?? {}, settings = session.settings ?? {};
  return { processingPreset: session.processingPreset ?? 'best', model: settings.model ?? engine.model?.id ?? null,
    effort: settings.effort ?? engine.effort ?? null, voice: settings.voice ?? optionId(engine.voice) ?? SETTINGS_OFF,
    visuals: settings.visuals ?? optionId(engine.visuals) ?? SETTINGS_OFF, revision: settings.revision ?? 0 };
}
/** Public labels for the acknowledged choice; a description older than the stored ids yields to them. */
export function engineView(session) {
  const engine = session.engine ?? {}, settings = session.settings ?? {}, fresh = engine.preset === undefined || engine.preset === session.processingPreset;
  const pick = (stored, described) => stored === null || stored === undefined ? (fresh ? described : null)
    : stored === SETTINGS_OFF ? SETTINGS_OFF : fresh && optionId(described) === stored ? described : { id: stored, label: stored };
  return { model: pick(settings.model, engine.model) ?? null, effort: settings.effort ?? (fresh ? engine.effort : null) ?? null,
    voice: pick(settings.voice, engine.voice) ?? SETTINGS_OFF, visuals: pick(settings.visuals, engine.visuals) ?? SETTINGS_OFF };
}

export class SettingsDialog {
  #dialog; #copy; #ports; #catalog = null; #loadFailed = false; #active = null; #draft = null; #revision = 0;
  #saving = null; #failed = false; #status = ''; #notice = null; #tab = 'model'; #help = 'processing'; #hovered = null;
  #opener = null; #timer = 0; #continue = false; #closing = false; #paintKeys = new Map(); #busy = false;
  constructor({ dialog, copy, ports }) {
    this.#dialog = dialog; this.#copy = copy; this.#ports = ports; this.#build();
  }
  get open() { return this.#dialog.open; }
  get element() { return this.#dialog; }
  #q(selector) { return this.#dialog.querySelector(selector); }
  #focused() { try { return this.#dialog.getRootNode().activeElement ?? null; } catch { return null; } }
  #all(selector) { return [...this.#dialog.querySelectorAll(selector)]; }
  #build() {
    const c = this.#copy.settings, gauge = kind => `<figure class="gauge gauge--${kind}" data-gauge="${kind}"><strong class="gauge__value"></strong>
      <div class="gauge__glass" aria-hidden="true"><div class="gauge__inside"><div class="gauge__level">
        ${WAVES.map((d, i) => `<svg class="gauge__wave gauge__wave--${i ? 'front' : 'back'}" viewBox="0 0 400 36" preserveAspectRatio="none"><path d="${d}"/></svg>`).join('')}
        <div class="gauge__fluid"></div><span class="gauge__bubbles"></span></div><span class="gauge__glint"></span></div>
        <span class="gauge__rim"></span><span class="gauge__etch">${svg(ETCH[kind], '0 0 32 32')}</span></div>
      <figcaption><span class="gauge__label"></span><small class="gauge__detail"></small></figcaption></figure>`;
    const select = name => `<div class="select" data-select="${name}"><button type="button" class="select__button" id="settings-select-${name}"
      aria-haspopup="listbox" aria-expanded="false" aria-controls="settings-options-${name}" data-help="${name}"><span class="select__value"></span>${ICONS.chevron}</button>
      <div class="select__menu" role="listbox" id="settings-options-${name}" hidden></div></div>`;
    // Static trusted markup only. Host, model and plugin text is assigned through textContent.
    this.#dialog.innerHTML = `<div class="settings__frame">
      <header class="settings__header"><h2 class="settings__title" id="settings-title"></h2>
        <div class="settings__tabs" role="tablist">${['general', 'model', 'local'].map(tab => `<button type="button" role="tab" id="settings-tab-${tab}"
          aria-controls="settings-panel-${tab}" data-tab="${tab}" data-help="${tab === 'model' ? 'processing' : tab}"><span class="tab-icon">${ICONS[tab]}</span><span class="tab-label"></span></button>`).join('')}</div></header>
      <div class="settings__body">
        <section class="settings-panel" role="tabpanel" id="settings-panel-model" aria-labelledby="settings-tab-model" data-panel="model">
          <div class="settings-column">
            <fieldset class="settings-field"><legend><span class="help-term" tabindex="0" data-help="processing" data-text="processing"></span></legend>
              <div class="presets" role="radiogroup">${PRESET_ORDER.map(preset => `<button type="button" role="radio"
                class="preset-option" data-preset="${preset}" data-help="${preset}"><span class="radio" aria-hidden="true"></span><span class="preset-icon">${ICONS[preset]}</span>
                <span class="preset-name"></span><small class="option-status"></small></button>`).join('')}</div></fieldset>
            <fieldset class="settings-field"><legend><span class="help-term" tabindex="0" data-help="model" data-text="model"></span></legend>${select('model')}
              <div class="effort-area"><div class="effort" data-help="effort"><label for="settings-effort" data-text="responseStyle"></label>
                <div class="effort__track"><span data-text="faster"></span><input id="settings-effort" type="range" min="0" max="1" step="1" aria-describedby="settings-effort-value"><span data-text="moreThorough"></span></div>
                <output id="settings-effort-value" for="settings-effort"></output></div><p class="note effort-note"></p></div></fieldset>
          </div>
          <div class="settings-column">
            <fieldset class="settings-field"><legend><span class="help-term" tabindex="0" data-help="voice" data-text="voice"></span></legend>${select('voice')}</fieldset>
            <fieldset class="settings-field"><legend><span class="help-term" tabindex="0" data-help="visuals" data-text="visuals"></span></legend>${select('visuals')}</fieldset>
            <div class="notice-area"><div class="notice-body" role="status" aria-live="polite"><p class="notice-text"></p><button type="button" class="notice-action" hidden></button></div></div>
          </div>
          <div class="settings-column settings-overview"><div class="gauge-panel" data-help="gauges"><div class="gauges">${GAUGES.map(gauge).join('')}</div></div></div>
        </section>
        <section class="settings-panel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" data-panel="general" hidden>
          <div class="general"><section><h3 data-text="conversationTitle"></h3><p class="note" data-text="newConversationHint"></p>
              <button type="button" class="general-new" data-text="newConversation"></button></section>
            <section data-help="consent"><h3 data-text="consentTitle"></h3><p class="status-line general-consent"></p>
              <button type="button" class="general-consent-manage" data-text="manageConsent"></button></section>
            <section><h3 data-text="defaultsTitle"></h3><p class="note" data-text="defaultsHint"></p>
              <button type="button" class="general-recommended" data-text="recommended"></button></section></div>
        </section>
        <section class="settings-panel" role="tabpanel" id="settings-panel-local" aria-labelledby="settings-tab-local" data-panel="local" hidden><div class="local-host"></div></section>
      </div>
      <div class="settings-context"><span class="context-icon" aria-hidden="true">i</span><div class="context-text"><p class="context-message" role="status" aria-live="polite"></p></div></div>
      <footer class="settings__footer"><div class="footer-links"><details class="disclosure"><summary data-help="providers" data-text="providers"></summary>
          <div class="disclosure__body"><p class="disclosure-processing"></p><p data-text="gaugeNote"></p><p data-text="history"></p></div></details>
          <button type="button" class="link footer-consent" data-help="consent" data-text="manageConsent"></button></div>
        <div class="save-state"><span class="save-check">${ICONS.check}</span><p class="save-status" role="status" aria-live="polite"></p>
          <button type="button" class="save-retry" data-text="retry" data-visible="false"></button></div>
        <button type="button" class="done">${ICONS.check}<span class="done-label"></span></button></footer></div>`;
    this.#dialog.setAttribute('aria-labelledby', 'settings-title');
    this.#q('.presets').setAttribute('aria-label', c.processing);
    for (const node of this.#all('[data-text]')) node.textContent = c[node.dataset.text];
    this.#q('.settings__title').textContent = c.title;
    for (const tab of this.#all('[data-tab]')) tab.querySelector('.tab-label').textContent = c.tabs[tab.dataset.tab];
    this.#q('.settings__tabs').setAttribute('aria-label', c.title);
    for (const kind of GAUGES) this.#q(`[data-gauge="${kind}"] .gauge__label`).textContent = this.#copy.gauges.labels[kind];
    for (const [name, label] of [['model', c.model], ['voice', c.voice], ['visuals', c.visuals]]) this.#q(`#settings-options-${name}`).setAttribute('aria-label', label);
    // Fixed boxes: every help text and notice is measured into its own grid cell.
    const measure = (parent, texts, className) => parent.append(...texts.map(text => {
      const node = document.createElement('p'); node.className = className; node.setAttribute('aria-hidden', 'true'); node.textContent = text; return node;
    }));
    measure(this.#q('.context-text'), Object.values(this.#copy.help).map(text => fill(text, { reason: '' })), 'context-measure');
    const notices = [c.callActive, c.toDevice, c.fromDevice, c.consentRequired, c.running, c.conflict, fill(c.notAllowed, { reason: '' })];
    const box = document.createElement('div'); box.className = 'notice-measure'; box.setAttribute('aria-hidden', 'true');
    const tallest = document.createElement('p'); tallest.className = 'notice-text';
    tallest.textContent = notices.reduce((a, b) => b.length > a.length ? b : a);
    const button = document.createElement('span'); button.className = 'notice-action'; button.style.display = 'inline-block'; button.style.minHeight = '2.75rem';
    box.append(tallest, button); this.#q('.notice-area').prepend(box);
    this.#wire();
  }
  #wire() {
    const dialog = this.#dialog;
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const menu = this.#all('.select__menu').find(node => !node.hidden), disclosure = this.#q('.disclosure[open]');
      event.preventDefault(); event.stopPropagation();
      if (menu) this.#closeMenu(menu.closest('.select'), true);
      else if (disclosure) { disclosure.open = false; disclosure.querySelector('summary').focus(); }
      else this.close();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) { this.close(); return; }
      for (const select of this.#all('.select')) if (!select.contains(event.target)) this.#closeMenu(select);
    });
    dialog.addEventListener('pointerover', event => { this.#hovered = event.target.closest?.('[data-help]') ?? null; this.#showHelp(); });
    dialog.addEventListener('pointerout', event => { this.#hovered = event.relatedTarget?.closest?.('[data-help]') ?? null; this.#showHelp(); });
    dialog.addEventListener('focusin', () => this.#showHelp());
    for (const tab of this.#all('[data-tab]')) {
      tab.addEventListener('click', () => this.#setTab(tab.dataset.tab));
      tab.addEventListener('keydown', event => {
        const tabs = this.#all('[data-tab]'), index = tabs.indexOf(tab);
        const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault(); this.#setTab(tabs[next].dataset.tab, true);
      });
    }
    const presets = this.#all('.preset-option');
    for (const button of presets) {
      button.addEventListener('click', () => this.#choosePreset(button.dataset.preset));
      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = presets.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? presets.length - 1
          : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + presets.length) % presets.length;
        presets[next].focus(); presets[next].click();
      });
    }
    for (const select of this.#all('.select')) this.#wireSelect(select);
    const effort = this.#q('#settings-effort');
    effort.addEventListener('input', () => {
      const option = this.#modelOption(), value = option?.efforts[Number(effort.value)];
      this.#help = 'effort';
      if (value) this.#change({ effort: value }, true);
    });
    effort.addEventListener('change', () => { if (this.#timer) { clearTimeout(this.#timer); this.#timer = 0; void this.#save(); } });
    this.#q('.done').addEventListener('click', () => void this.#done());
    this.#q('.save-retry').addEventListener('click', () => { this.#failed = false; void this.#save(true); });
    this.#q('.notice-action').addEventListener('click', () => void this.#notice?.action?.());
    for (const selector of ['.footer-consent', '.general-consent-manage']) this.#q(selector).addEventListener('click', () => this.#ports.consent('manage'));
    this.#q('.general-new').addEventListener('click', () => {
      const draft = this.#draft ?? this.#active;
      this.#ports.newConversation({ processingPreset: draft.processingPreset, settings: this.#settingsOf(draft) });
    });
    this.#q('.general-recommended').addEventListener('click', () => {
      const preset = this.#draft?.processingPreset ?? 'best', info = this.#catalog?.presets?.[preset];
      if (!info?.defaults || preset === 'device') return;
      this.#change({ model: info.defaults.model, effort: info.defaults.effort, voice: info.defaults.voice, visuals: info.defaults.visuals });
    });
  }
  #wireSelect(select) {
    const button = select.querySelector('.select__button'), menu = select.querySelector('.select__menu');
    const options = () => [...menu.querySelectorAll('[role=option]')];
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') { this.#help = button.dataset.reason ? `${button.dataset.kind || 'unavailable'}:${button.dataset.reason}` : button.dataset.help; this.#showHelp(); return; }
      if (menu.hidden) this.#openMenu(select); else this.#closeMenu(select, true);
    });
    select.addEventListener('keydown', event => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (event.key === 'Tab') { this.#closeMenu(select); return; }
      const items = options();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (menu.hidden) this.#openMenu(select);
        const current = items.indexOf(this.#focused());
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0
          ? Math.max(0, items.findIndex(item => item.getAttribute('aria-selected') === 'true'))
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      } else if (!menu.hidden && event.key.length === 1 && /\S/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const item = items.find(node => node.querySelector('strong')?.textContent.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
        if (item) { event.preventDefault(); item.focus(); }
      }
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[role=option]');
      if (!option) return;
      this.#help = option.dataset.reason ? `${option.dataset.kind || 'unavailable'}:${option.dataset.reason}` : option.dataset.help;
      if (option.getAttribute('aria-disabled') === 'true') { this.#showHelp(); return; }
      this.#closeMenu(select, true);
      const name = select.dataset.select, value = option.dataset.value;
      if (name === 'model') {
        const target = this.#presetInfo()?.models?.find(o => o.id === value);
        // Keep the response style when the new model offers it, else use the host's default for that model.
        this.#change({ model: value, effort: !target?.efforts.length ? null : target.efforts.includes(this.#draft.effort) ? this.#draft.effort
          : target.effort ?? preferredEffort(target.efforts) });
      } else this.#change({ [name]: value });
    });
  }
  #openMenu(select) {
    for (const other of this.#all('.select')) if (other !== select) this.#closeMenu(other);
    select.querySelector('.select__menu').hidden = false;
    select.querySelector('.select__button').setAttribute('aria-expanded', 'true');
  }
  #closeMenu(select, focus = false) {
    const menu = select.querySelector('.select__menu'), button = select.querySelector('.select__button');
    if (menu.hidden) return;
    menu.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  }
  /** Opens on the AI model tab; Continue is the chooser's Custom path. */
  open(opener, { tab = 'model', continueLabel = false, preset } = {}) {
    if (this.#dialog.open) return;
    this.#opener = opener ?? null; this.#continue = continueLabel; this.#closing = false;
    this.#active = activeSelection(this.#ports.state().session);
    if (!this.#failed) { this.#draft = { ...this.#active }; this.#status = this.#copy.settings.autosave; this.#notice = null; }
    this.#help = tab === 'model' ? 'processing' : tab;
    if (typeof this.#dialog.showModal === 'function') this.#dialog.showModal(); else this.#dialog.setAttribute('open', '');
    this.#setTab(tab); this.#render();
    this.#q('.done').focus();
    // The chooser's Custom card preselects the host's Custom preset with its defaults.
    void this.reload().then(() => { if (preset && this.#dialog.open && preset !== this.#draft?.processingPreset) this.#choosePreset(preset); });
  }
  async reload() {
    try { this.setCatalog(await this.#ports.catalog()); }
    catch { this.#loadFailed = true; this.#render(); }
  }
  setCatalog(catalog) {
    this.#catalog = catalog; this.#loadFailed = false;
    if (catalog?.settings && !this.#saving && !this.#pending()) {
      this.#active = activeSelection({ processingPreset: catalog.processingPreset, settings: catalog.settings, engine: catalog.engine });
      this.#draft = { ...this.#active };
    }
    this.#render();
  }
  /** Acknowledged session state changed elsewhere (SSE, another tab, reconfigure). */
  sync() {
    if (!this.#dialog.open) return;
    const active = activeSelection(this.#ports.state().session);
    if (this.#active && active.revision !== this.#active.revision && !this.#saving) {
      const drafting = this.#pending(); this.#active = active;
      if (!drafting) this.#draft = { ...active };
    }
    this.#render();
  }
  close() {
    if (!this.#dialog.open || this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#timer); this.#timer = 0;
    for (const select of this.#all('.select')) this.#closeMenu(select);
    this.#q('.disclosure').open = false;
    // Unsent drafts are discarded; the summary always shows the acknowledged choice.
    if (!this.#saving) { this.#draft = this.#active ? { ...this.#active } : null; this.#failed = false; this.#notice = null; }
    if (typeof this.#dialog.close === 'function') this.#dialog.close(); else this.#dialog.removeAttribute('open');
    this.#ports.closed?.();
    // A save can re-render the card that opened the dialog; focus then returns to a stable control.
    const target = this.#opener?.isConnected ? this.#opener : this.#ports.focusFallback?.(this.#opener);
    target?.focus();
    this.#closing = false;
  }
  async #done() {
    clearTimeout(this.#timer);
    if (this.#timer) { this.#timer = 0; await this.#save(); }
    if (this.#saving) { this.#status = this.#copy.settings.closePending; this.#render(); await this.#saving; }
    if (this.#failed) return;
    if (this.#pending() && !this.#notice?.explicit) { await this.#save(); if (this.#failed || this.#pending()) return; }
    this.close();
  }
  #setTab(tab, focus = false) {
    this.#tab = tab;
    for (const select of this.#all('.select')) this.#closeMenu(select);
    for (const button of this.#all('[data-tab]')) {
      const chosen = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(chosen)); button.tabIndex = chosen ? 0 : -1;
      if (chosen && focus) button.focus();
    }
    for (const panel of this.#all('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
    if (tab === 'local') this.#ports.connector?.mount(this.#q('.local-host'));
    if (tab === 'local' && !this.#ports.connector) {
      const note = document.createElement('p'); note.className = 'note'; note.textContent = this.#copy.local.unavailableHost;
      this.#q('.local-host').replaceChildren(note);
    }
    this.#help = tab === 'model' ? this.#draft?.processingPreset ?? 'processing' : tab;
    this.#q('.settings__body').scrollTop = 0; this.#showHelp();
  }
  #presetInfo(preset = this.#draft?.processingPreset) { return this.#catalog?.presets?.[preset] ?? null; }
  #modelOption() { return this.#presetInfo()?.models?.find(o => o.id === this.#draft?.model) ?? null; }
  #pending() { return Boolean(this.#draft && this.#active) && ['processingPreset', 'model', 'effort', 'voice', 'visuals'].some(key => (this.#draft[key] ?? null) !== (this.#active[key] ?? null)); }
  #settingsOf(draft) {
    return draft.processingPreset === 'device' ? {} : { model: draft.model, effort: draft.effort, voice: draft.voice, visuals: draft.visuals };
  }
  #choosePreset(preset) {
    const button = this.#q(`.preset-option[data-preset="${preset}"]`);
    this.#help = button.dataset.reason ? `${button.dataset.kind || 'unavailable'}:${button.dataset.reason}` : preset;
    if (button.getAttribute('aria-disabled') === 'true' || preset === this.#draft?.processingPreset) { this.#showHelp(); return; }
    const info = this.#presetInfo(preset);
    // A preset brings its host defaults; returning to the saved preset restores the saved choice.
    const next = preset === this.#active.processingPreset ? { ...this.#active } : preset === 'device'
      ? { processingPreset: preset, model: null, effort: null, voice: SETTINGS_OFF, visuals: SETTINGS_OFF }
      : { processingPreset: preset, ...info?.defaults };
    if (next.model && info && preset !== this.#active.processingPreset) {
      const option = info.models.find(o => o.id === next.model);
      next.effort = !option?.efforts.length ? null : option.efforts.includes(next.effort) ? next.effort : option.effort ?? preferredEffort(option.efforts);
    }
    this.#change(next);
  }
  #change(patch, debounce = false) {
    if (!this.#draft) return;
    this.#draft = { ...this.#draft, ...patch }; this.#revision++; this.#failed = false;
    this.#notice = null; this.#status = this.#copy.settings.autosave;
    this.#render();
    clearTimeout(this.#timer); this.#timer = 0;
    if (debounce) this.#timer = setTimeout(() => { this.#timer = 0; void this.#save(); }, 300);
    else void this.#save();
  }
  // One writer: edits made while a save runs are drained after its acknowledgement.
  #save(retry = false) {
    if (this.#saving) return this.#saving.then(() => { if (this.#pending() && !this.#failed && !this.#timer) return this.#save(); });
    const drain = async () => {
      while (this.#pending() && this.#dialog.open && !this.#closing) {
        if (this.#timer) break;
        const c = this.#copy.settings, state = this.#ports.state(), draft = { ...this.#draft }, revision = this.#revision;
        const crossing = (this.#active.processingPreset === 'device') !== (draft.processingPreset === 'device');
        if (crossing && state.hasTurns) {
          // Device conversations live in this tab; crossing that boundary is an explicit new conversation.
          this.#notice = { text: draft.processingPreset === 'device' ? c.toDevice : c.fromDevice, explicit: true,
            label: draft.processingPreset === 'device' ? c.startDevice : c.startServer,
            action: () => this.#ports.newConversation({ processingPreset: draft.processingPreset, settings: this.#settingsOf(draft) }) };
          break;
        }
        if (state.voiceActive) { this.#callNotice(); break; }
        this.#status = c.saving; this.#busy = true; this.#render();
        let result;
        try { result = await this.#ports.save({ processingPreset: draft.processingPreset, ...this.#settingsOf(draft), baseRevision: this.#active.revision }); }
        finally { this.#busy = false; }
        if (result.ok) {
          const ack = result.ack;
          this.#active = activeSelection({ processingPreset: ack.processingPreset, settings: ack.settings, engine: ack.engine });
          if (revision === this.#revision) { this.#draft = { ...this.#active }; this.#status = ack.unchanged && !retry ? c.autosave : c.saved; }
          this.#notice = ack.consent?.required ? { text: c.consentRequired, label: c.reviewConsent, action: () => this.#ports.consent('settings', ack.consent.features) }
            : state.running && !ack.unchanged ? { text: c.running } : null;
          continue;
        }
        if (result.error === 'voice-call-active') { this.#callNotice(); break; }
        if (result.error === 'settings-conflict') {
          this.#active = activeSelection({ processingPreset: result.body.processingPreset, settings: result.body.settings });
          this.#draft = { ...this.#active }; this.#status = c.autosave; this.#notice = { text: c.conflict }; void this.reload(); break;
        }
        if (result.error === 'new-conversation-required') {
          this.#notice = { text: draft.processingPreset === 'device' ? c.toDevice : c.fromDevice, explicit: true,
            label: draft.processingPreset === 'device' ? c.startDevice : c.startServer,
            action: () => this.#ports.newConversation({ processingPreset: draft.processingPreset, settings: this.#settingsOf(draft) }) };
          break;
        }
        if (result.error === 'setting-not-allowed') {
          // A host refusal never retries; the acknowledged choice stays in force.
          this.#draft = { ...this.#active }; this.#status = c.autosave;
          this.#notice = { text: fill(c.notAllowed, { reason: reasonText(this.#copy, result.body.reason) }) }; void this.reload(); break;
        }
        this.#failed = true; this.#status = c.failed; break;
      }
    };
    this.#saving = drain().catch(() => { this.#failed = true; this.#status = this.#copy.settings.failed; })
      .finally(() => { this.#saving = null; this.#render(); });
    return this.#saving;
  }
  #callNotice() {
    const c = this.#copy.settings;
    this.#notice = { text: c.callActive, label: c.endCallApply, explicit: true, action: async () => {
      this.#notice = { text: c.callActive }; this.#render();
      await this.#ports.endCall();
      this.#notice = null; await this.#save();
    } };
  }
  #showHelp() {
    if (!this.#dialog.open) return;
    const term = this.#hovered ?? this.#focused()?.closest?.('[data-help]');
    const key = term?.dataset.reason ? `${term.dataset.kind || 'unavailable'}:${term.dataset.reason}` : term?.dataset.help ?? this.#help;
    const help = this.#copy.help, [kind, ...rest] = key.split(':'), reason = rest.join(':');
    const text = term?.dataset.help === 'gauge' ? term.dataset.helpText : reason && ['unavailable', 'consent', 'limited'].includes(kind)
      ? fill(help[kind === 'unavailable' ? 'unavailable' : kind === 'consent' ? 'consentNeeded' : 'limited'], { reason: reasonText(this.#copy, reason) })
      : help[key] ?? help[this.#help] ?? help.processing;
    this.#q('.context-message').textContent = text;
  }
  #optionStatus(option, kind) {
    const c = this.#copy.settings;
    return !option ? '' : !option.offered && kind === 'retained' ? c.notOffered : option.status === 'unavailable' ? c.unavailable
      : option.status === 'consent' ? c.consentNeeded : option.status === 'limited' ? c.limited : '';
  }
  #optionNode({ value, label, vendor, status, kind, reason, help, icon, selected }) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'select__option'; node.setAttribute('role', 'option');
    node.tabIndex = -1; node.dataset.value = value; node.dataset.help = help;
    node.setAttribute('aria-selected', String(selected)); node.setAttribute('aria-disabled', String(kind === 'unavailable'));
    if (reason) { node.dataset.reason = reason; node.dataset.kind = kind; }
    const name = document.createElement('span'); name.className = 'option-label';
    const strong = document.createElement('strong'); strong.textContent = label; name.append(strong);
    if (vendor && vendor !== label) { const small = document.createElement('small'); small.textContent = vendor; name.append(small); }
    const state = document.createElement('small'); state.className = 'option-status'; state.dataset.kind = kind ?? ''; state.textContent = status;
    const check = document.createElement('span'); check.className = 'option-check'; check.innerHTML = ICONS.check;
    if (icon) { const lead = document.createElement('span'); lead.className = 'preset-icon'; lead.innerHTML = icon; node.append(lead); }
    node.append(name, state, check);
    return node;
  }
  #renderSelect(name, options, selectedValue, { disabled = false, reason = '' } = {}) {
    const select = this.#q(`[data-select="${name}"]`), menu = select.querySelector('.select__menu'), button = select.querySelector('.select__button');
    const key = JSON.stringify([options, selectedValue, disabled]);
    if (this.#paintKeys.get(name) !== key) {
      const active = this.#focused(), focused = active && menu.contains(active) ? active.dataset.value : undefined;
      this.#paintKeys.set(name, key);
      menu.replaceChildren(...options.map(option => this.#optionNode({ ...option, selected: option.value === selectedValue })));
      if (focused) [...menu.querySelectorAll('[role=option]')].find(node => node.dataset.value === focused)?.focus();
    }
    const chosen = options.find(option => option.value === selectedValue);
    const value = select.querySelector('.select__value');
    value.replaceChildren();
    if (chosen?.icon) { const icon = document.createElement('span'); icon.className = 'preset-icon'; icon.innerHTML = chosen.icon; value.append(icon); }
    const label = document.createElement('span'); label.textContent = chosen?.label ?? selectedValue ?? ''; value.append(label);
    button.setAttribute('aria-disabled', String(disabled));
    if (reason) button.dataset.reason = reason; else delete button.dataset.reason;
    button.setAttribute('aria-label', `${menu.getAttribute('aria-label')}: ${label.textContent}`);
    if (disabled) this.#closeMenu(select);
  }
  #paintGauge(kind, gauge) {
    const g = this.#copy.gauges, node = this.#q(`[data-gauge="${kind}"]`), level = node.querySelector('.gauge__level');
    const value = fill(g.values[gauge.state] ?? gauge.state, gauge);
    const details = { ...gauge, source: gauge.source?.name, asOf: gauge.source?.asOf, countries: gauge.countries?.join(', '),
      operations: gauge.operations?.join(', ') || g.values.none };
    const detail = fill(g.details[kind]?.[gauge.state] ?? '', details);
    node.querySelector('.gauge__value').textContent = value;
    node.querySelector('.gauge__detail').textContent = fill(g.short?.[kind]?.[gauge.state] ?? detail, details);
    node.dataset.help = 'gauge'; node.dataset.helpText = `${g.labels[kind]} · ${value}${detail ? `: ${detail}` : ''}`;
    node.setAttribute('aria-label', `${g.labels[kind]}: ${value}${detail ? `, ${detail}` : ''}`);
    node.dataset.state = gauge.state;
    const key = String(gauge.fill), changed = level.dataset.fill !== undefined && level.dataset.fill !== key;
    level.dataset.fill = key; level.style.setProperty('--empty', `${100 - gauge.fill}%`);
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (changed && !reduced) {
      level.classList.add('is-splashing');
      clearTimeout(Number(level.dataset.timer)); level.dataset.timer = String(setTimeout(() => level.classList.remove('is-splashing'), 2200));
    }
  }
  #render() {
    if (!this.#dialog.open) return;
    const c = this.#copy.settings, state = this.#ports.state(), draft = this.#draft ?? this.#active ?? activeSelection(state.session);
    const catalog = this.#catalog, info = this.#presetInfo(draft.processingPreset), device = draft.processingPreset === 'device';
    for (const button of this.#all('.preset-option')) {
      const preset = button.dataset.preset, presetInfo = catalog?.presets?.[preset];
      const kind = !catalog ? '' : preset === this.#active?.processingPreset ? '' : !presetInfo?.offered ? 'unavailable' : presetInfo.status === 'available' ? '' : presetInfo.status;
      const reason = kind === 'unavailable' ? presetInfo?.reason ?? 'preset not configured' : kind ? presetInfo?.reason ?? '' : '';
      button.querySelector('.preset-name').textContent = this.#copy.presets[preset];
      button.setAttribute('aria-checked', String(draft.processingPreset === preset)); button.tabIndex = draft.processingPreset === preset ? 0 : -1;
      button.setAttribute('aria-disabled', String(kind === 'unavailable'));
      if (reason) { button.dataset.reason = reason; button.dataset.kind = kind; } else { delete button.dataset.reason; delete button.dataset.kind; }
      const status = button.querySelector('.option-status');
      status.dataset.kind = kind; status.textContent = kind === 'unavailable' ? c.unavailable : kind === 'consent' ? c.consentNeeded : kind === 'limited' ? c.limited : '';
    }
    const models = device ? [] : info?.models ?? [];
    const modelOptions = models.map(option => ({ value: option.id, label: option.label, vendor: option.facts?.vendor,
      status: this.#optionStatus(option), kind: option.status === 'available' ? '' : option.status, reason: option.status === 'available' ? '' : option.reason, help: 'model' }));
    if (!device && draft.model && !models.some(o => o.id === draft.model)) modelOptions.push({ value: draft.model, label: state.session.engine?.model?.label ?? draft.model,
      status: c.notOffered, kind: 'unavailable', reason: 'model not offered', help: 'model' });
    const localModel = this.#ports.connector?.model;
    if (device) this.#renderSelect('model', [{ value: 'local', label: localModel ?? this.#copy.ready.notConnected, help: 'localModel' }], 'local', { disabled: true });
    else this.#renderSelect('model', modelOptions, draft.model, { disabled: !catalog });
    const option = this.#modelOption(), efforts = device ? [] : option?.efforts ?? [];
    const adjustable = efforts.length > 1, effort = this.#q('#settings-effort');
    effort.max = String(Math.max(0, efforts.length - 1)); effort.value = String(Math.max(0, efforts.indexOf(draft.effort)));
    effort.disabled = !adjustable;
    effort.setAttribute('aria-valuetext', c.efforts[draft.effort] ?? draft.effort ?? '');
    this.#q('#settings-effort-value').textContent = draft.effort ? c.efforts[draft.effort] ?? draft.effort : '';
    this.#q('.effort').style.visibility = adjustable ? '' : 'hidden';
    this.#q('.effort-note').style.visibility = adjustable ? 'hidden' : '';
    this.#q('.effort-note').textContent = !catalog ? (this.#loadFailed ? c.loadFailed : c.loading) : device ? c.deviceNote : c.fixedEffort;
    const optional = (name, list, off, offLabel, help) => [{ value: SETTINGS_OFF, label: offLabel, icon: name === 'voice' ? ICONS.text : ICONS.off, help: off },
      ...list.map(o => ({ value: o.id, label: o.label, vendor: o.facts?.vendor, status: this.#optionStatus(o), kind: o.status === 'available' ? '' : o.status,
        reason: o.status === 'available' ? '' : o.reason, help }))];
    this.#renderSelect('voice', optional('voice', device ? [] : info?.voices ?? [], 'voiceOff', c.voiceOff, 'voice'), draft.voice ?? SETTINGS_OFF,
      { disabled: device || !catalog, reason: device ? 'unavailable on device' : '' });
    this.#renderSelect('visuals', optional('visuals', device ? [] : info?.visuals ?? [], 'visualsOff', c.visualsOff, 'visuals'), draft.visuals ?? SETTINGS_OFF,
      { disabled: device || !catalog, reason: device ? 'unavailable on device' : '' });
    const voiceOption = info?.voices?.find(o => o.id === draft.voice) ?? null, visualsOption = info?.visuals?.find(o => o.id === draft.visuals) ?? null;
    const gauges = settingsGauges({ preset: draft.processingPreset, info: info ?? {}, model: option, effort: draft.effort,
      voice: draft.voice === SETTINGS_OFF ? null : voiceOption, visuals: draft.visuals === SETTINGS_OFF ? null : visualsOption });
    for (const kind of GAUGES) this.#paintGauge(kind, gauges[kind]);
    const notice = this.#notice ?? (this.#loadFailed ? { text: c.loadFailed, label: c.reload, action: () => this.reload() } : null);
    this.#q('.notice-area').dataset.kind = notice ? 'notice' : '';
    this.#q('.notice-text').textContent = notice?.text ?? '';
    this.#q('.notice-action').hidden = !notice?.label;
    this.#q('.notice-action').textContent = notice?.label ?? '';
    this.#q('.disclosure-processing').textContent = c.processingDetails[draft.processingPreset] ?? '';
    const consent = state.consent;
    this.#q('.general-consent').textContent = c.consentStates[consent] ?? '';
    this.#q('.general-recommended').disabled = device || !info?.defaults;
    this.#q('.save-status').textContent = this.#status || c.autosave;
    this.#q('.save-retry').dataset.visible = String(this.#failed && !this.#saving);
    this.#q('.done-label').textContent = this.#continue ? c.continue : c.done;
    this.#dialog.setAttribute('aria-busy', String(this.#busy));
    this.#dialog.dataset.saveState = this.#failed ? 'failed' : this.#busy ? 'saving' : this.#status === c.saved ? 'saved' : 'idle';
    this.#showHelp();
  }
}
