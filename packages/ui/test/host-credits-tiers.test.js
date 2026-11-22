// AIT-298: focused unit workers keep cumulative DOM work within the unchanged
// three-minute file deadline under merge-group CPU contention.
// AIT-621: split from host-credits.test.js (with host-credits-flows.test.js) so
// each half stays well inside that deadline on the CI runner. Credits display,
// tiers, the conversation projection and the AIT-411/AIT-443 panel copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { tick, balance, setup, userTurn } from './host-surface-helpers.js';

for (const copy of [de, en]) for (const exhausted of [false, true]) {
  test(`AIT-445: drafts name the address day cap with 800 credits left (${copy.display.locale}, exhausted=${exhausted})`, async t => {
    const { root } = setup(t, { copy, host: { credits: true }, session: {
      conceptVisualKind: 'html', visualsBound: true, conceptCost: { maxMicro: 400_000 },
      featureMatrix: { best: { html: { available: false, reason: 'budget denied' } } },
    }, routes: {
      'GET /credits': () => Response.json({ scope: 'session', dailyCapReached: true, exhausted,
        balance: { owner: { limitMicro: 10_000_000, committedMicro: 2_000_000, availableMicro: 8_000_000, reservedMicro: 0 } } }),
    } });
    await tick(10);
    assert.equal(root.querySelector('.host-credits__amount').textContent, exhausted ? '0' : '800');
    const status = root.querySelector('.concept-activity-text');
    assert.equal(status.textContent, copy.hostSurface.credits.dailyCap);
    assert.equal(status.textContent, copy === de ? 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.' : "This email address has reached today's limit.");
    assert.notEqual(status.textContent, copy.display.draftsLow);
    assert.equal(root.querySelector('.concept-request').hidden, true);
  });
}

for (const copy of [de, en]) test(`AIT-445: a real low balance keeps the drafts credit message (${copy.display.locale})`, async t => {
  const { root } = setup(t, { copy, host: { credits: true }, session: {
    conceptVisualKind: 'html', visualsBound: true, conceptCost: { maxMicro: 400_000 },
    featureMatrix: { best: { html: { available: false, reason: 'budget denied' } } },
  }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', dailyCapReached: false, exhausted: false,
      balance: { owner: { limitMicro: 10_000_000, committedMicro: 9_990_000, availableMicro: 10_000, reservedMicro: 0 } } }),
  } });
  await tick(10);
  assert.equal(root.querySelector('.host-credits__amount').textContent, '1');
  assert.equal(root.querySelector('.concept-activity-text').textContent, copy.display.draftsLow);
  assert.equal(root.querySelector('.concept-request').hidden, true);
});

for (const [copy, loadingName] of [[de, 'Credits werden geladen'], [en, 'Loading credits']]) {
  test(`AIT-357: one placeholder and the loading accessible name until the first receipt (${copy.display.locale})`, async t => {
    let release;
    const receipt = new Promise(resolve => { release = resolve; });
    const { root } = setup(t, { copy, host: { credits: true }, routes: { 'GET /credits': () => receipt } });
    await tick(8);
    const button = root.querySelector('.host-credits__button'), total = root.querySelector('.host-credits__total');
    const track = root.querySelector('.host-credits__track');
    assert.equal(root.querySelector('.host-credits__value').textContent, '…');
    assert.equal(total.textContent, '');
    assert.ok(total.dataset.creditReserve.length > 0, 'the empty total keeps its reserved width');
    assert.equal(track.hidden, false, 'the loading track keeps its layout slot');
    assert.equal(track.style.visibility, 'hidden', 'no track is painted before the receipt');
    assert.equal(button.getAttribute('aria-label'), loadingName);
    release(Response.json({ balance, limitSlot: null })); await tick(8);
    assert.equal(root.querySelector('.host-credits__value').textContent, '425');
    assert.equal(button.getAttribute('aria-label'), copy.hostSurface.credits.balance.replace('{available}', '425').replace('{limit}', '500'));
    assert.notEqual(button.getAttribute('aria-label'), loadingName);
    assert.equal(track.style.visibility, '');
    assert.ok(total.textContent.length > 0);
  });
}

