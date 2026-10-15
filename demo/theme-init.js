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

// A module can load successfully and still throw before mounting its header.
// A bounded handshake covers both cases without painting fallback on the normal path.
function paintFallback() {
  const language = document.querySelector('#locale'), theme = document.querySelector('#theme');
  if (!language || !theme) return;
  const en = language.value === 'en';
  document.documentElement.lang = language.value;
  document.querySelector('#language-value').textContent = language.value.toUpperCase();
  const labels = en ? { light: 'Light', dark: 'Dark', system: 'System' } : { light: 'Hell', dark: 'Dunkel', system: 'System' };
  for (const option of theme.options) option.textContent = labels[option.value];
  document.querySelector('#theme-value').textContent = labels[theme.value];
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
document.addEventListener('DOMContentLoaded', () => {
  document.defaultView?.setTimeout(exposeFallback, 4000);
  if (document.documentElement.hasAttribute('data-host-unavailable')) exposeFallback();
}, { once: true });
