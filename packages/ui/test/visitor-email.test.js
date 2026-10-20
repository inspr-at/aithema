import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { VisitorEmail } from '../src/visitor-email.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';

for (const [locale, copy] of [['de', de], ['en', en]]) {
  for (const [name, delivery, canCollect, expected] of [
    ['mail usable', true, true, locale === 'de' ? 'Guthaben gerade nicht verfügbar. Sie können die Adresse trotzdem bestätigen.' : "Credit isn't available right now. You can still confirm your address."],
    ['save usable', false, true, locale === 'de' ? 'Guthaben gerade nicht verfügbar. Sie können die Adresse trotzdem speichern.' : "Credit isn't available right now. You can still save your address."],
    ['neither usable (mail host)', true, false, locale === 'de' ? 'Guthaben gerade nicht verfügbar.' : "Credit isn't available right now."],
    ['neither usable (save host)', false, false, locale === 'de' ? 'Guthaben gerade nicht verfügbar.' : "Credit isn't available right now."],
  ]) {
    test(`AIT-171 failed status: ${locale}, ${name}`, t => {
      const window = new Window({ url: 'http://localhost/' }), host = window.document.createElement('div');
      window.document.body.append(host);
      const root = host.attachShadow({ mode: 'open' }), entry = window.document.createElement('section');
      root.append(entry);
      if (canCollect) host.innerHTML = '<a slot="legal" data-aithema-privacy href="/privacy">Privacy</a>';
      const email = new VisitorEmail({ root, entry, copy, delivery, privacyDocumentConfigured: canCollect });
      t.after(() => { email.destroy(); window.happyDOM.abort(); });
      email.set({ creditsState: 'failed' });
      assert.equal(email.viewDelivery, delivery);
      assert.equal(email.canCollect, canCollect);
      assert.equal(email.state, canCollect ? delivery ? 'mail' : 'capture' : 'unavailable');
      for (const selector of ['.m-lead-mail', '.m-lead-save', '.m-lead-edit']) {
        const lead = entry.querySelector(selector);
        assert.equal(lead.textContent, expected);
        assert.equal(lead.getAttribute('role'), 'status');
        assert.equal(lead.getAttribute('aria-live'), 'polite');
        const text = lead.firstChild;
        email.paint();
        assert.equal(lead.firstChild, text, 'repainting keeps the status node');
      }
    });
  }
}

const saveNotices = {
  de: 'Ihre E-Mail-Adresse wird nur für Ihr Guthaben verwendet, nie für Werbung. Nach 90\u00a0Tagen ohne Nutzung wird sie automatisch gelöscht.',
  en: 'We use your email address only for your credit. Never for advertising. After 90 days without use, we delete it automatically.',
};
for (const [locale, copy] of [['de', de], ['en', en]]) {
  for (const [name, delivery, canConfirm] of [['no delivery', false, true], ['confirmation off', true, false], ['mail', true, true]]) {
    test(`AIT-172 privacy: ${locale}, ${name}, all consumers and Settings latch`, t => {
      const window = new Window({ url: 'http://localhost/' }), host = window.document.createElement('div');
      window.document.body.append(host);
      host.innerHTML = '<a slot="legal" data-aithema-privacy href="/privacy">Privacy</a>';
      const root = host.attachShadow({ mode: 'open' }), entry = window.document.createElement('section'); root.append(entry);
      const email = new VisitorEmail({ root, entry, copy, delivery, privacyDocumentConfigured: true });
      t.after(() => { email.destroy(); window.happyDOM.abort(); });
      email.set({ tiers: { canConfirm } });
      const expected = delivery && canConfirm ? copy.hostSurface.email.noticeMail : saveNotices[locale];
      assert.equal(copy.hostSurface.email.noticeSave, saveNotices[locale]);
      for (const notice of entry.querySelectorAll('.m-notice')) assert.equal(notice.querySelector('.m-notice-text').textContent, expected);
      // Conversation ask, verification dialog and assessment lock share this painter.
      const other = window.document.createElement('p'); other.className = 'm-notice';
      other.innerHTML = '<span class="m-notice-text"></span> <a class="m-pp"></a>';
      email.paintNotice(other); assert.equal(other.querySelector('.m-notice-text').textContent, expected);
      email.beginSettings(); email.set({ delivery: true, tiers: { canConfirm: !(delivery && canConfirm) } });
      assert.equal(email.noticeText(), expected, 'the mode at Settings open owns the privacy copy');
      email.endSettings();
      assert.equal(email.noticeText(), delivery && canConfirm ? saveNotices[locale] : copy.hostSurface.email.noticeMail);
      email.set({ handover: true });
      assert.ok(email.noticeText().endsWith(copy.hostSurface.email.noticeHandover), 'handover copy remains unchanged');
    });
  }
}
