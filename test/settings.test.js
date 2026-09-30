import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { canExecute, canonicalJson, sha256Hex, validate, validateSchema } from '../contracts/validate.js';
import { CAPABILITY_REASONS, COUNTRY_SETS, LANES, PRESETS, SettingsError, computeCapabilityMatrix, resolveSettings } from '../runtime/settings/index.js';

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const validFixture = load('../contracts/fixtures/valid/settings.executable.json');
const rejected = load('../runtime/settings/fixtures/rejected.json');
const NOW = rejected.now;
const settings = () => structuredClone(validFixture.doc);

/** Server-owned synthetic metadata and a contract-valid host authorization. */
function contextFor(doc, preset = 'local-l1', enabled = true) {
  const selection = doc.presets[preset].lanes.tts;
  const template = doc.provider_templates.find((t) => t.id === selection?.template_ref);
  const preferences = { preset, voice: { enabled, tts_voice: template?.voices[0] ?? null } };
  const resolved = resolveSettings(doc, { now: NOW, preferences });
  const adapters = doc.provider_templates.map((t) => ({
    id: t.adapter,
    products: [t.product],
    execution_locations: [t.location],
    models: Object.fromEntries(LANES.map((lane) => [lane, [...t.models]])),
    voices: [...t.voices],
    healthy: true,
  }));
  const scope = { tid: 'synthetic-tenant', pid: 'synthetic-project', sid: '0f8e9d2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f', epoch: 3, participant_refs: ['synthetic-person'] };
  const record = {
    contract: 'aithema.authz', major: 1, minor: 0, min_reader: 0,
    tid: scope.tid, pid: scope.pid, sid: scope.sid, epoch: scope.epoch,
    participants: [{ participant_ref: scope.participant_refs[0], role: 'owner', notice_ref: 'synthetic-notice' }],
    purposes: ['intake', 'specification', 'design', 'transcription'],
    processors: resolved.processing_inventory.map((entry) => ({
      processor_ref: entry.template_ref,
      evidence_ref: entry.evidence_ref,
      location: entry.execution_location,
      countries: Object.values(resolved.lanes).find((lane) => lane.template_ref === entry.template_ref).countries ?? ['AT'],
    })),
    settings_sha256: resolved.settings_sha256,
    basis_label: 'synthetic-host-basis', created_at: '2026-09-30T00:00:00Z', withdrawn_at: null,
  };
  assert.equal(validate('aithema.authz', record).ok, true);
  return { now: NOW, preferences, adapters, authorization: { record, scope }, budget: { currency: 'EUR', spent_micro: { session: 0, principal_day: 0, tenant_day: 0 } } };
}

function assertAllDisabled(matrix, reason) {
  for (const lane of LANES) {
    assert.equal(matrix.lanes[lane].enabled, false, lane);
    assert.ok(matrix.lanes[lane].reasons.includes(reason), `${lane}: ${matrix.lanes[lane].reasons}`);
  }
  assert.equal(matrix.voice.enabled, false);
}

function assertAllEnabled(matrix) {
  for (const lane of LANES) assert.deepEqual(matrix.lanes[lane].reasons, [], lane);
  assert.equal(matrix.voice.enabled, true);
  assert.equal(matrix.text_capture.enabled, true);
}

