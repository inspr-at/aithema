import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex, validate } from '../contracts/validate.js';
import { resolveSettings } from '../runtime/settings/index.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../contracts/fixtures/valid/${name}.json`, import.meta.url), 'utf8')).doc;
const now = '2026-09-30T07:00:00Z';
const settings = () => load('settings.deployment-period');

it('(a) resolves the optional deployment policy without modifying the original settings bytes', () => {
  const doc = settings();
  const original = canonicalJson(doc);
  assert.equal(validate('aithema.settings', doc).ok, true);
  const result = resolveSettings(doc, { now });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.policy.spend.deployment_period, doc.policy.spend.deployment_period);
  assert.equal(result.settings_sha256, sha256Hex(original));
  assert.equal(canonicalJson(doc), original);
  assert.equal(Object.isFrozen(result.policy.spend.deployment_period.notify_at), true);
});

it('(a) old valid documents retain their canonical digests and have no synthesized deployment policy', () => {
  const hashes = {
    'settings.executable': 'a3c2df8886decc10b2f71575a3c9659373685d89b78ec2776865069c881b986f',
    'budget.admit-request': '32e911df03c811f65db7d0dc972d6c3d1240b2c4943e8105581ed9f59da5a1c8',
    'budget.admit-ok': 'b0157edcdec208ecb73575c253c57d5d307228b1f6f55b97783a0cf94c701665',
    'budget.admit-denied': '3ab203bc6360a837a40755eb6d5cfabadb663b490390043b83882f157513616c',
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const doc = load(name);
    assert.equal(validate(doc.contract, doc).ok, true);
    assert.equal(sha256Hex(canonicalJson(doc)), hash);
  }
  assert.equal(Object.hasOwn(resolveSettings(load('settings.executable'), { now }).policy.spend, 'deployment_period'), false);
});

for (const zone of ['UTC', 'Etc/UTC', 'Etc/GMT+3', 'Europe/Vienna', 'America/New_York', 'Asia/Kathmandu']) {
  it(`(a) accepts recognized IANA zone ${zone}`, () => {
    const doc = settings();
    doc.policy.spend.deployment_period.time_zone = zone;
    assert.equal(resolveSettings(doc, { now }).policy.spend.deployment_period.time_zone, zone);
  });
}

for (const [label, modify] of [
  ['unknown zone', (p) => p.time_zone = 'Europe/Does_Not_Exist'],
  ['numeric offset', (p) => p.time_zone = '+01:00'],
  ['zone whitespace', (p) => p.time_zone = ' Europe/Vienna'],
  ['zone overflow', (p) => p.time_zone = 'a'.repeat(129)],
  ['descending ratios', (p) => p.notify_at = [0.8, 0.5]],
  ['duplicate ratios', (p) => p.notify_at = [0.5, 0.5]],
  ['zero ratio', (p) => p.notify_at = [0]],
  ['negative ratio', (p) => p.notify_at = [-0.1]],
  ['above one', (p) => p.notify_at = [1.01]],
  ['nonfinite ratio', (p) => p.notify_at = [NaN]],
  ['infinite ratio', (p) => p.notify_at = [Infinity]],
  ['too many ratios', (p) => p.notify_at = [0.1, 0.2, 0.3, 0.4, 1]],
  ['string ratio', (p) => p.notify_at = ['0.5']],
  ['negative ceiling', (p) => p.ceiling_micro = -1],
  ['fractional ceiling', (p) => p.ceiling_micro = 0.5],
  ['unsafe ceiling', (p) => p.ceiling_micro = Number.MAX_SAFE_INTEGER + 1],
  ['missing ceiling', (p) => delete p.ceiling_micro],
  ['non-month period', (p) => p.period = 'day'],
  ['empty deployment id', (p) => p.deployment_id = ''],
  ['long deployment id', (p) => p.deployment_id = 'a'.repeat(129)],
  ['unbounded id characters', (p) => p.deployment_id = 'host\nother'],
  ['trailing id newline', (p) => p.deployment_id = 'host\n'],
  ['sparse ratios', (p) => p.notify_at = Array(1)],
  ['degrade mode', (p) => p.degrade = true],
]) {
  it(`(a) rejects deployment settings: ${label}`, () => {
    const doc = settings();
    modify(doc.policy.spend.deployment_period);
    assert.throws(() => resolveSettings(doc, { now }), { code: 'settings_invalid' });
  });
}

it('(a) accepts zero ceiling, the largest safe ceiling, empty notifications and four sorted ratios', () => {
  for (const ceiling_micro of [0, Number.MAX_SAFE_INTEGER]) {
    for (const notify_at of [[], [Number.MIN_VALUE, 0.25, 0.9, 1]]) {
      const doc = settings();
      Object.assign(doc.policy.spend.deployment_period, { ceiling_micro, notify_at });
      assert.equal(validate(doc.contract, doc).ok, true);
      assert.deepEqual(resolveSettings(doc, { now }).policy.spend.deployment_period.notify_at, notify_at);
    }
  }
});