for (const copy of [de, en]) for (const state of ['anonymous', 'emailGiven', 'emailConfirmed', 'exhausted', 'dailyCap']) {
  test(`AIT-395: conversation projection ${state} (${copy.display.locale})`, async t => {
    const current = ['exhausted', 'dailyCap'].includes(state) ? 'anonymous' : state;
    const limitMicro = current === 'emailConfirmed' ? 10_000_000 : 2_500_000;
    const { root } = setup(t, { copy, host: { credits: true, verification: true }, routes: {
      'GET /credits': () => Response.json({ scope: 'session', exhausted: state === 'exhausted', dailyCapReached: state === 'dailyCap',
        balance: { owner: { limitMicro, availableMicro: state === 'exhausted' ? 0 : limitMicro } },
        tiers: { current, next: current === 'emailConfirmed' ? null : current === 'anonymous' ? 'emailGiven' : 'emailConfirmed', delta: current === 'emailConfirmed' ? 0 : 7_500_000,
          canConfirm: true, allowancesMicro: { anonymous: 2_500_000, emailGiven: 2_500_000, emailConfirmed: 10_000_000 } } }),
    } }); await tick(10);
    const next = root.querySelector('.host-credits__next'), action = root.querySelector('.credits-email');
    assert.doesNotMatch(root.querySelector('.host-credits__scope').textContent, /all your conversations|alle Ihre Gespräche/u);
    assert.equal(root.querySelector('.host-credits__unit').textContent, copy === de ? '\u00a0Credits' : '\u00a0credits');
    assert.equal(action.hidden, ['emailConfirmed', 'dailyCap'].includes(state));
    if (!action.hidden) assert.equal(action.textContent, copy.hostSurface.credits.confirm);
    if (current === 'anonymous' && state !== 'dailyCap') assert.equal(next.textContent, copy.hostSurface.credits.withConfirmed.replace(/\{(?:tier|n)\}/gu, copy === de ? '1.000' : '1,000').replace(' Credits', '\u00a0Credits'), 'Tick fix1: equal allowances name the confirmed tier without an email-given promise');
    if (state === 'emailGiven') assert.equal(next.textContent, copy.hostSurface.credits.afterConfirm.replace(/\{(?:tier|n)\}/gu, copy === de ? '1.000' : '1,000').replace(' Credits', '\u00a0Credits'));
    if (state === 'exhausted') assert.equal(root.querySelector('.host-credits__scope').textContent, copy === de ? 'Die 250\u00a0Credits dieses Gesprächs sind aufgebraucht.' : "This conversation's 250\u00a0credits are used up.");
    if (state === 'dailyCap') {
      assert.equal(root.querySelector('.host-credits__daily-cap').textContent, copy === de ? 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.' : "This email address has reached today's limit.");
      assert.equal(next.textContent, '');
    }
  });
}

for (const copy of [de, en]) test(`AIT-395: owner-wide exhausted copy snapshot (${copy.display.locale})`, async t => {
  const { root } = setup(t, { copy, host: { credits: true }, routes: {
    'GET /credits': () => Response.json({ balance, exhausted: true }),
  } }); await tick(8);
  assert.equal(root.querySelector('.host-credits__scope').textContent, copy === de ? 'Ihre 500\u00a0Credits sind aufgebraucht, für alle Ihre Gespräche.' : 'Your 500\u00a0credits are used up, for all your conversations.');
});

for (const copy of [de, en]) test(`AIT-395: exhaustion offers exactly the conversation's +750 confirmation delta (${copy.display.locale})`, async t => {
  const { root } = setup(t, { copy, host: { credits: true, verification: true }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', exhausted: true,
      balance: { owner: { limitMicro: 2_500_000, availableMicro: 0 } },
      tiers: { current: 'emailGiven', next: 'emailConfirmed', delta: 7_500_000, canConfirm: true,
        allowancesMicro: { anonymous: 2_500_000, emailGiven: 2_500_000, emailConfirmed: 10_000_000 } } }),
  } }); await tick(10);
  assert.equal(root.querySelector('.composer-out').dataset.next, 'confirm');
  assert.match(root.querySelector('.composer-out__confirm').textContent, /750/u);
  assert.equal(root.querySelector('.host-credits__next').textContent,
    copy.hostSurface.credits.afterConfirm.replace(/\{(?:tier|n)\}/gu, copy === de ? '1.000' : '1,000').replace(' Credits', '\u00a0Credits'));
});

