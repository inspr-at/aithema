// START local.astro and local.ts, ported as the settings Advanced tab (INSPR D3).
// The host supplies the browser device plugin factory; nothing here reaches a server.
const FAILURES = ['endpoint', 'auth', 'access', 'api', 'cors', 'models', 'response', 'stream', 'limit', 'timeout'];
const failure = error => FAILURES.includes(error?.local) ? error.local
  : { auth: 'auth', 'invalid-output': 'stream', limit: 'limit', deadline: 'timeout' }[error?.code] ?? 'response';
const PROVIDERS = Object.freeze({ mtplx: { endpoint: 'http://127.0.0.1:8000', guide: 'mtplx' }, custom: { endpoint: '', guide: 'custom' } });

export class LocalConnector {
  #copy; #create; #endpoint; #provider = 'mtplx'; #client = null; #status = null; #error = null; #history = [];
  #answer = null; #controller = null; #busy = false; #connecting = false; #generation = 0; #view = 'help'; #root = null; #onChange;
  #copied = '';
  constructor({ copy, create, endpoint = PROVIDERS.mtplx.endpoint, onChange = () => {} }) {
    this.#copy = copy; this.#create = create; this.#endpoint = endpoint; this.#onChange = onChange;
  }
  get client() { return this.#client?.model ? this.#client : null; }
  get model() { return this.#client?.model ?? null; }
  #q(selector) { return this.#root.querySelector(selector); }
  /** (Re)renders into a container; connection and test chat survive a rebuilt dialog. */
  mount(container) {
    const c = this.#copy.local;
    // Static trusted markup only; copy, models and replies are assigned through textContent.
    container.innerHTML = `<div class="local">
      <header class="local__heading"><span class="preset-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="30" height="25" rx="3"/><rect x="4" y="34" width="40" height="5" rx="2.5"/></svg></span>
        <div><h3 data-local="title"></h3><p class="note" data-local="intro"></p></div></header>
      <div class="local__workspace">
        <section class="local__connection" aria-labelledby="local-connection-title"><h4 id="local-connection-title" data-local="connection"></h4>
          <form class="local__form" autocomplete="off">
            <div><label for="local-provider" data-local="provider"></label><select id="local-provider" aria-describedby="local-provider-hint">
              <option value="mtplx"></option><option value="custom"></option></select><p class="hint" id="local-provider-hint"></p></div>
            <div><label for="local-endpoint" data-local="endpoint"></label><input id="local-endpoint" type="url" spellcheck="false" placeholder="http://127.0.0.1:8000" aria-describedby="local-endpoint-hint">
              <p class="hint" id="local-endpoint-hint" data-local="endpointHint"></p></div>
          </form>
          <div class="local__model" hidden><label for="local-model" data-local="model"></label><select id="local-model"></select>
            <button type="button" class="local-disconnect" data-local="disconnect"></button></div>
          <div class="local__actions"><button type="button" class="local-connect"></button>
            <button type="button" class="local-test" aria-expanded="false" aria-controls="local-chat" data-local="testChat"></button>
            <p class="local-status" role="status" aria-live="polite"></p></div>
          <p class="local-error" role="alert" hidden></p><p class="note" data-local="useForConversation"></p>
        </section>
        <div class="local__panels">
          <section class="local__help" id="local-help" tabindex="-1" aria-labelledby="local-quick-title">
            <h4 id="local-quick-title" data-local="quickTitle"></h4><p class="note" data-local="quickIntro"></p><ol class="quick-steps"></ol>
            <details class="setup-details"><summary data-local="setup"></summary>
              <div class="recovery" hidden tabindex="-1" aria-labelledby="local-recovery-title"><h5 id="local-recovery-title" data-local="recoveryTitle"></h5>
                <p class="recovery-error"></p><ol class="recovery-steps"></ol><p class="hint recovery-hint"></p></div>
              <h5 data-local="setupTitle"></h5><p class="note" data-local="setupIntro"></p>
              <ol class="setup-steps"><li><h5 class="step-0"></h5><p data-guide="mtplx" data-local="startMtplx"></p><p data-guide="custom" data-local="startCustom"></p></li>
                <li><h5 class="step-1"></h5><div data-guide="mtplx"><p data-local="grantMtplx"></p><pre><code class="setup-command"></code></pre>
                  <button type="button" class="copy-command" data-local="copyCommand"></button> <span class="copy-status" role="status"></span><p class="hint" data-local="grantMtplxNote"></p></div>
                  <p data-guide="custom" data-local="grantCustom"></p><p class="hint" data-local="originLabel"></p><code class="origin"></code></li>
                <li><h5 class="step-2"></h5><p data-local="addressStep"></p></li><li><h5 class="step-3"></h5><p data-local="connectStep"></p></li></ol>
              <details class="browser-help"><summary data-local="browserTitle"></summary><p data-local="browser"></p></details>
              <details class="protocol-help"><summary data-local="protocolTitle"></summary><p data-local="protocol"></p></details>
              <p class="note" data-local="boundary"></p><p class="hint" data-local="privacy"></p></details>
          </section>
          <section class="local__chat" id="local-chat" hidden aria-labelledby="local-chat-title"><div class="local__chat-head"><h4 id="local-chat-title" data-local="testChat"></h4>
              <span class="badge">TEXT</span><button type="button" class="local-help-link" data-local="setup"></button></div>
            <div class="local__messages" role="log" aria-live="off"></div>
            <form class="local__composer"><label class="visually-hidden" for="local-message" data-local="prompt"></label>
              <textarea id="local-message" rows="3" maxlength="8000"></textarea>
              <div class="actions"><button type="button" class="local-stop" data-local="stop" hidden></button><button type="submit" class="local-send" data-local="send"></button></div></form>
          </section></div></div></div>`;
    this.#root = container.querySelector('.local');
    for (const node of this.#root.querySelectorAll('[data-local]')) node.textContent = c[node.dataset.local];
    this.#root.querySelectorAll('#local-provider option').forEach(option => { option.textContent = c.providers[option.value]; });
    for (const [index, step] of c.steps.entries()) this.#q(`.step-${index}`).textContent = step;
    this.#q('.quick-steps').replaceChildren(...c.quickSteps.map(step => {
      const item = document.createElement('li'), title = document.createElement('h5'), body = document.createElement('p');
      title.textContent = step.title; body.textContent = step.body; item.append(title, body); return item;
    }));
    const origin = container.ownerDocument.defaultView?.location?.origin ?? '';
    this.#q('.origin').textContent = origin;
    this.#q('.setup-command').textContent = `launchctl setenv MTPLX_CORS_ORIGINS '${origin.replace(/'/gu, "'\\''")}'\nopen -a MTPLX`;
    this.#q('#local-message').placeholder = c.placeholder;
    this.#wire(); this.#paint();
  }
  #wire() {
    const c = this.#copy.local;
    this.#q('.local__form').addEventListener('submit', event => { event.preventDefault(); void this.#connect(); });
    this.#q('.local-connect').addEventListener('click', () => void this.#connect());
    this.#q('#local-endpoint').addEventListener('input', event => { this.#endpoint = event.target.value; this.#error = null; this.#status = c.endpointChanged; this.#paint(); });
    this.#q('#local-provider').addEventListener('change', event => {
      this.#provider = PROVIDERS[event.target.value] ? event.target.value : 'mtplx';
      this.#endpoint = PROVIDERS[this.#provider].endpoint; this.#error = null; this.#status = c.endpointChanged; this.#view = 'help'; this.#paint();
    });
    this.#q('#local-model').addEventListener('change', event => {
      try { this.#client?.select(event.target.value); this.#status = null; } catch (error) { this.#fail(error); }
      this.#paint(); this.#onChange();
    });
    this.#q('.local-disconnect').addEventListener('click', () => this.clear());
    this.#q('.local-test').addEventListener('click', () => {
      this.#view = this.#view === 'chat' ? 'help' : 'chat'; this.#paint();
      (this.#view === 'chat' ? this.#q('#local-message') : this.#q('#local-help')).focus({ preventScroll: true });
    });
    this.#q('.local-help-link').addEventListener('click', () => {
      this.#view = 'help'; this.#paint(); this.#q('.setup-details').open = true; this.#q('#local-help').focus({ preventScroll: true });
    });
    this.#q('.copy-command').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.#q('.setup-command').textContent); this.#copied = c.copied; }
      catch { this.#copied = c.copyFailed; }
      this.#q('.copy-status').textContent = this.#copied;
    });
    this.#q('.local__composer').addEventListener('submit', event => { event.preventDefault(); void this.#send(); });
    this.#q('#local-message').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.#send(); }
    });
    this.#q('.local-stop').addEventListener('click', () => this.#controller?.abort());
  }
  async #connect() {
    if (this.#connecting) return;
    const c = this.#copy.local, generation = ++this.#generation;
    this.#connecting = true; this.#error = null; this.#status = c.connecting; this.#paint();
    let candidate;
    try {
      if (!this.#create) throw Object.assign(new Error('unavailable'), { local: 'response' });
      candidate = this.#create({ endpoint: this.#endpoint });
      await candidate.connect({ deadlineAt: Date.now() + 15_000 });
      if (generation !== this.#generation) return;
      this.#client?.disconnect?.(); this.#client = candidate; this.#status = null;
    } catch (error) {
      candidate?.disconnect?.();
      if (generation !== this.#generation) return;
      this.#fail(error); this.#status = c.idle;
    } finally {
      if (generation === this.#generation) { this.#connecting = false; this.#paint(); this.#onChange(); }
    }
  }
  /** Disconnect and forget the test chat, as START's Disconnect & clear. */
  clear() {
    this.#generation++; this.#controller?.abort(); this.#client?.disconnect?.(); this.#client = null;
    this.#history = []; this.#answer = null; this.#busy = false; this.#connecting = false; this.#error = null;
    this.#view = 'help'; this.#status = this.#copy.local.cleared;
    if (this.#root?.isConnected) this.#paint();
    this.#onChange();
  }
  #fail(error) {
    this.#error = failure(error);
    if (!this.#root?.isConnected) return;
    this.#view = 'help'; this.#paint();
    this.#q('.setup-details').open = true;
    this.#q('.browser-help').open = this.#error === 'cors';
    this.#q('.protocol-help').open = ['api', 'models', 'stream'].includes(this.#error);
    this.#q('.recovery').focus({ preventScroll: true });
  }
  async #send() {
    const input = this.#q('#local-message'), content = input.value.trim();
    if (!content || !this.client || this.#busy || this.#view !== 'chat') return;
    if (this.#history.length >= 198 || JSON.stringify(this.#history).length + content.length > 120_000) { this.#fail({ local: 'limit' }); return; }
    const generation = this.#generation, controller = new AbortController();
    this.#controller = controller; this.#busy = true; this.#error = null; this.#status = this.#copy.local.responding;
    this.#history.push({ role: 'user', content }); this.#answer = ''; input.value = ''; this.#paint();
    try {
      for await (const delta of this.client.stream({ messages: [...this.#history] }, { signal: controller.signal, deadlineAt: Date.now() + 180_000 })) {
        if (generation !== this.#generation) return;
        this.#answer += delta; this.#paintMessages();
      }
      if (generation === this.#generation) this.#status = null;
    } catch (error) {
      if (generation !== this.#generation) return;
      if (controller.signal.aborted) this.#status = this.#copy.local.stopped; else { this.#status = null; this.#fail(error); }
    } finally {
      if (generation === this.#generation) {
        if (this.#answer) this.#history.push({ role: 'assistant', content: this.#answer });
        this.#answer = null; this.#busy = false; this.#controller = null;
        if (this.#root?.isConnected) { this.#paint(); if (this.#view === 'chat') this.#q('#local-message').focus({ preventScroll: true }); }
      }
    }
  }
  #paintMessages() {
    const c = this.#copy.local, list = this.#q('.local__messages');
    const rows = [...this.#history, ...(this.#answer !== null ? [{ role: 'assistant', content: this.#answer }] : [])];
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'note'; empty.textContent = c.empty; list.replaceChildren(empty); return; }
    list.replaceChildren(...rows.map(row => {
      const item = document.createElement('div'), who = document.createElement('strong'), text = document.createElement('span');
      item.className = 'message'; who.textContent = row.role === 'user' ? c.you : c.assistant; text.textContent = row.content;
      item.append(who, text); return item;
    }));
    list.scrollTop = list.scrollHeight;
  }
  #paint() {
    if (!this.#root?.isConnected) return;
    const c = this.#copy.local, connected = Boolean(this.client);
    this.#q('#local-provider').value = this.#provider;
    if (this.#q('#local-endpoint').value !== this.#endpoint) this.#q('#local-endpoint').value = this.#endpoint;
    this.#q('#local-provider-hint').textContent = c.providerHints[this.#provider];
    for (const node of this.#root.querySelectorAll('[data-guide]')) node.hidden = node.dataset.guide !== PROVIDERS[this.#provider].guide;
    this.#q('.local__form').hidden = connected;
    for (const selector of ['#local-provider', '#local-endpoint']) this.#q(selector).disabled = this.#connecting;
    this.#q('.local-connect').hidden = connected;
    this.#q('.local-connect').disabled = this.#connecting;
    this.#q('.local-connect').textContent = this.#connecting ? c.connecting : c.connect;
    this.#q('.local__model').hidden = !connected;
    const select = this.#q('#local-model'), models = connected ? this.#client.models?.() ?? [this.model] : [];
    if (select.options.length !== models.length || [...select.options].some((o, i) => o.value !== models[i])) {
      select.replaceChildren(...models.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = id; return option; }));
    }
    if (connected) select.value = this.model;
    select.disabled = this.#busy;
    this.#q('.local-test').disabled = !connected;
    this.#q('.local-test').setAttribute('aria-expanded', String(this.#view === 'chat' && connected));
    this.#q('#local-help').hidden = this.#view === 'chat' && connected;
    this.#q('#local-chat').hidden = !(this.#view === 'chat' && connected);
    this.#q('.local-status').textContent = this.#status ?? (connected ? c.ready.replace('{model}', this.model) : c.idle);
    const error = this.#q('.local-error'), recovery = this.#q('.recovery');
    error.hidden = !this.#error; recovery.hidden = !this.#error;
    error.textContent = this.#error ? c.errors[this.#error] : '';
    if (this.#error) {
      this.#q('.recovery-error').textContent = c.errors[this.#error];
      this.#q('.recovery-steps').replaceChildren(...c.recovery[this.#error].map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
      this.#q('.recovery-hint').textContent = connected ? c.connectedHint : c.retryHint;
    }
    this.#q('#local-message').disabled = !connected;
    this.#q('.local-send').disabled = !connected || this.#busy;
    this.#q('.local-stop').hidden = !this.#busy;
    this.#q('.copy-status').textContent = this.#copied;
    this.#paintMessages();
  }
}
