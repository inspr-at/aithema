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

// Keep startup recovery independent of the module graph it replaces.
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
  const error = document.querySelector('#error');
  if (error) {
    const message = document.createElement('span'), reload = document.createElement('button');
    message.textContent = en ? 'The page could not be loaded.' : 'Die Seite konnte nicht geladen werden.';
    reload.type = 'button';
    reload.textContent = en ? 'Reload page' : 'Seite neu laden';
    reload.addEventListener('click', () => location.reload());
    error.replaceChildren(message, reload);
  }
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
  if (component) {
    const title = component.querySelector('h1[slot="brand"]');
    if (title) component.before(title);
    if (actions) component.before(actions);
    document.querySelector('.aithema-first-paint')?.remove();
  }
  paintFallback();
}
document.addEventListener('aithema-host-failed', exposeFallback);
document.addEventListener('error', event => {
  if (event.target?.matches?.('script[src="/demo/host.js"]')) exposeFallback();
}, true);
document.defaultView?.addEventListener('error', event => {
  // Once host code starts, its explicit failure signal owns startup errors.
  if (!document.documentElement.hasAttribute('data-host-started') && isHostModule(event.filename)) exposeFallback();
});
// Only failures attributed to this origin's host module graph count. Unrelated
// scripts and extensions can reject during startup without breaking the host.
function isHostModule(source) {
  try {
    const url = new URL(source, location.href);
    return url.origin === location.origin && /^\/(demo|packages|plugins)\//.test(url.pathname);
  } catch { return false; }
}
document.defaultView?.addEventListener('unhandledrejection', event => {
  if (document.documentElement.hasAttribute('data-host-started')) return;
  const reason = event.reason;
  if (isHostModule(reason?.fileName) || (typeof reason?.stack === 'string'
    && (reason.stack.match(/https?:\/\/[^\s)]+/g) ?? []).some(isHostModule))) exposeFallback();
});
document.addEventListener('DOMContentLoaded', () => {
  if (document.documentElement.hasAttribute('data-host-unavailable')) exposeFallback();
}, { once: true });
// Start before DOMContentLoaded: a stalled module graph can itself hold that event.
// Definition cancels the deadline; slow session/configuration requests do not count.
const definitionDeadline = setTimeout(() => {
  if (document.querySelector('aithema-session') && !customElements.get('aithema-session')) exposeFallback();
}, 15_000);
customElements.whenDefined('aithema-session').then(() => clearTimeout(definitionDeadline));
