export const sessionKey = 'aithema-reset-slice-1-session', localeKey = 'aithema-demo-locale', themeKey = 'aithema-theme';
export function readPreference(key, storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem(key); } catch { return null; }
}
export function remember(key, value, storage) {
  try { (storage ?? globalThis.localStorage)?.setItem(key, value); } catch { /* A blocked store does not block the conversation. */ }
}
export function preferredLocale(storage) {
  const choice = readPreference(localeKey, storage);
  return choice === 'en' ? 'en' : 'de';
}
export function preferredTheme(storage) {
  const choice = readPreference(themeKey, storage);
  return ['light', 'dark'].includes(choice) ? choice : 'system';
}
export function applyTheme(choice, document = globalThis.document) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else document.documentElement.removeAttribute('data-theme');
  document.querySelector('aithema-session')?.setAttribute('theme', choice);
  const select = document.querySelector('#theme'); if (select) select.value = choice;
}
export function mountTheme(document = globalThis.document, storage) {
  applyTheme(preferredTheme(storage), document);
  document.querySelector('#theme')?.addEventListener('change', event => {
    remember(themeKey, event.target.value, storage); applyTheme(event.target.value, document);
  });
}
export function paintUtilities(copy, document = globalThis.document) {
  document.querySelector('#language-label').textContent = copy.host.language;
  document.querySelector('#source').textContent = copy.host.source;
  document.querySelector('#theme-label').textContent = copy.host.theme;
  for (const option of document.querySelector('#theme').options) option.textContent = copy.host.themes[option.value];
  document.querySelector('#new').textContent = copy.host.newConversation;
}