for (const copy of [de, en]) for (const [variant, canCollect, confirmedMicro] of [
  ['eligible', true, 10_000_000], ['collection unavailable', false, 10_000_000],
  ['equal confirmed allowance', true, 2_500_000], ['lower confirmed allowance', true, 1_000_000],
]) test(`AIT-395 fix1: K1 next slot ${variant} (${copy.display.locale})`, async t => {
  const { root } = setup(t, { copy, host: { credits: true, verification: canCollect }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance: { owner: { limitMicro: 2_500_000, availableMicro: 2_500_000 } },
      tiers: { current: 'anonymous', next: 'emailGiven', canConfirm: true,
        allowancesMicro: { anonymous: 2_500_000, emailGiven: 2_500_000, emailConfirmed: confirmedMicro } } }),
  } }); await tick(10);
  const next = root.querySelector('.host-credits__next'), eligible = canCollect && confirmedMicro > 2_500_000;
  assert.equal(root.querySelector('.credits-email').hidden, !eligible);
  assert.equal(next.textContent, eligible ? copy.hostSurface.credits.withConfirmed.replace(/\{(?:tier|n)\}/gu, copy === de ? '1.000' : '1,000').replace(' Credits', '\u00a0Credits') : '');
  assert.equal(next.children.length, 0, 'the next line has no check mark');
});

for (const copy of [de, en]) test(`AIT-411: opt-in defaults preserve the credits and panel DOM (${copy.display.locale})`, async t => {
  const snapshots = [];
  for (const options of [{}, { usedUp: { newConversation: { enabled: false }, dailyCapActions: 'export' }, credits: { reconcilingVisible: false, dailyCapReset: false }, emailAsk: { lowCredits: true } }]) {
    const fixture = setup(t, { copy, host: { credits: true, verification: true, ...options } });
    await tick(10);
    snapshots.push(['.host-credits', '.composer-out', '.transcript-shell'].map(selector => fixture.root.querySelector(selector).outerHTML.replaceAll(fixture.c.session.id, '<session>')));
    fixture.c.remove(); await tick(10);
  }
  assert.deepEqual(snapshots[1], snapshots[0], 'all explicit defaults equal untouched RC13 DOM');
});

