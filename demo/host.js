import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { postJson } from '../packages/ui/src/post-json.js';
const component = document.querySelector('aithema-session');
const key = 'aithema-reset-slice-1-session';
let processingPreset = 'best';
async function open(fresh = false) {
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await postJson('/api/sessions', { processingPreset });
    if (!response.ok) throw new Error();
    const session = await response.json(); localStorage.setItem(key, session.id);
    processingPreset = session.processingPreset ?? 'best';
    component.configure({ copy: en, session, deviceReasoning: processingPreset === 'device'
      ? createDeviceReasoning({ endpoint: document.querySelector('#device-endpoint').value }) : undefined });
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = 'Could not restore the demo. Reload to retry.'; }
}
const binding = await fetch('/demo/config').then(r => r.json());
document.querySelector('#provider').textContent = binding.label;
component.addEventListener('aithema-preset', event => { processingPreset = event.detail.processingPreset; void open(true); });
document.querySelector('#new').addEventListener('click', () => void open(true));
await open();