describe('AIT-40 (a), (c), (d), (e): strict contract and executable fixtures', () => {
  it('registers a valid executable v1 example, with synthetic references only', () => {
    const doc = settings();
    assert.equal(validate('aithema.settings', doc).ok, true);
    assert.deepEqual(canExecute(doc), { ok: true });
    assert.deepEqual(resolveSettings(doc, { now: NOW }).issues, []);
    assert.equal(validFixture.contract, 'aithema.settings');
    assert.match(validFixture.label, /synthetic/);
    assert.equal(doc.voice.transport, 'inline');
    assert.deepEqual(Object.keys(doc.presets), PRESETS);
    for (const preset of PRESETS) assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, preset)));
  });

  for (const name of readdirSync(new URL('../contracts/fixtures/invalid/', import.meta.url)).filter((name) => name.startsWith('settings.'))) {
    const fixture = load(`../contracts/fixtures/invalid/${name}`);
    it(`SCHEMA REJECTED: ${name}`, () => {
      assert.equal(fixture.contract, 'aithema.settings');
      assert.ok(fixture.expect.schema);
      assert.ok(validateSchema(fixture.contract, fixture.doc).some((error) => error.includes(fixture.expect.schema)));
      assert.throws(() => resolveSettings(fixture.doc, { now: NOW }), (error) => error instanceof SettingsError && error.code === 'settings_invalid');
    });
  }

  it('rejects unsupported major through canExecute, before schema execution', () => {
    const doc = { ...settings(), major: 2 };
    assert.deepEqual(canExecute(doc), { ok: false, code: 'contract_too_new' });
    assert.throws(() => resolveSettings(doc), { code: 'contract_too_new' });
  });

  it('rejects a too-new min_reader and accepts a known shape in a newer minor', () => {
    const doc = { ...settings(), minor: 1, min_reader: 1 };
    assert.equal(validate('aithema.settings', doc).ok, true);
    assert.throws(() => resolveSettings(doc), { code: 'contract_too_new' });
    assert.deepEqual(resolveSettings(doc, { now: NOW, reader: { 'aithema.settings': { major: 1, minor: 1 } } }).issues, []);
    assert.deepEqual(resolveSettings({ ...doc, min_reader: 0 }, { now: NOW }).issues, []);
  });

  it('keeps validation strict even when the min_reader is compatible', () => {
    const doc = { ...settings(), minor: 1, color: 'blue' };
    assert.equal(canExecute(doc).ok, true);
    assert.throws(() => resolveSettings(doc), { code: 'settings_invalid' });
    const invalidEnvelope = { ...settings(), min_reader: 1 };
    assert.ok(validate('aithema.settings', invalidEnvelope).invariants.includes('envelope.min_reader_le_minor'));
    assert.throws(() => resolveSettings(invalidEnvelope, { reader: { 'aithema.settings': { major: 1, minor: 1 } } }), { code: 'settings_invalid' });
  });

  it('does not alter the stored document and uses the foundation RFC 8785 digest', () => {
    const doc = settings();
    const before = JSON.stringify(doc);
    const result = resolveSettings(doc, { now: NOW });
    assert.equal(JSON.stringify(doc), before);
    assert.equal(result.settings_sha256, sha256Hex(canonicalJson(doc)));
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    assert.equal(resolveSettings(reordered, { now: NOW }).settings_sha256, result.settings_sha256);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.lanes.reaction.template.secret), true);
    doc.provider_templates[0].secret.ref = 'secret:changed-after-resolution';
    assert.equal(result.processing_inventory[0].secret.ref, 'secret:synthetic-local');
  });

  it('names exactly the qualified operator account and its attested typed reference in the inventory', () => {
    const result = resolveSettings(settings(), { now: NOW });
    assert.deepEqual(result.processing_inventory, [{
      template_ref: 'synthetic-local', account_ref: 'operator-local', evidence_ref: 'evidence-synthetic-local',
      secret: { kind: 'service_token_ref', ref: 'secret:synthetic-local', account_ref: 'operator-local', owner: 'operator' },
      execution_location: 'operator',
    }]);
  });

  for (const key of ['provider_templates', 'evidence']) {
    it(`refuses ambiguous duplicate ${key} identities`, () => {
      const doc = settings();
      doc[key].push({ ...structuredClone(doc[key][0]), ...(key === 'evidence' ? { expires_at: '2027-01-01T00:00:00Z' } : { endpoint: 'http://127.0.0.1:9' }) });
      assert.deepEqual(validateSchema('aithema.settings', doc), []);
      assert.throws(() => resolveSettings(doc), { code: 'settings_invalid' });
    });
  }

  for (const preferences of [
    { account_ref: 'tenant-account' }, { voice: { transport: 'direct' } }, { preset: 'fallback' },
    { voice: null }, { voice: { enabled: 'true' } }, { voice: { tts_voice: 'untyped voice value' } },
    { language: 'xx-unrecognized' }, { language: ['de'] }, { address: 'anything' }, null,
  ]) {
    it(`refuses invalid or credential-bearing session preferences ${JSON.stringify(preferences)}`, () => {
      assert.throws(() => resolveSettings(settings(), { now: NOW, preferences }), { code: 'settings_invalid' });
    });
  }

  for (const now of ['2026-02-30T00:00:00Z', '2026-09-30T24:00:00Z', '2026-09-30T12:00:60Z', '2026-09-30T12:00:00+01:00', '', NaN, null]) {
    it(`refuses an invalid check time ${JSON.stringify(now)}`, () => {
      assert.throws(() => resolveSettings(settings(), { now }), TypeError);
    });
  }
});

