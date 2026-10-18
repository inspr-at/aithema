import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { SettingsDialog } from '../src/settings-dialog.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
globalThis.document = window.document;
after(() => window.happyDOM.close());
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
function fixture(t, { copy = de, active = false, status = 'available', fail = false } = {}) {
  const session = { processingPreset: 'best', settings: { revision: 0, model: 'mock', effort: 'none', voice: 'elevenlabs', visuals: 'off' } };
  let selected = [], starts = 0, stops = 0;
  const saves = [], dialog = document.createElement('dialog'); document.body.append(dialog);
  const voice = () => ({ id: 'grok-voice', label: 'Grok Voice (xAI)', status, reason: status === 'consent' ? 'current processing consent required' : status === 'unavailable' ? 'not configured' : null,
    facts: { liveQualification: 'unverified', consentItem: { id: 'voice-xai', version: 1 }, plugin: 'grok-voice', vendor: 'xAI', qualification: 'unverified', capabilities: { sendText: 'native' },
      providerProcessing: { recipientCountries: ['US'], processingCountries: null, verification: 'current', vendor: 'xAI' } } });
  const catalog = () => ({ processingPreset: 'best', settings: session.settings, presets: { best: { offered: true, status: 'available', defaults: session.settings,
    models: [{ id: 'mock', label: 'Mock', efforts: ['none'], facts: {} }], voices: [{ id: 'elevenlabs', label: 'ElevenLabs', status: 'available', facts: {} }, voice()], visuals: [] } } });
  const editor = new SettingsDialog({ dialog, copy, ports: {
    state: () => ({ session, voiceActive: active }), catalog: async () => catalog(),
    save: async body => { saves.push(body); if (fail) return { ok: false, error: 'network' };
      session.settings = { ...body, revision: session.settings.revision + 1 }; return { ok: true, ack: { processingPreset: 'best', settings: session.settings } }; },
    endCall: async () => { stops++; active = false; }, newConversation: () => { starts++; },
    consentDocument: async () => ({ contract: 'fixture', items: [{ id: 'voice-xai', version: 1, title: 'Grok', recipients: 'xAI', text: 'Speech' }], selected, features: { voice: ['voice-xai'] } }),
    saveConsent: async body => { selected = body.processing.items; if (selected.includes('voice-xai')) status = 'available'; },
  } });
  t.after(() => { editor.close(); dialog.remove(); });
  const q = s => dialog.querySelector(s), choose = () => { q('#settings-select-voice').click(); q('[data-value="grok-voice"]').click(); };
  return { editor, q, choose, saves, session, counts: () => ({ starts, stops }) };
}
for (const [locale, copy] of Object.entries({ de, en })) test(`AIT-350 ${locale}: two-line provider, unverified vial, honest processing detail, reload`, async t => {
  const h = fixture(t, { copy }); h.editor.open(); await tick(); h.choose(); await tick();
  assert.equal(h.q('#settings-select-voice .select__detail').textContent, locale === 'de' ? 'Noch nicht im Live-Betrieb geprüft' : 'Not yet qualified in live use');
  assert.ok(h.q('[data-gauge="voice"]').classList.contains('gauge--unrated'));
  assert.equal(h.q('.disclosure-recipient').textContent, locale === 'de' ? 'Anbieter mit Sitz in den USA (xAI)' : 'Provider based in the US (xAI)');
  assert.equal(h.q('.disclosure-geography').textContent, locale === 'de' ? 'Verarbeitung international, kein zugesicherter Verarbeitungsort' : 'Processed internationally; no guaranteed processing location');
  await h.editor.reload(); assert.equal(h.session.settings.voice, 'grok-voice'); assert.equal(h.saves.length, 1); assert.equal(h.counts().starts, 0);
});
test('AIT-350: in-call cancel restores choice; explicit switch stops once, returns focus and never starts', async t => {
  const h = fixture(t, { active: true }); h.editor.open(); await tick(); h.choose(); await tick();
  assert.equal(h.saves.length, 0); assert.equal(h.q('.voice-switch-confirm').hidden, false);
  h.q('.voice-switch-cancel').click(); await tick();
  assert.equal(h.session.settings.voice, 'elevenlabs'); assert.equal(h.q('#settings-select-voice'), document.activeElement);
  assert.deepEqual(h.counts(), { starts: 0, stops: 0 });
  h.choose(); await tick(); h.q('.voice-switch-apply').click(); await tick();
  assert.equal(h.session.settings.voice, 'grok-voice'); assert.deepEqual(h.counts(), { starts: 0, stops: 1 });
  assert.equal(document.activeElement, h.q('#settings-select-voice'));
});
test('AIT-350: failed save retains acknowledged provider and focus', async t => {
  const h = fixture(t, { fail: true, active: true }); h.editor.open(); await tick(); h.choose(); await tick();
  h.q('.voice-switch-apply').click(); await tick();
  assert.equal(h.session.settings.voice, 'elevenlabs'); assert.equal(h.q('.save-retry').dataset.visible, 'true');
  assert.equal(document.activeElement, h.q('#settings-select-voice')); assert.equal(h.counts().starts, 0);
});
test('AIT-350: unavailable is disabled with short reason and full tooltip', async t => {
  const h = fixture(t, { status: 'unavailable' }); h.editor.open(); await tick();
  const option = h.q('[data-value="grok-voice"]');
  assert.equal(option.getAttribute('aria-disabled'), 'true'); assert.equal(option.querySelector('.option-detail').textContent, 'Nicht eingerichtet');
  assert.ok(option.title); h.choose(); await tick(); assert.equal(h.saves.length, 0);
});
test('AIT-350: consent precedes provider save and applies only after voice-xai v1 grant', async t => {
  const h = fixture(t, { status: 'consent' }); h.editor.open(); await tick(); h.choose(); await tick();
  assert.equal(h.saves.length, 0); assert.equal(h.session.settings.voice, 'elevenlabs');
  const checkbox = h.q('input[value="voice-xai"]'); assert.ok(checkbox); checkbox.checked = true;
  h.q('.done').click(); await tick();
  assert.equal(h.saves.length, 1); assert.equal(h.session.settings.voice, 'grok-voice'); assert.equal(h.counts().starts, 0);
});
