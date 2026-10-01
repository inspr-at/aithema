import { readFileSync } from 'node:fs';
import { resolveSettings, LANES, SPEECH_CANDIDATES } from '../../../runtime/settings/index.js';
import { sid } from './helpers.mjs';

export const NOW = '2026-09-30T07:00:00Z';
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/valid/settings.executable.json', import.meta.url))).doc;

/** Synthetic evidence only: this exercises predicates, never qualifies a vendor. */
export function speechSettings(preset = 'eu-e1') {
  const doc = structuredClone(fixture);
  doc.minor = 1;
  const base = doc.provider_templates.find((template) => template.id === doc.presets[preset].lanes.stt.template_ref);
  const baseEvidence = doc.evidence.find((record) => record.id === base.evidence_ref);
  for (const candidate of SPEECH_CANDIDATES.filter((candidate) => candidate.preset === preset)) {
    const template = { ...structuredClone(base), id: `fixture-${candidate.id}`, provider: candidate.provider,
      product: candidate.product, adapter: candidate.id, models: ['fixture-model'], voices: ['fixture-voice'],
      evidence_ref: `evidence-${candidate.id}` };
    doc.provider_templates.push(template);
    doc.evidence.push({ ...structuredClone(baseEvidence), id: template.evidence_ref, template_ref: template.id });
    doc.presets[preset].lanes[candidate.lane] = { template_ref: template.id, model: 'fixture-model' };
    if (preset === 'local-l1') doc.policy.spend.provider_max[candidate.lane] = 0;
  }
  return doc;
}

export function settingsContext(doc, preset = 'eu-e1') {
  const preferences = { preset, voice: { enabled: true, tts_voice: 'fixture-voice' } };
  const resolved = resolveSettings(doc, { now: NOW, preferences });
  const scope = { tid: 'fixture-tenant', pid: 'fixture-project', sid, epoch: 1, participant_refs: ['fixture-person'] };
  const record = { contract: 'aithema.authz', major: 1, minor: 0, min_reader: 0,
    tid: scope.tid, pid: scope.pid, sid, epoch: 1,
    participants: [{ participant_ref: 'fixture-person', role: 'owner', notice_ref: 'fixture-notice' }],
    purposes: ['intake', 'transcription', 'specification', 'design'],
    processors: resolved.processing_inventory.map((entry) => ({ processor_ref: entry.template_ref,
      evidence_ref: entry.evidence_ref, location: entry.execution_location,
      countries: Object.values(resolved.lanes).find((lane) => lane.template_ref === entry.template_ref).countries ?? ['AT'] })),
    settings_sha256: resolved.settings_sha256, basis_label: 'synthetic-test-only', created_at: '2026-09-30T00:00:00Z', withdrawn_at: null };
  const adapters = doc.provider_templates.filter((template) => template.adapter.startsWith('synthetic')).map((template) => ({
    id: template.adapter, products: [template.product], execution_locations: [template.location],
    models: Object.fromEntries(LANES.map((lane) => [lane, template.models])), voices: template.voices, healthy: true,
  }));
  return { now: NOW, preferences, adapters, authorization: { record, scope },
    budget: { currency: 'EUR', spent_micro: { session: 0, principal_day: 0, tenant_day: 0 } } };
}