describe('AIT-40 (a), (b), (c), (e): labelled semantic rejected fixtures', () => {
  assert.match(rejected.label, /SEMANTIC REJECTED/);
  for (const fixture of rejected.cases) {
    it(`SEMANTIC REJECTED: ${fixture.name}`, () => {
      const doc = settings();
      for (const [path, value] of fixture.replacements) {
        let target = doc;
        for (const key of path.slice(0, -1)) target = target[key];
        target[path.at(-1)] = structuredClone(value);
      }
      assert.equal(validate('aithema.settings', doc).ok, true, 'semantic rejection must be schema-valid');
      const result = resolveSettings(doc, { now: NOW, preferences: { preset: fixture.preset } });
      assert.ok(result.issues.some((issue) => issue.preset === fixture.preset && issue.reason === fixture.reason), fixture.name);
      assert.ok(Object.values(result.lanes).some((lane) => !lane.enabled && lane.reasons.includes(fixture.reason)));
      assert.ok(CAPABILITY_REASONS.includes(fixture.reason));
    });
  }
});

describe('AIT-40 (b): evidence, residency, licences and revalidation', () => {
  for (const preset of PRESETS) {
    it(`expiry at the exclusive boundary disables all five affected lanes in ${preset}`, () => {
      const doc = settings();
      const selectedId = doc.presets[preset].lanes.reaction.template_ref;
      doc.evidence.find((record) => record.template_ref === selectedId).expires_at = '2026-09-30T12:00:01Z';
      const context = contextFor(doc, preset);
      assertAllEnabled(computeCapabilityMatrix(doc, context));
      const expired = computeCapabilityMatrix(doc, { ...context, now: '2026-09-30T12:00:01Z' });
      assertAllDisabled(expired, 'evidence_expired');
      assert.equal(expired.text_capture.enabled, true);
      assert.equal(expired.lanes.reaction.template_ref, selectedId, 'no alternative provider selected');
    });
  }

  it('missing evidence disables all affected lanes while independently authorized text capture continues', () => {
    const doc = settings();
    const context = contextFor(doc);
    doc.evidence = doc.evidence.filter((record) => record.template_ref !== 'synthetic-local');
    context.authorization.record.settings_sha256 = sha256Hex(canonicalJson(doc));
    const matrix = computeCapabilityMatrix(doc, context);
    assertAllDisabled(matrix, 'evidence_missing');
    assert.equal(matrix.text_capture.enabled, true);
  });

  it('rechecks every template, retaining independently admissible lanes and disabling aggregate voice', () => {
    const doc = settings();
    for (const lane of ['reaction', 'spec', 'design']) doc.presets['eu-e1'].lanes[lane] = structuredClone(doc.presets['local-l1'].lanes[lane]);
    doc.presets['eu-e1'].egress.allow.push('127.0.0.1');
    doc.evidence[0].expires_at = NOW;
    const result = computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1'));
    for (const lane of ['reaction', 'spec', 'design']) assert.equal(result.lanes[lane].reason, 'evidence_expired');
    for (const lane of ['stt', 'tts']) assert.equal(result.lanes[lane].enabled, true);
    assert.equal(result.voice.enabled, false);
    assert.equal(result.text_capture.enabled, true);
  });

  it('honors inclusive verified_at and microsecond exclusive expiry', () => {
    const doc = settings();
    doc.evidence[0].verified_at = '2026-09-30T12:00:00.000001Z';
    doc.evidence[0].expires_at = '2026-09-30T12:00:00.000002Z';
    assert.equal(resolveSettings(doc, { now: '2026-09-30T12:00:00.000000Z' }).lanes.reaction.reason, 'evidence_not_yet_valid');
    assert.equal(resolveSettings(doc, { now: doc.evidence[0].verified_at }).lanes.reaction.enabled, true);
    assert.equal(resolveSettings(doc, { now: doc.evidence[0].expires_at }).lanes.reaction.reason, 'evidence_expired');
  });

  it('pins EEA and EEA+CH to explicit listed countries; no country from a label alone', () => {
    assert.equal(COUNTRY_SETS['EEA@2026-01'].length, 30);
    assert.equal(COUNTRY_SETS['EEA@2026-01'].includes('CH'), false);
    assert.equal(COUNTRY_SETS['EEA+CH@2026-01'].includes('CH'), true);
    assert.equal(Object.isFrozen(COUNTRY_SETS['EEA@2026-01']), true);
    const doc = settings();
    doc.country_sets.push({ id: 'EEA@2026-01', countries: ['AT'] });
    assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } }).lanes.reaction.reason, 'country_set_invalid');
  });

  it('accepts OpenAI Europe only when the actual policy includes Switzerland', () => {
    const doc = settings();
    doc.presets['eu-e1'].lanes = structuredClone(doc.presets['cloud-c1'].lanes);
    doc.presets['eu-e1'].egress.allow = [...doc.presets['cloud-c1'].egress.allow];
    assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } }).lanes.reaction.reason, 'residency_denied');
    doc.presets['eu-e1'].residency.allowed_countries = ['EEA+CH@2026-01'];
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1')));
  });

  it('refuses preset residency broadening beyond instance policy and host placement outside it', () => {
    const doc = settings();
    doc.policy.residency.allowed_countries = ['AT@2026-01'];
    assert.ok(resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } }).lanes.reaction.reasons.includes('preset_policy_invalid'));
    doc.hosting.region_placement = ['US@2026-01'];
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.reason, 'hosting_residency_denied');
  });

  it('keeps documented retention exceptions without inventing a zero-retention promise', () => {
    const doc = settings();
    doc.evidence[0].retention = { zero_retention_entitled: false, exceptions: [{ purpose: 'security', max_days: 30, document_ref: 'synthetic-retention-exception' }] };
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc)));
    assert.deepEqual(resolveSettings(doc, { now: NOW }).lanes.reaction.evidence.retention, doc.evidence[0].retention);
  });

  it('never admits evidence whose verification follows its expiry', () => {
    const doc = settings();
    doc.evidence[0].verified_at = '2026-09-30T13:00:00Z';
    doc.evidence[0].expires_at = '2026-09-30T11:00:00Z';
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc)), 'evidence_expired');
  });

  it('requires active opt-out proof for the exact account while accepting inherently nontraining products', () => {
    const doc = settings();
    const eu = resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } });
    assert.equal(eu.lanes.reaction.evidence.training_on_content, true);
    assert.equal(eu.lanes.reaction.enabled, true);
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.evidence.opt_out, null);
  });

  it('admits ordinary noncommercial weights and archived MIT Piper, and a separate GPL service', () => {
    const doc = settings();
    doc.hosting.commercial = false;
    doc.provider_templates[0].artifacts[0].licence = 'CC-BY-NC-4.0';
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.enabled, true);
    doc.hosting.commercial = true;
    Object.assign(doc.provider_templates[0].artifacts[0], { kind: 'code', product: 'piper-archived', licence: 'MIT', bundled: true });
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.enabled, true);
    Object.assign(doc.provider_templates[0].artifacts[0], { product: 'piper', licence: 'GPL-3.0-only', bundled: false });
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.enabled, true);
  });

  it('blocks self-hosted Voxtral TTS even without a weights inventory entry', () => {
    const doc = settings();
    Object.assign(doc.provider_templates[0], { product: 'voxtral-tts', artifacts: [] });
    assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.reason, 'licence_denied');
    const euTemplate = doc.provider_templates[1];
    euTemplate.product = 'voxtral-tts-api';
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1')));
  });

  it('defaults EU speech to Mistral API and enforces ElevenLabs Enterprise EU evidence', () => {
    const doc = settings();
    assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } }).lanes.tts.template.provider, 'mistral');
    doc.provider_templates[1].provider = 'elevenlabs';
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1')), 'account_tier_denied');
    doc.evidence[1].account_tier = 'enterprise';
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1')));
    doc.provider_templates[2].provider = 'elevenlabs';
    doc.evidence[2].countries = { inference: ['US@2026-01'], storage: ['US@2026-01'], logs: ['US@2026-01'] };
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, 'cloud-c1')));
  });
});

