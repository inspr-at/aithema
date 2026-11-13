import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCopy } from '../src/copy-resolve.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

for (const shipped of [en, de]) for (const [key, legacy] of [['voiceConnectFailed', 'voiceConnectionFailed'], ['voiceTimeLimit', 'voiceDeadline']]) {
  test(`AIT-502 N7: shared resolver precedence ${shipped.display.locale}/${key}`, () => {
    const host = structuredClone(shipped);
    assert.equal(resolveCopy(host, key, legacy), shipped[key]);
    host[legacy] = 'Legacy host text'; assert.equal(resolveCopy(host, key, legacy), 'Legacy host text');
    host[key] = 'New host text'; assert.equal(resolveCopy(host, key, legacy), 'New host text');
    delete host[key]; assert.equal(resolveCopy(host, key, legacy), 'Legacy host text');
    delete host[legacy]; assert.equal(resolveCopy(host, key, legacy), shipped[key]);
  });
}
test('AIT-502 N7: brand-new keys use locale then English, never empty', () => {
  assert.equal(resolveCopy({ display: { locale: 'de' } }, 'voiceMessageClose'), 'Meldung schließen');
  assert.equal(resolveCopy({ display: { locale: 'unknown' }, voiceMessageClose: '' }, 'voiceMessageClose'), 'Close message');
  assert.equal(resolveCopy({ display: { locale: 'de' } }, 'voiceMessagesNarrow.voiceConnectFailed'), 'Keine Verbindung');
  assert.equal(resolveCopy({ voiceMessagesNarrow: { voiceTimeLimit: 'Host short' } }, 'voiceMessagesNarrow.voiceTimeLimit'), 'Host short');
});

test('AIT-502 N7: cloned structured defaults preserve legacy precedence for later counted copy', () => {
  const host = structuredClone(en); host.voiceDeadline = 'Legacy host text';
  assert.equal(resolveCopy(host, 'voiceStates', 'voiceDeadline'), 'Legacy host text');
  host.voiceStates.listening = 'Host state text';
  assert.equal(resolveCopy(host, 'voiceStates', 'voiceDeadline'), host.voiceStates);
});
