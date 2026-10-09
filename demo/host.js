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
    document.querySelector('#consent-status').textContent = session.consentWithdrawn ? 'Consent withdrawn.' : 'Grant consent before mock processing.';
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = 'Could not restore the demo. Reload to retry.'; }
}
const binding = await fetch('/demo/config').then(r => r.json());
document.querySelector('#provider').textContent = binding.label;
component.addEventListener('aithema-preset', event => { processingPreset = event.detail.processingPreset; void open(true); });
document.querySelector('#new').addEventListener('click', () => void open(true));
for (const [selector, granted] of [['#grant', true], ['#revoke', false]]) {
  document.querySelector(selector).addEventListener('click', async () => {
    const button = document.querySelector(selector), id = component.session.id; button.disabled = true;
    try {
      const response = await postJson(`/api/sessions/${id}/consent`, { granted });
      if (!response.ok) throw new Error();
      const ack = await response.json();
      if (component.session.id !== id) return;
      component.receive(ack.event);
      document.querySelector('#consent-status').textContent = granted ? 'Mock processing allowed.' : 'Consent withdrawn. Running work stopped.';
    } catch { document.querySelector('#consent-status').textContent = 'Could not save consent. Try again.'; }
    finally { button.disabled = false; }
  });
}
await open();