describe('AIT-40 (c): egress allowlist and local boundaries', () => {
  for (const host of ['*.example.invalid', 'https://example.invalid', 'example.invalid:443', '127.0.0.0/8', 'example.invalid.', 'EXAMPLE.invalid', '9999999999999', '1.2.3.999']) {
    it(`refuses a noncanonical allowlist host ${host}`, () => {
      const doc = settings();
      doc.policy.egress.allow.push(host);
      assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.reason, 'preset_policy_invalid');
    });
  }

  for (const host of ['127.0.0.2', 'localhost', '[::1]']) {
    it(`admits an explicitly listed operator loopback endpoint ${host}`, () => {
      const doc = settings();
      doc.policy.egress.allow.push(host);
      doc.presets['local-l1'].egress.allow = [host];
      doc.provider_templates[0].endpoint = `http://${host}:9/v1`;
      assert.equal(resolveSettings(doc, { now: NOW }).lanes.reaction.enabled, true);
    });
  }

  for (const endpoint of [
    'http://eu-provider.example.invalid/v1', 'https://eu-provider.example.invalid.evil/v1',
    'https://eu-provider.example.invalid@evil.invalid/v1', 'https://user@eu-provider.example.invalid/v1',
    'https://eu-provider.example.invalid/v1#fragment', 'https://eu-provider.example.invalid\\evil/v1',
    'https://eu-provider.example.invalid/v1?credential=synthetic-value', ' https://eu-provider.example.invalid/v1',
    'ftp://eu-provider.example.invalid/v1', 'not a URL',
  ]) {
    it(`refuses an inadmissible endpoint ${endpoint}`, () => {
      const doc = settings();
      doc.provider_templates[1].endpoint = endpoint;
      assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'eu-e1' } }).lanes.reaction.reason, 'egress_denied');
    });
  }

  it('does not treat private LAN hosts as loopback or allow cloud providers on loopback', () => {
    const doc = settings();
    doc.policy.egress.allow.push('192.168.1.10');
    doc.presets['local-l1'].egress.allow = ['192.168.1.10'];
    doc.provider_templates[0].endpoint = 'http://192.168.1.10:9';
    assert.ok(resolveSettings(doc, { now: NOW }).lanes.reaction.reasons.includes('egress_denied'));
    doc.presets['cloud-c1'].egress.allow.push('127.0.0.1');
    doc.provider_templates[2].endpoint = 'https://127.0.0.1:9';
    assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'cloud-c1' } }).lanes.reaction.reason, 'egress_denied');
  });

  for (const host of ['10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '[fc00::1]', '[fe80::1]', '[::ffff:a9fe:a9fe]']) {
    it(`refuses an allowlisted private literal in a cloud endpoint ${host}`, () => {
      const doc = settings();
      doc.policy.egress.allow.push(host);
      doc.presets['cloud-c1'].egress.allow.push(host);
      doc.provider_templates[2].endpoint = `https://${host}:9/v1`;
      assert.equal(resolveSettings(doc, { now: NOW, preferences: { preset: 'cloud-c1' } }).lanes.reaction.reason, 'egress_denied');
    });
  }

  it('permits an empty allowlist by disabling network lanes and never treats it as allow-all', () => {
    const doc = settings();
    doc.presets['local-l1'].egress.allow = [];
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc)), 'egress_denied');
  });

  it('applies the selected preset allowlist to the proxy, keeping local egress loopback only', () => {
    const doc = settings();
    doc.hosting.proxy = 'https://eu-provider.example.invalid/proxy';
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc)), 'egress_denied');
    assertAllEnabled(computeCapabilityMatrix(doc, contextFor(doc, 'eu-e1')));
    doc.hosting.proxy = 'not a URL';
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc)), 'egress_denied');
  });
});

