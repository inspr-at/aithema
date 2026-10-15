import { icon } from './utility-icons.js';

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
  const sign = document.querySelector('#theme-icon'); if (sign) sign.innerHTML = icon({ light: 'sun', dark: 'moon', system: 'system' }[choice] ?? 'system');
  const themeValue = document.querySelector('#theme-value'); if (themeValue) themeValue.textContent = select?.selectedOptions[0]?.textContent ?? '';
  if (select?.dataset.label) select.title = `${select.dataset.label}: ${select.selectedOptions[0]?.textContent ?? ''}`;
}
export function mountTheme(document = globalThis.document, storage) {
  applyTheme(preferredTheme(storage), document);
  document.querySelector('#theme')?.addEventListener('change', event => {
    remember(themeKey, event.target.value, storage); applyTheme(event.target.value, document);
  });
}
export function paintUtilities(copy, document = globalThis.document) {
  for (const chevron of document.querySelectorAll('.utility-chevron')) chevron.innerHTML = icon('chevron');
  const account = document.querySelector('#demo-account summary');
  if (account) {
    document.querySelector('#demo-account-icon').innerHTML = icon('person');
    account.title = copy.host.slots.account; account.setAttribute('aria-label', copy.host.slots.account);
  }
  document.querySelector('#language-label').textContent = copy.host.language;
  const language = document.querySelector('#locale');
  const languageValue = document.querySelector('#language-value'); if (languageValue) languageValue.textContent = language.value.toUpperCase();
  language.title = copy.host.language; language.closest('label').title = copy.host.language;
  const globe = document.querySelector('#language-icon'); if (globe) globe.innerHTML = icon('globe');
  document.querySelector('#source').textContent = copy.host.slots.source;
  document.querySelector('#theme-label').textContent = copy.host.theme;
  const theme = document.querySelector('#theme');
  for (const option of theme.options) option.textContent = copy.host.themes[option.value];
  theme.dataset.label = copy.host.theme; theme.title = `${copy.host.theme}: ${copy.host.themes[theme.value]}`;
  theme.closest('label').title = theme.title;
  const themeValue = document.querySelector('#theme-value'); if (themeValue) themeValue.textContent = copy.host.themes[theme.value];
  const fresh = document.querySelector('#new'); if (fresh) fresh.textContent = copy.host.newConversation;
}
