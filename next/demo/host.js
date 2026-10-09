import '../packages/ui/src/session-element.js';
import { en } from '../packages/ui/src/i18n/en.js';
const component = document.querySelector('aithema-session');
const key = 'aithema-reset-slice-1-session';
async function open(fresh = false) {
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new Error();
    const session = await response.json(); localStorage.setItem(key, session.id);
    component.configure({ copy: en, session });
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = 'Could not restore the demo. Reload to retry.'; }
}
const binding = await fetch('/demo/config').then(r => r.json());
document.querySelector('#provider').textContent = binding.label;
document.querySelector('#new').addEventListener('click', () => void open(true));
await open();