describe('AIT-40: server-side capability intersection', () => {
  it('keeps inline voice off by default and admits only an explicitly selected listed TTS voice', () => {
    const doc = settings();
    const context = contextFor(doc);
    delete context.preferences;
    const matrix = computeCapabilityMatrix(doc, context);
    assert.equal(matrix.voice.transport, 'inline');
    assert.equal(matrix.voice.enabled, false);
    assert.equal(matrix.lanes.stt.reason, 'voice_disabled');
    assert.equal(matrix.lanes.tts.reason, 'voice_disabled');
    assert.equal(matrix.lanes.reaction.enabled, true);
    context.preferences = { voice: { enabled: true, tts_voice: 'unapproved-voice' } };
    assert.equal(computeCapabilityMatrix(doc, context).lanes.tts.reason, 'voice_not_allowed');
    context.preferences.voice.tts_voice = null;
    assert.equal(computeCapabilityMatrix(doc, context).lanes.tts.reason, 'voice_not_allowed');
  });

  const adapterCases = [
    ['missing', (c) => c.adapters = [], 'adapter_missing'],
    ['unhealthy', (c) => c.adapters[0].healthy = false, 'adapter_unhealthy'],
    ['duplicate', (c) => c.adapters.push(structuredClone(c.adapters[0])), 'adapter_invalid'],
    ['malformed', (c) => c.adapters[0].healthy = 'yes', 'adapter_invalid'],
    ['unknown lane', (c) => c.adapters[0].models.magic = ['synthetic-local-model'], 'adapter_invalid'],
    ['unsupported product', (c) => c.adapters[0].products = [], 'adapter_unsupported'],
    ['unsupported location', (c) => c.adapters[0].execution_locations = ['cloud'], 'adapter_unsupported'],
    ['unsupported model', (c) => c.adapters[0].models = {}, 'adapter_unsupported'],
  ];
  for (const [label, change, reason] of adapterCases) {
    it(`fails closed for an ${label} adapter`, () => {
      const doc = settings();
      const context = contextFor(doc);
      change(context);
      assertAllDisabled(computeCapabilityMatrix(doc, context), reason);
    });
  }

  it('intersects adapter lane models and voices independently', () => {
    const doc = settings();
    const context = contextFor(doc);
    context.adapters[0].models.design = [];
    context.adapters[0].voices = [];
    const matrix = computeCapabilityMatrix(doc, context);
    assert.equal(matrix.lanes.design.reason, 'adapter_unsupported');
    assert.equal(matrix.lanes.tts.reason, 'voice_not_allowed');
    assert.equal(matrix.lanes.spec.enabled, true);
  });

  const authCases = [
    ['missing', (c) => delete c.authorization, 'authorization_missing'],
    ['bare client boolean', (c) => c.authorization = true, 'authorization_invalid'],
    ['unknown record key', (c) => c.authorization.record.trusted = true, 'authorization_invalid'],
    ['too-new record', (c) => Object.assign(c.authorization.record, { minor: 1, min_reader: 1 }), 'authorization_invalid'],
    ['wrong digest', (c) => c.authorization.record.settings_sha256 = 'f'.repeat(64), 'authorization_invalid'],
    ['future record', (c) => c.authorization.record.created_at = '2026-09-30T13:00:00Z', 'authorization_invalid'],
    ['revocation', (c) => c.authorization.record.withdrawn_at = NOW, 'authorization_withdrawn'],
    ['stale epoch', (c) => c.authorization.scope.epoch++, 'authorization_scope_mismatch'],
    ['different tenant', (c) => c.authorization.scope.tid = 'other-tenant', 'authorization_scope_mismatch'],
    ['different project', (c) => c.authorization.scope.pid = 'other-project', 'authorization_scope_mismatch'],
    ['different session', (c) => c.authorization.scope.sid = 'other-session', 'authorization_scope_mismatch'],
    ['different participant', (c) => c.authorization.scope.participant_refs = ['other-person'], 'authorization_scope_mismatch'],
    ['duplicate participant', (c) => c.authorization.record.participants.push(structuredClone(c.authorization.record.participants[0])), 'authorization_invalid'],
    ['duplicate processor', (c) => c.authorization.record.processors.push(structuredClone(c.authorization.record.processors[0])), 'authorization_invalid'],
  ];
  for (const [label, change, reason] of authCases) {
    it(`requires current host processing authorization: ${label}`, () => {
      const doc = settings();
      const context = contextFor(doc);
      change(context);
      const matrix = computeCapabilityMatrix(doc, context);
      assertAllDisabled(matrix, reason);
      assert.equal(matrix.text_capture.enabled, false, 'including local capture');
      assert.equal(matrix.text_capture.reason, reason);
    });
  }

  it('checks purposes per lane and requires intake authorization for text capture', () => {
    const doc = settings();
    const context = contextFor(doc);
    context.authorization.record.purposes = ['specification'];
    const matrix = computeCapabilityMatrix(doc, context);
    assert.equal(matrix.lanes.spec.enabled, true);
    for (const lane of ['reaction', 'design', 'stt', 'tts']) assert.equal(matrix.lanes[lane].reason, 'authorization_purpose_missing');
    assert.equal(matrix.text_capture.reason, 'authorization_purpose_missing');
  });

  for (const key of ['processor_ref', 'evidence_ref', 'location', 'countries']) {
    it(`binds the authorized processor ${key} to the selected evidence`, () => {
      const doc = settings();
      const context = contextFor(doc);
      context.authorization.record.processors[0][key] = key === 'countries' ? ['US'] : key === 'location' ? 'cloud' : 'synthetic-other';
      assertAllDisabled(computeCapabilityMatrix(doc, context), 'authorization_processor_missing');
    });
  }

  for (const scope of ['session', 'principal_day', 'tenant_day']) {
    it(`stops paid lanes at the ${scope} cap; text capture remains available`, () => {
      const doc = settings();
      const context = contextFor(doc, 'cloud-c1');
      context.budget.spent_micro[scope] = doc.policy.spend.caps[`${scope}_micro`] - 100;
      assertAllEnabled(computeCapabilityMatrix(doc, context));
      context.budget.spent_micro[scope]++;
      const matrix = computeCapabilityMatrix(doc, context);
      assertAllDisabled(matrix, 'budget_denied');
      assert.equal(matrix.text_capture.enabled, true);
    });
  }

  for (const [label, change, reason] of [
    ['missing', (c) => delete c.budget, 'budget_missing'],
    ['currency mismatch', (c) => c.budget.currency = 'USD', 'budget_invalid'],
    ['negative usage', (c) => c.budget.spent_micro.session = -1, 'budget_invalid'],
    ['fractional usage', (c) => c.budget.spent_micro.session = 0.5, 'budget_invalid'],
    ['unsafe integer', (c) => c.budget.spent_micro.session = 9007199254740992, 'budget_invalid'],
    ['NaN usage', (c) => c.budget.spent_micro.session = NaN, 'budget_invalid'],
    ['missing scope', (c) => delete c.budget.spent_micro.tenant_day, 'budget_invalid'],
    ['forged verdict', (c) => c.budget.allowed = true, 'budget_invalid'],
  ]) {
    it(`requires explicit valid budget metadata: ${label}`, () => {
      const doc = settings();
      const context = contextFor(doc, 'eu-e1');
      change(context);
      assertAllDisabled(computeCapabilityMatrix(doc, context), reason);
    });
  }

  it('admits declared free operator service lanes without a paid budget but refuses zero cloud maxima', () => {
    const doc = settings();
    for (const lane of LANES) doc.policy.spend.provider_max[lane] = 0;
    const context = contextFor(doc);
    delete context.budget;
    assertAllEnabled(computeCapabilityMatrix(doc, context));
    assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc, 'cloud-c1')), 'budget_invalid');
  });

  for (const [label, change] of [
    ['future rate', (d) => d.policy.spend.fx[0].as_of = '2026-10-01T00:00:00Z'],
    ['wrong target', (d) => d.policy.spend.fx[0].to = 'GBP'],
    ['same currencies', (d) => d.policy.spend.fx[0].from = 'EUR'],
    ['ambiguous pair', (d) => d.policy.spend.fx.push({ ...d.policy.spend.fx[0], numerator: 90 })],
  ]) {
    it(`refuses an invalid dated FX configuration: ${label}`, () => {
      const doc = settings();
      change(doc);
      assertAllDisabled(computeCapabilityMatrix(doc, contextFor(doc, 'cloud-c1')), 'budget_invalid');
    });
  }

  it('never silently configures a missing lane from another preset', () => {
    const doc = settings();
    doc.presets['local-l1'].lanes.design = null;
    const result = computeCapabilityMatrix(doc, contextFor(doc));
    assert.equal(result.lanes.design.reason, 'not_configured');
    assert.equal(result.lanes.design.template_ref, null);
    assert.equal(result.lanes.spec.enabled, true);
    assert.equal(result.voice.enabled, true);
  });

  it('reports only closed reasons, retains chosen operator/cloud locations, and never opens a network connection', () => {
    const doc = settings();
    const context = contextFor(doc);
    context.adapters = [];
    context.authorization = null;
    context.budget = null;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls++; throw new Error('network forbidden'); };
    try {
      const matrix = computeCapabilityMatrix(doc, context);
      for (const row of [...Object.values(matrix.lanes), matrix.voice]) {
        assert.ok(['operator', 'cloud'].includes(row.execution_location));
        assert.ok(row.reasons.every((reason) => CAPABILITY_REASONS.includes(reason)));
        assert.ok(CAPABILITY_REASONS.includes(row.reason));
      }
      assert.equal(calls, 0);
      assert.equal(Object.isFrozen(matrix.lanes.reaction.reasons), true);
      assert.equal(Object.isFrozen(CAPABILITY_REASONS), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
