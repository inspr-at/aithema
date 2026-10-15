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
  if (control.id !== 'theme') return;
  if (control.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = control.value;
  document.querySelector('aithema-session')?.setAttribute('theme', control.value);
  const label = document.querySelector('#theme-value');
  if (label) label.textContent = control.selectedOptions[0].textContent;
});

// If the module graph fails, expose the native fallback controls again. Until
// definition, light-DOM utilities have no header slot and must not paint there.
window.addEventListener('error', event => {
  if (event.target?.matches?.('script[src="/demo/host.js"]')) {
    document.documentElement.dataset.hostUnavailable = '';
  }
}, true);
