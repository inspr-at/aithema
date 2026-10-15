import '/packages/ui/src/session-element.js';
import { en } from '/packages/ui/src/i18n/en.js';

// This tiny consumer host uses the reference UI and the real HTTP handlers.
const token = crypto.randomUUID(), headers = { 'x-aithema-session-token': token };
async function api(path, body) {
  const response = await fetch(path, { headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Host request failed: ${response.status}`);
  return response.json();
}
const session = await api('/api/sessions', { locale: 'en' }), base = `/api/sessions/${session.id}`;
const component = document.querySelector('aithema-session');
component.configure({ copy: en, session, sessionToken: token, baseUrl: '' });
const descriptor = await api(`${base}/consent`);
for (const item of descriptor.items) {
  const label = document.createElement('label'), box = document.createElement('input'), copy = document.createElement('span');
  box.type = 'checkbox'; box.value = item.id; copy.textContent = `${item.title} ${item.recipients} ${item.text}`;
  label.append(box, copy); document.querySelector('#items').append(label);
}
document.querySelector('#consent').onsubmit = async event => {
  event.preventDefault();
  const items = [...document.querySelectorAll('#items input:checked')].map(box => box.value);
  const result = await api(`${base}/consent`, { granted: true, processing: { contract: descriptor.contract, items } });
  component.receive(result.event);
  component.configure({ copy: en, session: await api(base), sessionToken: token, baseUrl: '' });
  document.querySelector('#consent-status').textContent = 'External model processing allowed';
};
// The reference component owns SSE replay and reconnection.
document.documentElement.dataset.ready = 'true';