for (const copy of [de, en]) test(`AIT-411: defaults equal independently captured main DOM (${copy.display.locale})`, async t => {
  const baseline = JSON.parse(await readFile(new URL('../../../test/fixtures/ait411-rc13-dom.json', import.meta.url), 'utf8'));
  const fixture = setup(t, { copy, host: { credits: true, verification: true } });
  await tick(10);
  const actual = ['.host-credits', '.composer-out', '.transcript-shell'].map(selector => fixture.root.querySelector(selector).outerHTML.replaceAll(fixture.c.session.id, '<session>'));
  const original = baseline.rc13Snapshots[copy.display.locale], main = baseline.snapshots[copy.display.locale];
  // AIT-410/AIT-422 on main changed only this body between RC13 and the merge.
  // Apply that independently captured exact hunk to RC13; never strip PR nodes.
  const body = html => html.match(/<p class="composer-out__body"[^>]*>[\s\S]*?<\/p>/u)[0];
  const expected = [original[0], original[1].replace(body(original[1]), body(main[1])), original[2]];
  assert.deepEqual(main, expected, 'only the inherited AIT-410/AIT-422 body hunk differs from original RC13');
  // Tick AIT-445 v1.1 and AIT-435 r2: exact copy substitutions in preserved captures.
  const approvedCopy = html => (copy === de ? html.replaceAll('E-Mail', 'E‑Mail') : html).replaceAll('>Noch 0 Credits<', '>Noch 0&nbsp;Credits<').replaceAll('>0 Credits left<', '>0&nbsp;Credits left<').replaceAll('erhalten Sie  Credits', 'erhalten Sie &nbsp;Credits')
    // Tick AIT-443 v1 supersedes only the daily-cap sentence in these captures.
    .replaceAll('Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht. Morgen geht es weiter.', 'Für heute ist das Tageslimit dieser E‑Mail-Adresse erreicht.')
    .replaceAll("This email address has reached today's limit. You can continue tomorrow.", "This email address has reached today's limit.")
    // AIT-587 (RC25 look 15): English writes "credits" in lower case mid-sentence.
    .replace(/(?<= |&nbsp;)Credits(?=[ .<])/gu, match => copy === en ? 'credits' : match)
    // AIT-587 (AIT-553 gate1 L3): the used-up body no longer promises an export it does not always offer.
    .replaceAll(copy === en ? 'Your conversation stays saved. You can read and export it.' : 'Ihr Gespräch bleibt gespeichert. Sie können es lesen und exportieren.',
      copy === en ? 'Your conversation stays saved.' : 'Ihr Gespräch bleibt gespeichert.');
  assert.deepEqual(actual, expected.map(approvedCopy), 'only approved AIT-435 spaces, AIT-443 daily-cap and AIT-445 v1.1 E‑Mail copy differ from RC13 plus the main hunk');
  assert.deepEqual(actual, baseline.snapshots[copy.display.locale].map(approvedCopy), 'only approved AIT-435 spaces, AIT-443 daily-cap and AIT-445 v1.1 E‑Mail copy differ from the main capture');
  assert.equal(fixture.root.querySelectorAll('[data-credit-option-variant]').length, 0, 'defaults add no option peers');
});

