/**
 * Progressive enhancement for the server-rendered text session (AIT-43).
 * Without this script every form still works as a plain POST + redirect. With
 * it, sending a message or confirming items updates the page in place so the
 * transcript live region and the durability status announce what changed.
 * No framework, no inline script, same-origin requests only.
 */

export const REFRESH_REGIONS = Object.freeze(['text-current-question', 'text-confirmation', 'text-review']);
export const POLL_MS = 2000;
export const POLL_LIMIT = 15;

/** Transcript entries that are not on the page yet, in order. */
export function unseenSeqs(known, incoming) {
  const seen = new Set(known);
  return [...incoming].filter((seq) => !seen.has(seq));
}

function pathOnly(win) {
  return win.location.pathname;
}

export function bindTextUi(doc = document, win = window, fetchImpl = globalThis.fetch) {
  const log = doc.getElementById('text-transcript');
  if (!log || typeof fetchImpl !== 'function') return null;
  let polling = 0;

  const announce = (message) => {
    const live = doc.getElementById('text-live');
    if (!live || !message) return;
    live.textContent = '';
    win.setTimeout(() => { live.textContent = message; }, 50);
  };

  const showError = (message) => {
    let box = doc.getElementById('page-error');
    if (!box) {
      box = doc.createElement('p');
      box.id = 'page-error';
      box.className = 'error';
      box.setAttribute('role', 'alert');
      box.tabIndex = -1;
      doc.getElementById('text-status')?.after(box);
    }
    box.textContent = message;
    box.focus();
  };

  const clearError = () => doc.getElementById('page-error')?.remove();

  async function refresh({ preserveFocus = true } = {}) {
    const response = await fetchImpl(pathOnly(win), { credentials: 'same-origin', headers: { accept: 'text/html' } });
    if (!response.ok) throw new Error('refresh failed');
    const page = new win.DOMParser().parseFromString(await response.text(), 'text/html');
    const known = [...log.querySelectorAll('[data-seq]')].map((node) => node.getAttribute('data-seq'));
    const incoming = [...page.querySelectorAll('#text-transcript [data-seq]')];
    const fresh = new Set(unseenSeqs(known, incoming.map((node) => node.getAttribute('data-seq'))));
    for (const node of incoming) {
      if (!fresh.has(node.getAttribute('data-seq'))) continue;
      log.querySelector('[data-empty]')?.remove();
      log.append(doc.importNode(node, true));
    }
    if (fresh.size) log.scrollTop = log.scrollHeight;
    const nextDurability = page.getElementById('text-durability');
    const durability = doc.getElementById('text-durability');
    if (nextDurability && durability) {
      durability.innerHTML = nextDurability.innerHTML;
      durability.setAttribute('data-durability', nextDurability.getAttribute('data-durability'));
    }
    for (const id of REFRESH_REGIONS) {
      const next = page.getElementById(id);
      const current = doc.getElementById(id);
      // Polling must not detach a control (or a review link) being used with
      // the keyboard. Its displayed content and digest stay together until
      // focus leaves; the server still rejects a stale confirmation binding.
      if (next && current && !(preserveFocus && current.contains(doc.activeElement))) {
        current.replaceWith(doc.importNode(next, true));
      }
    }
    const question = [...log.querySelectorAll('[data-seq]')].filter((node) => fresh.has(node.getAttribute('data-seq')))
      .flatMap((node) => [...node.querySelectorAll('[data-canonical-question]')]).at(-1);
    if (fresh.size) {
      announce(question
        ? `New reply from the AI assistant. ${question.textContent.trim()}`
        : 'New reply from the AI assistant.');
    }
    return durability?.getAttribute('data-durability');
  }

  async function poll(token) {
    for (let attempt = 0; attempt < POLL_LIMIT && token === polling; attempt += 1) {
      await new Promise((resolve) => { win.setTimeout(resolve, POLL_MS); });
      if (token !== polling) return;
      try {
        if (await refresh() !== 'pending') return;
      } catch {
        return;
      }
    }
  }

  async function post(form) {
    const body = new win.URLSearchParams(new win.FormData(form));
    const response = await fetchImpl(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    let data = {};
    try { data = await response.json(); } catch { /* keep empty */ }
    return { ok: response.ok, data };
  }

  async function onSubmit(event) {
    const form = event.target;
    const isTurn = form?.matches?.('[data-text-turn-form]');
    if (!isTurn && !form?.matches?.('[data-text-confirm-form]')) return;
    event.preventDefault();
    form.setAttribute('aria-busy', 'true');
    clearError();
    try {
      const { ok, data } = await post(form);
      if (!ok) {
        showError(data.error || 'The request was refused.');
        await refresh().catch(() => {});
        return;
      }
      announce(data.message);
      const token = ++polling;
      const level = await refresh({ preserveFocus: false });
      // Refresh replaces the confirmation region, so focus moves afterwards:
      // back to the composer after a message, to the section heading after a
      // confirmation (the confirmed item's own button is gone).
      if (isTurn) {
        form.elements.message.value = '';
        form.elements.message.focus();
      } else {
        const heading = doc.getElementById('text-confirmation-h');
        if (heading) { heading.tabIndex = -1; heading.focus(); }
      }
      if (level === 'pending') void poll(token);
    } catch {
      showError('Could not reach the server. Your input was not lost on this page; check the durability indicator before you retry.');
    } finally {
      form.removeAttribute('aria-busy');
    }
  }

  doc.addEventListener('submit', onSubmit);
  return Object.freeze({ destroy() { polling += 1; doc.removeEventListener('submit', onSubmit); } });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bindTextUi();
}
