// SPDX-License-Identifier: AGPL-3.0-only
// AIT-135 C2 · the "confirming" state of /confirm-email. Served from the host (CSP script-src 'self');
// the form works without it. One submit only; the button keeps its size (both labels share one grid cell).
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', event => {
    const card = form.closest('.confirm-card');
    if (!card) return;
    if (card.dataset.busy) { event.preventDefault(); return; }
    card.dataset.busy = 'true';
    const button = form.querySelector('button');
    button?.setAttribute('aria-disabled', 'true');
    const status = card.querySelector('[data-confirm-status]');
    if (status) status.textContent = button?.querySelector('.confirm-busy')?.textContent.trim() ?? '';
  });
}
// Back/forward cache: a page restored from history is ready again, never stuck in "confirming".
addEventListener('pageshow', event => {
  if (!event.persisted) return;
  for (const card of document.querySelectorAll('.confirm-card[data-busy]')) {
    delete card.dataset.busy;
    card.querySelector('button')?.removeAttribute('aria-disabled');
    const status = card.querySelector('[data-confirm-status]');
    if (status) status.textContent = '';
  }
});
