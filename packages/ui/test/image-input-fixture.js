import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { isImageFile } from '../src/uploads.js';

const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'FormData']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, copy = en, available = true, options = {}) {
  // Match runtime.matrix: paused imageInput projects only available/reason;
  // consentPurposes belongs to generated visuals, not image input.
  const c = document.createElement('aithema-session'), session = options.session ?? createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput', 'images'].map(key => [key,
    { available: key === 'imageInput' ? available : key === 'uploads' ? options.documentsAvailable ?? true : true, reason: key === 'imageInput' && !available ? options.imageReason ?? 'current processing consent required' : key === 'uploads' && options.documentsAvailable === false ? 'current processing consent required' : null,
      ...(key === 'imageInput' && options.imageReason === 'session paused' ? { unpaused: { available: true, reason: null } } : {}) }])) };
  const configuredImageReason = options.imageReason;
  const calls = [], asks = []; let imageGranted = available, documentsGranted = options.documentsAvailable ?? true;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    if (url.endsWith('/uploads') && options.method === 'POST') {
      const files = options.body.getAll('files');
      return Response.json({ events: files.map((file, index) => ({ sessionId: session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
        id: `${isImageFile(file) ? 'fixture-image' : 'fixture-document'}${files.length > 1 ? '-' + index : ''}`, filename: file.name,
        kind: isImageFile(file) ? 'image' : 'document', state: isImageFile(file) ? 'staged-pending' : 'accepted',
        mediaType: file.type, bytes: file.size, at: new Date(0).toISOString() } })) }, { status: 202 });
    }
    if (url.endsWith('/uploads')) return Response.json({ uploads: [] });
    if (url.endsWith('/turns') && options.method === 'POST') { const body = JSON.parse(options.body);
      return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments } }); }
    const snapshot = c.session;
    snapshot.featureMatrix.best.imageInput = { available: imageGranted, reason: imageGranted ? null : configuredImageReason ?? 'current processing consent required',
      ...(configuredImageReason === 'session paused' ? { unpaused: { available: true, reason: null } } : {}) };
    snapshot.featureMatrix.best.uploads = { available: documentsGranted, reason: documentsGranted ? null : 'current processing consent required' };
    if (url.endsWith('/consent')) return Response.json({ consentRevision: snapshot.consentRevision, selected: imageGranted ? ['images', 'image-input'] : ['images'], features: { images: ['images'], imageInput: ['image-input'] } });
    return Response.json(snapshot);
  });
  c.addEventListener('aithema-consent', event => asks.push(event.detail));
  c.configure({ copy, session, sessionToken: 'fixture', ...options }); document.body.append(c); t.after(() => c.remove());
  return { c, root: c.shadowRoot, calls, asks, grantDocuments() { documentsGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['uploads'], removed: [] } }); }, grantImages() { imageGranted = true; c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } }); } };
}
async function choose(root, files) {
  const input = root.querySelector('.attach-input'), transfer = new window.DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new window.Event('change')); await tick(); await tick();
}

export { window, tick, fixture, choose };
