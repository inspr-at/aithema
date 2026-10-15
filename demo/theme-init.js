// Apply the remembered appearance before the stylesheet paints either page.
try {
  const choice = localStorage.getItem('aithema-theme');
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
} catch { /* System appearance remains available when storage is blocked. */ }

// Native utilities remain operable even if the module host cannot load.
// The host adds conversation updates; these preferences need no module graph.
document.addEventListener('change', event => {
  const control = event.target;
  if (control.id !== 'theme' && control.id !== 'locale') return;
  try { localStorage.setItem(control.id === 'theme' ? 'aithema-theme' : 'aithema-demo-locale', control.value); } catch { /* Storage is optional. */ }
  if (document.documentElement.hasAttribute('data-host-unavailable')) paintFallback();
  if (control.id !== 'theme') return;
  if (control.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = control.value;
  document.querySelector('aithema-session')?.setAttribute('theme', control.value);
  const label = document.querySelector('#theme-value');
  if (label) label.textContent = control.selectedOptions[0].textContent;
});

// Only an actual script failure exposes fallback. Network and session latency
// are unbounded: elapsed time is never evidence that the host failed.
function paintFallback() {
  const language = document.querySelector('#locale'), theme = document.querySelector('#theme');
  if (!language || !theme) return;
  const en = language.value === 'en';
  document.documentElement.lang = language.value;
  document.querySelector('#language-value').textContent = language.value.toUpperCase();
  const labels = en ? { light: 'Light', dark: 'Dark', system: 'System' } : { light: 'Hell', dark: 'Dunkel', system: 'System' };
  for (const option of theme.options) option.textContent = labels[option.value];
  document.querySelector('#theme-value').textContent = labels[theme.value];
  // Keep the native fallback independent of the module graph it replaces.
  const glyphs = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    dark: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  };
  document.querySelector('#theme-icon').innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyphs[theme.value]}</svg>`;
  document.querySelector('#language-label').textContent = en ? 'Language' : 'Sprache';
  document.querySelector('#theme-label').textContent = en ? 'Appearance' : 'Darstellung';
}
function exposeFallback() {
  if (document.documentElement.hasAttribute('data-host-ready')) return;
  document.documentElement.dataset.hostUnavailable = '';
  const language = document.querySelector('#locale'), theme = document.querySelector('#theme');
  try {
    if (language) language.value = localStorage.getItem('aithema-demo-locale') === 'en' ? 'en' : 'de';
    const choice = localStorage.getItem('aithema-theme');
    if (theme) theme.value = ['light', 'dark'].includes(choice) ? choice : 'system';
  } catch { /* Native defaults work without storage. */ }
  // A partially defined component may have no utilities slot yet.
  const component = document.querySelector('aithema-session'), actions = document.querySelector('.host-actions');
  if (component && actions) component.before(actions);
  paintFallback();
}
document.addEventListener('error', event => {
  if (event.target?.matches?.('script[src="/demo/host.js"]')) exposeFallback();
}, true);
document.defaultView?.addEventListener('error', event => {
  // A successfully fetched module can throw before defining the component.
  if (event.filename && new URL(event.filename, location.href).pathname === '/demo/host.js'
      && !customElements.get('aithema-session')) exposeFallback();
});
document.addEventListener('DOMContentLoaded', () => {
  if (document.documentElement.hasAttribute('data-host-unavailable')) exposeFallback();
}, { once: true });