for (const copy of [de, en]) test(`AIT-411 O1/O2/O7: cap wins over session, session wins over host limit (${copy.display.locale})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const receipt = { scope: 'session', dailyCapReached: true, exhausted: true, balance,
    tiers: { current: 'emailConfirmed', next: null, canConfirm: true, allowancesMicro: { anonymous: 1000000, emailConfirmed: 10000000 } } };
  const { c, root } = setup(t, { copy, host: { credits: true, verification: true, usedUp: { newConversation: { enabled: true }, dailyCapActions: 'none' } },
    routes: { 'GET /credits': () => Response.json(receipt) } });
  await tick(10); userTurn(c);
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'session' } }); await tick(10);
  assert.equal(root.querySelector('.composer-out__title span').textContent, copy.hostSurface.credits.dailyCapShort);
  assert.equal(root.querySelector('.composer-out__export').inert, true);
  assert.equal(root.querySelector('.composer-out__actions').getAttribute('aria-hidden'), 'true');
  receipt.dailyCapReached = false;
  t.mock.timers.tick(15001); await tick(14);
  assert.equal(root.querySelector('.composer-out__title span').textContent, copy.hostSurface.credits.ended.session.title);
  assert.equal(root.querySelector('.composer-out__body span').textContent, copy.hostSurface.credits.ended.newConversationHint);
  assert.equal(root.querySelector('.composer-out__new').hidden, false);
  assert.equal(root.querySelector('.composer-out__export').inert, false);
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'host-limit' } }); await tick(10);
  assert.equal(root.querySelector('.composer-out__title span').textContent, copy.hostSurface.credits.ended.session.title, 'session takes precedence over a later host-limit event');
});

for (const [copy, template, body] of [
  [de, 'Mit bestätigter E‑Mail-Adresse steigt das Limit dieses Gesprächs auf {next}\u00a0Credits.', 'Mit bestätigter E‑Mail-Adresse steigt das Limit dieses Gesprächs auf 1.000\u00a0Credits.'],
  [en, 'With a confirmed email address, this conversation\'s limit rises to {next}\u00a0credits.', 'With a confirmed email address, this conversation\'s limit rises to 1,000\u00a0credits.'],
]) test(`AIT-443 S1: catalog and complete panel body match Tick v1 (${copy.display.locale})`, async t => {
  assert.equal(copy.hostSurface.credits.ended.sessionUpgrade, template);
  const { c, root } = setup(t, { copy, host: { verification: true, credits: true }, session: { locale: copy.display.locale }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance, exhausted: true,
      tiers: { current: 'anonymous', next: 'emailConfirmed', canConfirm: true,
        allowancesMicro: { anonymous: 5000000, emailGiven: 5000000, emailConfirmed: 10000000 } } }),
  } });
  await tick(10); userTurn(c);
  c.receive({ seq: c.session.seq + 1, type: 'credits.limit-reached', data: { reason: 'session' } }); await tick(10);
  assert.equal(root.querySelector('.composer-out__body span').textContent, body);
  assert.equal(root.querySelector('.composer-out__confirm').hidden, false);
});

for (const [copy, expected] of [
  [de, 'Mit bestätigter E‑Mail-Adresse: 1.000\u00a0Credits'],
  [en, 'With a confirmed email address: 1,000\u00a0credits'],
]) test(`AIT-411 round 7 O3: confirmed current tier matches Tick (${copy.display.locale})`, async t => {
  const { root } = setup(t, { copy, host: { verification: true, credits: true }, session: { locale: copy.display.locale }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance,
      tiers: { current: 'emailConfirmed', next: null, canConfirm: true, allowancesMicro: { anonymous: 5000000, emailGiven: 5000000, emailConfirmed: 10000000 } } }),
  } });
  await tick(10);
  assert.equal(root.querySelector('.host-credits__current span:last-child').textContent, expected);
});

test('AIT-411 round 6 O3: shipped EN catalog and rendered offer match Tick including NBSP', async t => {
  assert.equal(en.hostSurface.credits.afterConfirm, 'After confirmation: {n}\u00a0credits');
  const { root } = setup(t, { copy: structuredClone(en), host: { verification: true, credits: true }, session: { locale: 'en' }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance, tiers: { current: 'anonymous', next: 'emailConfirmed', canConfirm: true,
      allowancesMicro: { anonymous: 5000000, emailGiven: 5000000, emailConfirmed: 10000000 } } }),
  } });
  await tick(10);
  assert.equal(root.querySelector('.host-credits__next').textContent, 'After confirmation: 1,000\u00a0credits');
});

test('AIT-411 round 6 O3: lowercase custom credits receives NBSP', async t => {
  const copy = structuredClone(en);
  copy.hostSurface.credits.afterConfirm = 'After confirmation: {n} credits';
  const { root } = setup(t, { copy, host: { verification: true, credits: true }, session: { locale: 'en' }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance, tiers: { current: 'anonymous', next: 'emailConfirmed', canConfirm: true,
      allowancesMicro: { anonymous: 5000000, emailGiven: 5000000, emailConfirmed: 10000000 } } }),
  } });
  await tick(10);
  assert.equal(root.querySelector('.host-credits__next').textContent, 'After confirmation: 1,000\u00a0credits');
});

for (const [option, host] of [
  ['O4', { credits: { reconcilingVisible: true } }],
  ['O5', { credits: { dailyCapReset: true } }],
  ['O2-none', { usedUp: { dailyCapActions: 'none' } }],
]) test(`AIT-411 round 6 ${option} without O1: no never-painted panel peers`, async t => {
  const { root } = setup(t, { host: { credits: true, ...host }, routes: {
    'GET /credits': () => Response.json({ scope: 'session', balance, exhausted: true, dailyCapReached: true, dailyCapResetAt: Date.now() + 3600000 }),
  } });
  await tick(10);
  assert.equal(root.querySelectorAll('[data-credit-option-variant]').length, 0, `${option}: panel reservation contains no unreachable option variants`);
});

for (const copy of [de, en]) test(`AIT-411 O3: missing offer key falls back and custom offer uses the separate key (${copy.display.locale})`, async t => {
  for (const hasKey of [false, true]) {
    const custom = structuredClone(copy);
    if (hasKey) custom.hostSurface.credits.afterConfirm = copy === de ? 'Nach der Bestätigung: {n}\u00a0Credits' : 'After confirmation: {n} credits';
    else delete custom.hostSurface.credits.afterConfirm;
    const { root } = setup(t, { copy: custom, host: { verification: true, credits: true }, session: { locale: copy.display.locale }, routes: {
      'GET /credits': () => Response.json({ scope: 'session', balance, tiers: { current: 'anonymous', next: 'emailConfirmed', canConfirm: true,
        allowancesMicro: { anonymous: 5000000, emailGiven: 5000000, emailConfirmed: 10000000 } } }),
    } });
    await tick(10);
    assert.match(root.querySelector('.host-credits__next').textContent, hasKey ? copy === de ? /^Nach der Bestätigung:/u : /^After confirmation:/u : copy === de ? /^Mit bestätigter E‑Mail-Adresse:/u : /^With a confirmed email address:/u);
  }
});

for (const copy of [de, en]) test(`AIT-411 O4/O5: one reconciliation announcement and reset retained until cap clears (${copy.display.locale})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const receipt = { scope: 'session', balance, exhausted: true, dailyCapReached: true, dailyCapResetAt: 123456789, reconciling: false };
  const { root } = setup(t, { copy, host: { credits: { reconcilingVisible: true, dailyCapReset: true } },
    routes: { 'GET /credits': () => Response.json(receipt) } });
  await tick(10);
  const deadline = root.querySelector('.host-credits__deadline'), resetText = deadline.textContent;
  assert.ok(resetText.length > 0); delete receipt.dailyCapResetAt;
  receipt.reconciling = true; t.mock.timers.tick(15001); await tick(12);
  assert.equal(deadline.textContent, resetText);
  const live = root.querySelector('.host-credits__reconcile-live'), originalNode = live.firstChild;
  assert.equal(live.textContent, copy.hostSurface.credits.reconcilingVisible);
  assert.equal(root.querySelector('.host-credits__button').getAttribute('aria-label'), copy.hostSurface.credits.reconcilingVisible);
  t.mock.timers.tick(15001); await tick(12);
  assert.equal(live.firstChild, originalNode, 'same reconciliation never re-announces');
  receipt.dailyCapReached = false; receipt.reconciling = false;
  t.mock.timers.tick(15001); await tick(12);
  assert.equal(deadline.hidden, true); assert.equal(deadline.textContent, ''); assert.equal(live.textContent, '');
});

test('AIT-411 defaults: a saved low-credit ask still restores after the balance rises', async t => {
  const { root } = setup(t, { host: { credits: true, verification: true },
    session: { transcript: [{ id: 'restore-reply', role: 'assistant', content: 'Ready.' }] }, routes: {
      'GET /credits': () => Response.json({ balance, lowAtMicro: 500000, exhausted: false, emailAsk: { open: true, why: 'low' },
        tiers: { current: 'anonymous', next: 'emailGiven', delta: 1000000, canConfirm: false,
          allowancesMicro: { anonymous: 5000000, emailGiven: 6000000, emailConfirmed: 6000000 } } }),
    } });
  await tick(12);
  assert.equal(root.querySelector('.email-ask').getAttribute('aria-hidden'), 'false', 'the default keeps the prior saved-ask restoration policy');
});
