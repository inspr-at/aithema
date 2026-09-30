import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, sha256Hex } from '../contracts/validate.js';
import {
  INTERACTION_DISCLOSURE,
  TextUiError,
  bindTextUi,
  confirmableItems,
  describeDurability,
  parseBindings,
  planConfirmation,
  renderTextSession,
  unseenSeqs,
} from '../workspace/index.js';
import { formatBinding, renderItemFull } from '../workspace/text-ui.js';
import { renderWorkspacePage } from '../workspace/page.js';
import { resolveWorkspaceStatic } from '../workspace/flow-assets.js';
import { auditAccessibility, find, parseHtml, textOf } from './workspace-dom.test.js';

const SCRIPT = '<script>alert("x")</script>';
const digest = (content) => sha256Hex(canonicalJson(content));

function item(overrides = {}) {
  const content = overrides.content ?? { statement: 'Admins can export entries.', acceptance_criteria: ['CSV is offered'], constraint_refs: ['CON-1'] };
  return {
    item_ref: 'REQ-1', kind: 'requirement', version: 1, state: 'draft', content, content_sha256: digest(content),
    citations: [{ record_seq: 3, locator: 'turn:0', quote: 'export' }],
    provenance: { intent: 'requested', derived_from: [3] }, supersedes_item_version: null, host: null,
    ...overrides,
  };
}

const durable = { journal_state: 'ACTIVE', host_reachable: true, unacknowledged: 0, captured_turns: 0, working_rev: 4, journal_last_seq: 17, unreflected_records: 0 };

function view({ items = [item()], questions = [], transcript = [], hostMode = 'review', durability = durable, brief = null, screens = [], corrections = [] } = {}) {
  return {
    state: { working_rev: 4, host_mode: hostMode, spec: { items, questions, brief, screens }, corrections },
    transcript, durability,
  };
}

const person = (seq, body, lang = 'en') => ({ record: { seq, kind: 'turn', data: { speaker: 'person', body, lang } }, segments: [] });
const reaction = (seq, text, segments, complete = true) => ({ record: { seq, kind: 'reaction', data: { text, complete } }, segments });

const render = (overrides = {}, model = {}) => renderTextSession({
  view: view(overrides), turnAction: '/projects/p1/text/turns', confirmAction: '/projects/p1/text/confirm', canAct: true, ...model,
});
const all = (parts) => Object.values(parts).join('\n');

describe('binding parser', () => {
  const good = `REQ-1@2@${'a'.repeat(64)}`;

  it('accepts exact item_ref@version@sha256 bindings, one or many', () => {
    assert.deepEqual(parseBindings(good), [{ item_ref: 'REQ-1', version: 2, content_sha256: 'a'.repeat(64) }]);
    assert.equal(parseBindings([good, `REQ-2@1@${'b'.repeat(64)}`]).length, 2);
    assert.equal(formatBinding(parseBindings(good)[0]), good);
  });

  for (const [name, value] of [
    ['nothing', undefined], ['empty string', ''], ['empty list', []], ['not a string', { item_ref: 'REQ-1' }],
    ['number', 7], ['wrong separator', `REQ-1:2:${'a'.repeat(64)}`], ['short digest', 'REQ-1@2@abc'],
    ['upper-case digest', `REQ-1@2@${'A'.repeat(64)}`], ['zero version', `REQ-1@0@${'a'.repeat(64)}`],
    ['negative version', `REQ-1@-1@${'a'.repeat(64)}`], ['huge version', `REQ-1@99999999999@${'a'.repeat(64)}`],
    ['markup in ref', `<b>@1@${'a'.repeat(64)}`], ['trailing junk', `${good} `], ['newline junk', `${good}\nREQ-2@1@${'b'.repeat(64)}`],
    ['extra field', `${good}@x`], ['array with a non-string', [good, 3]],
  ]) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseBindings(value), (error) => error instanceof TextUiError && error.code === 'invalid_binding' && error.status === 400);
    });
  }

  it('refuses a duplicated item version and an oversized batch', () => {
    assert.throws(() => parseBindings([good, good]), /twice/);
    const many = Array.from({ length: 201 }, (_, index) => `REQ-${index}@1@${'a'.repeat(64)}`);
    assert.throws(() => parseBindings(many), /Too many/);
  });
});

describe('confirmation planning against the current working spec', () => {
  const state = (items) => ({ spec: { items } });
  const binding = (row) => ({ item_ref: row.item_ref, version: row.version, content_sha256: row.content_sha256 });

  it('plans draft items, treats an exactly confirmed version as an idempotent no-op', () => {
    const draft = item();
    const done = item({ item_ref: 'REQ-2', state: 'confirmed' });
    const plan = planConfirmation(state([draft, done]), [binding(draft), binding(done)]);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.confirm, [binding(draft)]);
    assert.deepEqual(plan.already, [binding(done)]);
  });

  it('refuses a digest that differs from the version shown, even by one character', () => {
    const draft = item();
    const plan = planConfirmation(state([draft]), [{ ...binding(draft), content_sha256: `${draft.content_sha256.slice(0, 63)}0` }]);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'hash_mismatch');
  });

  it('refuses unknown refs, unknown versions and items that are not drafts', () => {
    const draft = item();
    const proposed = item({ item_ref: 'REQ-3', state: 'proposed', host: { op_key: `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}:submit:1`, proposal_ref: 'P-1' } });
    assert.equal(planConfirmation(state([draft]), [{ ...binding(draft), item_ref: 'REQ-9' }]).reason, 'unknown_item');
    assert.equal(planConfirmation(state([draft]), [{ ...binding(draft), version: 2 }]).reason, 'unknown_item');
    assert.equal(planConfirmation(state([proposed]), [binding(proposed)]).reason, 'not_draft');
  });

  it('refuses a version that a newer version has replaced, even while still marked draft', () => {
    const old = item();
    const next = item({ version: 2, supersedes_item_version: { item_ref: 'REQ-1', version: 1 }, content: { statement: 'Changed.', acceptance_criteria: [], constraint_refs: [] } });
    assert.equal(planConfirmation(state([{ ...old, state: 'superseded' }, next]), [binding(old)]).reason, 'superseded');
    assert.equal(planConfirmation(state([old, next]), [binding(old)]).reason, 'superseded');
    assert.equal(planConfirmation(state([{ ...old, state: 'superseded' }, next]), [binding(next)]).ok, true);
  });

  it('refuses an item whose stored digest does not match its own content', () => {
    const forged = { ...item(), content_sha256: 'f'.repeat(64) };
    assert.equal(planConfirmation(state([forged]), [binding(forged)]).reason, 'integrity');
  });

  it('one refused binding refuses the whole batch', () => {
    const good = item();
    const bad = item({ item_ref: 'REQ-2' });
    const plan = planConfirmation(state([good, bad]), [binding(good), { ...binding(bad), content_sha256: '0'.repeat(64) }]);
    assert.equal(plan.ok, false);
    assert.equal(plan.binding.item_ref, 'REQ-2');
  });

  it('only the newest draft of an item_ref is confirmable', () => {
    const old = item({ state: 'draft' });
    const next = item({ version: 2 });
    assert.deepEqual(confirmableItems(state([old, next])).map((row) => row.version), [2]);
    assert.deepEqual(confirmableItems(null), []);
  });
});

describe('durability indicator', () => {
  it('reports durable only when everything is acknowledged and reflected', () => {
    const result = describeDurability(durable);
    assert.equal(result.level, 'durable');
    assert.match(result.reasons.join(' '), /revision 4.*record 17/);
  });

  for (const [name, patch, reason] of [
    ['unacknowledged records', { unacknowledged: 2 }, /2 record\(s\) were sent but the journal host has not acknowledged/],
    ['captured turns', { captured_turns: 1 }, /1 message\(s\) are held by the worker/],
    ['an unreachable host', { host_reachable: false }, /could not be reached/],
    ['journaled turns the spec has not consumed', { unreflected_records: 3 }, /3 journaled message\(s\).*not yet reflected/],
  ]) {
    it(`is pending for ${name}`, () => {
      const result = describeDurability({ ...durable, ...patch });
      assert.equal(result.level, 'pending');
      assert.match(result.reasons.join(' '), reason);
    });
  }

  it('distinguishes capture-only and ended outages from pending', () => {
    assert.equal(describeDurability({ ...durable, journal_state: 'CAPTURE_ONLY', captured_turns: 2 }).level, 'capture_only');
    assert.equal(describeDurability({ ...durable, journal_state: 'ENDED' }).level, 'ended');
    assert.equal(describeDurability(durable, { started: false }).level, 'not_started');
  });

  for (const [name, input] of [
    ['null', null], ['undefined', undefined], ['a string', 'durable'], ['an unknown journal state', { ...durable, journal_state: 'OK' }],
    ['a missing count', { ...durable, unacknowledged: undefined }], ['a negative count', { ...durable, unreflected_records: -1 }],
    ['a fractional count', { ...durable, working_rev: 1.5 }], ['a non-boolean reachability', { ...durable, host_reachable: 'yes' }],
  ]) {
    it(`never claims durable for ${name}`, () => {
      assert.equal(describeDurability(input).level, 'pending');
    });
  }

  it('renders the level as text and as a data attribute, not by colour alone', () => {
    const html = render({ durability: { ...durable, unacknowledged: 1 } }).status;
    const node = find(parseHtml(html), (n) => n.attrs.id === 'text-durability')[0];
    assert.equal(node.attrs['data-durability'], 'pending');
    assert.equal(node.attrs.role, 'status');
    assert.match(textOf(node), /^Pending · working spec revision 4 —/);
    const ok = find(parseHtml(render().status), (n) => n.attrs.id === 'text-durability')[0];
    assert.match(textOf(ok), /^Durably journaled · working spec revision 4 —/);
  });
});

describe('Art. 50 interaction disclosure', () => {
  it('shows the persistent badge and the opening disclosure', () => {
    const parts = render();
    const badge = find(parseHtml(parts.status), (n) => n.attrs.id === 'text-ai-badge')[0];
    assert.match(textOf(badge), /You are talking to an AI system, not a person\./);
    assert.equal(badge.attrs['data-ai-disclosure'], 'art50-1');
    assert.match(parts.conversation, /id="text-opening-disclosure"/);
    assert.match(textOf(find(parseHtml(parts.conversation), (n) => n.attrs.id === 'text-opening-disclosure')[0]), /AI system/);
    assert.match(INTERACTION_DISCLOSURE.opening, /Nothing is confirmed by what you say or type/);
  });

  it('keeps the badge when the session is unavailable, has no state, or the person cannot act', () => {
    for (const parts of [
      renderTextSession({ view: { state: null, transcript: [], durability: null, unavailable: true }, turnAction: '/t', confirmAction: '/c', canAct: true }),
      renderTextSession({ view: { state: null, transcript: [], durability: null }, turnAction: '/t', confirmAction: '/c', canAct: true }),
      render({}, { canAct: false }),
    ]) assert.match(parts.status, /data-ai-disclosure="art50-1"/);
  });

  it('labels every assistant message and every generated item as AI-generated', () => {
    const parts = render({ transcript: [person(1, 'hi'), reaction(2, 'Noted.', [{ kind: 'say', start: 0, end: 6 }])] });
    assert.match(parts.conversation, /AI assistant \(AI-generated\)/);
    assert.match(parts.confirmation, /class="ai-generated">AI-generated</);
  });
});

describe('full-item confirmation view', () => {
  it('shows statement, every criterion, every constraint ref, the intent label, evidence and the digest in full', () => {
    const row = item({
      content: { statement: 'Long statement '.repeat(40), acceptance_criteria: ['First criterion', 'Second criterion'], constraint_refs: ['CON-1', 'CON-2'], },
      provenance: { intent: 'inferred', derived_from: [3] },
    });
    const html = renderItemFull(row, { level: 3 });
    const tree = parseHtml(html);
    const text = textOf(tree);
    assert.ok(text.includes(row.content.statement.trim()));
    for (const expected of ['First criterion', 'Second criterion', 'CON-1', 'CON-2', 'inferred', row.content_sha256, 'journal record 3', 'Evidence (not authorization)']) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
    assert.match(text, /advisory label; it is not verified/);
  });

  it('labels each intent value and warns for extracted instructions', () => {
    for (const intent of ['requested', 'extracted_instruction', 'inferred']) {
      const html = renderItemFull(item({ provenance: { intent, derived_from: [] } }), { level: 3 });
      assert.match(html, new RegExp(`data-intent="${intent}"`));
    }
    assert.match(renderItemFull(item({ provenance: { intent: 'extracted_instruction', derived_from: [] } }), { level: 3 }), /you did not necessarily ask for it/);
    assert.match(renderItemFull(item({ provenance: { intent: 'made-up', derived_from: [] } }), { level: 3 }), /unknown label — treat as inferred/);
  });

  it('shows extensions as outside the content digest', () => {
    const html = renderItemFull(item({ extensions: { 'x-acme.score@1': { version: '1.0', data: { score: 3 } } } }), { level: 3 });
    assert.match(html, /Extensions \(not covered by the content digest\)/);
    assert.match(html, /x-acme.score@1/);
  });

  it('lists every draft, with one per-item form and one batch form, binding only ref, version and digest', () => {
    const a = item();
    const b = item({ item_ref: 'REQ-2', content: { statement: 'Second.', acceptance_criteria: [], constraint_refs: [] } });
    const { confirmation } = render({ items: [a, b] });
    const tree = parseHtml(confirmation);
    const forms = find(tree, (n) => n.tag === 'form');
    assert.equal(forms.length, 3);
    const hidden = (form) => find(form, (n) => n.tag === 'input').map((n) => `${n.attrs.name}=${n.attrs.value}`);
    assert.deepEqual(hidden(forms[0]), [`binding=${formatBinding(a)}`]);
    assert.deepEqual(hidden(forms[1]), [`binding=${formatBinding(b)}`]);
    assert.deepEqual(hidden(forms[2]), ['action=einreichen', `binding=${formatBinding(a)}`, `binding=${formatBinding(b)}`]);
    assert.ok(!/principal/i.test(confirmation), 'the principal is never a browser field');
    assert.equal(textOf(find(forms[2], (n) => n.tag === 'button')[0]), 'Einreichen — confirm all 2 items as shown');
    assert.equal(find(forms[2], (n) => n.tag === 'span')[0].attrs.lang, 'de');
    assert.match(textOf(forms[0].children.find((n) => n.tag === 'button')), /^Confirm REQ-1 version 1 as shown$/);
  });

  it('states that turn text, “ja” and “yes” never confirm', () => {
    const { confirmation, conversation } = render();
    assert.match(confirmation, /not even “ja” or “yes”/);
    assert.match(conversation, /Typing “ja” or “yes” is not a confirmation/);
  });

  it('shows no forms to a person who cannot act, and says why', () => {
    const { confirmation, conversation } = render({}, { canAct: false });
    assert.equal(find(parseHtml(confirmation), (n) => n.tag === 'form').length, 0);
    assert.equal(find(parseHtml(conversation), (n) => n.tag === 'form').length, 0);
    assert.match(confirmation, /Only a signed-in human participant can confirm items/);
  });

  it('says so when nothing waits, and notes the host mode', () => {
    assert.match(render({ items: [item({ state: 'confirmed' })] }).confirmation, /No items are waiting/);
    assert.match(render({ hostMode: 'working_spec_only' }).confirmation, /keeps the working spec only/);
    const review = render({ hostMode: 'review' }).confirmation;
    assert.match(review, /Einreichen records your confirmation of the items as shown/);
    assert.match(review, /Submission to the host as immutable proposals runs only when a host submission hook is configured/);
    assert.ok(!review.includes('Confirmed items are submitted'));
  });

  it('never offers confirmation for the superseded, proposed or accepted versions', () => {
    const old = item({ state: 'superseded' });
    const next = item({ version: 2, supersedes_item_version: { item_ref: 'REQ-1', version: 1 } });
    const { confirmation } = render({ items: [old, next] });
    assert.ok(!confirmation.includes(formatBinding(old)));
    assert.ok(confirmation.includes(formatBinding(next)));
  });
});

describe('escaping of untrusted text', () => {
  it('escapes markup from items, transcript, questions, brief and corrections', () => {
    const hostile = item({
      content: { statement: `${SCRIPT} "quoted" 'single' <img src=x onerror=alert(1)>`, acceptance_criteria: [SCRIPT], constraint_refs: ['CON-1'] },
      citations: [{ record_seq: 3, locator: 'turn:0', quote: SCRIPT }],
    });
    const parts = render({
      items: [hostile, item({ item_ref: 'REQ-9', state: 'confirmed', content: { statement: SCRIPT, acceptance_criteria: [], constraint_refs: [] } })],
      transcript: [person(1, SCRIPT), reaction(2, SCRIPT, [{ kind: 'question', start: 0, end: SCRIPT.length, question_id: 'Q-1' }])],
      questions: [{ question_id: 'Q-1', text: SCRIPT, state: 'asked', asked_in_reaction_seq: 2 }],
      brief: SCRIPT,
      corrections: [{ correction_id: 'C-1', about_reaction_seq: 2, text: SCRIPT, state: 'pending' }],
    }, { draftMessage: SCRIPT });
    const html = all(parts);
    assert.ok(!html.includes('<script'), 'no raw script element survives');
    assert.ok(!html.includes('<img'), 'no raw img element survives');
    assert.ok(!/onerror=/.test(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', '')), 'handler text appears only escaped');
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.deepEqual(auditAccessibility(`<html lang="en"><body><a href="#m">s</a><main id="m"><h1>t</h1>${html}</main></body></html>`).problems, []);
  });

  it('escapes attribute positions: ids, refs, digests and lang', () => {
    const odd = item({ item_ref: 'A"><b>', content_sha256: '"><i>' });
    const html = renderItemFull(odd, { level: 3 });
    assert.ok(!html.includes('"><b>') && !html.includes('"><i>'));
    const turn = person(1, 'x', 'en"><b>');
    assert.ok(!render({ transcript: [turn] }).conversation.includes('"><b>'));
  });
});

describe('transcript and canonical question', () => {
  it('marks the canonical question, corrections and plain replies apart, using UTF-16 offsets', () => {
    const text = 'Gern 🙂 notiert.\nKorrektur eins.\nWer darf exportieren?';
    const say = 'Gern 🙂 notiert.';
    const correction = 'Korrektur eins.';
    const question = 'Wer darf exportieren?';
    const segments = [
      { kind: 'say', start: 0, end: say.length },
      { kind: 'correction', start: say.length + 1, end: say.length + 1 + correction.length, correction_id: 'C-1' },
      { kind: 'question', start: say.length + correction.length + 2, end: text.length, question_id: 'Q-1' },
    ];
    assert.equal(text.slice(segments[2].start, segments[2].end), question);
    const { conversation } = render({ transcript: [person(1, 'Hallo', 'de'), reaction(2, text, segments)] });
    const tree = parseHtml(conversation);
    const canonical = find(tree, (n) => n.attrs['data-canonical-question'] === 'true');
    assert.equal(canonical.length, 1);
    assert.equal(textOf(canonical[0]), `Canonical question: ${question}`);
    assert.equal(canonical[0].attrs['data-question-id'], 'Q-1');
    assert.match(textOf(find(tree, (n) => n.attrs['data-correction-id'] === 'C-1')[0]), /^Correction: Korrektur eins\.$/);
    assert.equal(textOf(find(tree, (n) => n.attrs.class === 'segment say')[0]), say);
    assert.equal(find(tree, (n) => n.tag === 'pre' && n.attrs.lang === 'de').length, 1);
  });

  it('shows the current canonical question next to the composer, preferring the newest asked one', () => {
    const questions = [
      { question_id: 'Q-0', text: 'Older?', state: 'asked', asked_in_reaction_seq: 2 },
      { question_id: 'Q-1', text: 'Newest?', state: 'asked', asked_in_reaction_seq: 6 },
      { question_id: 'Q-2', text: 'Open?', state: 'open' },
    ];
    const { conversation } = render({ questions });
    const node = find(parseHtml(conversation), (n) => n.attrs.id === 'text-current-question')[0];
    assert.equal(textOf(node), 'Canonical question: Newest?');
    assert.match(render({ questions: [{ question_id: 'Q-2', text: 'Open?', state: 'open' }] }).conversation, /Canonical question:<\/strong> <span class="wrap">Open\?/);
    assert.match(render({ questions: [] }).conversation, /No open question right now/);
  });

  it('degrades to the plain text when a receipt has no segments, and marks interrupted replies', () => {
    const { conversation } = render({ transcript: [reaction(2, 'Plain reply.', [], false)] });
    assert.match(conversation, /Plain reply\./);
    assert.match(conversation, /reply interrupted/);
    assert.ok(!conversation.includes('data-canonical-question="true"'));
  });

  it('keeps an explicit empty state for an empty log so the live region exists from first paint', () => {
    const tree = parseHtml(render({ transcript: [] }).conversation);
    const log = find(tree, (n) => n.attrs.role === 'log')[0];
    assert.equal(log.attrs.id, 'text-transcript');
    assert.ok(find(log, (n) => Object.hasOwn(n.attrs, 'data-empty')).length === 1);
  });
});

describe('working spec review', () => {
  it('groups every state, shows closed states collapsed but present, and links drafts to the confirmation list', () => {
    const items = [
      item({ item_ref: 'REQ-1', version: 1, state: 'superseded' }),
      item({ item_ref: 'REQ-1', version: 2, supersedes_item_version: { item_ref: 'REQ-1', version: 1 }, content: { statement: 'v2', acceptance_criteria: [], constraint_refs: [] } }),
      item({ item_ref: 'REQ-2', state: 'confirmed' }),
      item({ item_ref: 'REQ-3', state: 'proposed', host: { op_key: `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}:submit:1`, proposal_ref: 'P-7' } }),
      item({ item_ref: 'REQ-4', state: 'accepted', host: { op_key: `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}:submit:2`, proposal_ref: 'P-8' } }),
      item({ item_ref: 'REQ-5', state: 'rejected' }),
    ];
    const { review } = render({
      items,
      questions: [{ question_id: 'Q-1', text: 'Who?', state: 'open' }],
      brief: 'A brief.', screens: [{ screen_ref: 'S-1', design_input_seq: 9 }],
      corrections: [{ correction_id: 'C-1', about_reaction_seq: 2, text: 'Fix that.', state: 'pending' }],
    });
    const tree = parseHtml(review);
    const groups = find(tree, (n) => n.tag === 'section' && n.attrs['data-state']).map((n) => n.attrs['data-state']);
    assert.deepEqual(groups, ['draft', 'confirmed', 'proposed', 'accepted', 'rejected', 'superseded']);
    const details = find(tree, (n) => n.tag === 'details').map((n) => textOf(n.children.find((c) => c.tag === 'summary')));
    assert.equal(details.length, 2);
    assert.ok(find(tree, (n) => n.tag === 'a' && n.attrs.href === '#item-REQ-1-v2').length === 1);
    const text = textOf(tree);
    for (const expected of ['Revision 4', 'A brief.', 'Who?', 'Fix that.', 'P-7', 'S-1', 'design input record 9', 'Accepted in the host']) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
    assert.equal(find(tree, (n) => n.tag === 'article').length, 5, 'drafts are summarised, every other version is shown in full');
  });

  it('handles an empty or absent working spec', () => {
    assert.match(render({ items: [] }).review, /No items yet/);
    assert.match(renderTextSession({ view: { state: null, transcript: [], durability: null }, turnAction: '/t', confirmAction: '/c', canAct: true }).review, /No working spec yet/);
  });
});

describe('accessibility of the rendered workspace page', () => {
  const page = (overrides = {}, model = {}) => renderWorkspacePage({
    mode: 'test', labelledDemo: true, providerLive: false, providerId: 'mock', publicBasePath: '/mnt',
    actor: { subject: 'demo', party_ref: 'party:demo', actor_kind: 'human', roles: ['requirements_approver'], projects: [] },
    projects: [],
    project: { project_ref: 'p1', title: 'Project <one>', revision: 1, conversation_ref: 'c1', project_kinds: ['new_product'],
      stream: { proposals: [], decisions: [], baselines: [] }, transcript: [], documents: [] },
    textSession: { view: view({
      items: [item(), item({ item_ref: 'REQ-2', content: { statement: 'Second.', acceptance_criteria: [], constraint_refs: [] } }), item({ item_ref: 'REQ-3', state: 'confirmed' })],
      questions: [{ question_id: 'Q-1', text: 'Who may export?', state: 'asked', asked_in_reaction_seq: 2 }],
      transcript: [person(1, 'We need an export'), reaction(2, 'Noted.\nWho may export?', [{ kind: 'say', start: 0, end: 6 }, { kind: 'question', start: 7, end: 21, question_id: 'Q-1' }])],
      ...overrides,
    }), canAct: true },
    revisionReview: { proposals: [] },
    ...model,
  });

  it('passes the structural audit: labels, names, ids, heading order, landmark, skip link, no positive tabindex, no inline script', () => {
    const { problems } = auditAccessibility(page());
    assert.deepEqual(problems, []);
  });

  it('passes the same audit with notices, errors, an unavailable session and a person who cannot act', () => {
    assert.deepEqual(auditAccessibility(page({}, { notice: 'Confirmed 1 item.', error: 'Nope.' })).problems, []);
    assert.deepEqual(auditAccessibility(page({}, { textSession: { view: { state: null, transcript: [], durability: null, unavailable: true }, canAct: true } })).problems, []);
    assert.deepEqual(auditAccessibility(page({}, { textSession: { view: view(), canAct: false } })).problems, []);
  });

  it('has a sane focus order: skip link, conversation log, composer, per-item confirms, Einreichen, then the rest', () => {
    const names = auditAccessibility(page()).focusOrder.map((entry) => entry.name);
    const at = (name) => names.findIndex((entry) => entry.startsWith(name));
    assert.equal(at('Skip to main content'), 0);
    const order = ['Conversation transcript', 'Your message to the AI assistant', 'Send message', 'Confirm REQ-1 version 1 as shown',
      'Confirm REQ-2 version 1 as shown', 'Einreichen — confirm all 2 items as shown'].map(at);
    assert.ok(order.every((index) => index > 0), `every control is reachable: ${JSON.stringify(names)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'controls follow reading order');
    assert.ok(at('Approve') === -1 || at('Approve') > order.at(-1), 'legacy review controls come after the text session');
  });

  it('has live regions for reactions and questions (log), durability (status) and announcements (status)', () => {
    const tree = parseHtml(page());
    const log = find(tree, (n) => n.attrs.role === 'log');
    assert.equal(log.length, 1);
    assert.equal(log[0].attrs['aria-live'], 'polite');
    assert.equal(log[0].attrs['aria-label'], 'Conversation transcript');
    assert.equal(log[0].attrs.tabindex, '0', 'the scrollable log is keyboard-reachable');
    const statuses = find(tree, (n) => n.attrs.role === 'status').map((n) => n.attrs.id);
    assert.ok(statuses.includes('text-durability') && statuses.includes('text-live'));
    const composer = find(tree, (n) => n.tag === 'textarea')[0];
    assert.match(composer.attrs['aria-describedby'], /text-current-question/);
  });

  it('marks the canonical question in the transcript and above the composer', () => {
    const tree = parseHtml(page());
    assert.equal(find(tree, (n) => n.attrs['data-canonical-question'] === 'true').length, 1);
    assert.match(textOf(find(tree, (n) => n.attrs.id === 'text-current-question')[0]), /^Canonical question: Who may export\?$/);
  });

  it('puts the disclosure badge before any interactive control and keeps the language of German text', () => {
    const html = page();
    assert.ok(html.indexOf('id="text-ai-badge"') < html.indexOf('<textarea'));
    assert.match(html, /<span lang="de">Einreichen<\/span>/);
    assert.match(html, /<html lang="en">/);
  });

  it('serves the text UI client from the closed asset list and references it only with a session', () => {
    assert.match(page(), /src="\/mnt\/workspace-text-ui\.js"/);
    assert.ok(!page({}, { textSession: undefined }).includes('workspace-text-ui.js'));
    assert.ok(resolveWorkspaceStatic('/workspace-text-ui.js'));
    assert.equal(resolveWorkspaceStatic('/workspace-text-ui.js/../server.js'), null);
  });

  it('keeps the legacy composer for a project without a text session', () => {
    const html = page({}, { textSession: undefined });
    assert.match(html, /id="workspace-compose"/);
    assert.ok(!html.includes('id="text-conversation"'));
    assert.deepEqual(auditAccessibility(html).problems, []);
  });

  it('keeps the configured spend estimate next to text durability, including pending and unavailable sessions', () => {
    const model = { policyActive: true, estimatedSpend: { accountedMicro: 20, budgetMicro: 100, remainingMicro: 80,
      currency: 'EUR<script>', providerReportedCalls: 1, conservativeCalls: 2 } };
    const unavailable = { textSession: { view: { state: null, transcript: [], durability: null, unavailable: true }, canAct: true } };
    for (const html of [page({}, model), page({ durability: { ...durable, unacknowledged: 1 } }, model), page({}, { ...model, ...unavailable })]) {
      assert.equal((html.match(/Configured estimated spend:/g) ?? []).length, 1);
      assert.match(html, /20 integer micro-EUR&lt;script&gt; accounted of 100; 80 remains/);
      assert.ok(html.indexOf('id="text-durability"') < html.indexOf('Configured estimated spend:'));
      assert.ok(html.indexOf('Configured estimated spend:') < html.indexOf('id="text-conversation"'));
      assert.deepEqual(auditAccessibility(html).problems, []);
    }
    const legacy = page({}, { ...model, textSession: undefined });
    assert.equal((legacy.match(/Configured estimated spend:/g) ?? []).length, 1);
    assert.match(page({}, { policyActive: true }), /Billing usage is unavailable/);
    assert.ok(!page({}, { ...model, policyActive: false }).includes('Configured estimated spend:'));
  });

  it('removes legacy preview, upload and interpretation controls only for attached text sessions', () => {
    const base = { project_ref: 'p1', title: 'Project', revision: 1, conversation_ref: 'c1', project_kinds: ['new_product'],
      stream: { proposals: [], decisions: [], baselines: [] }, transcript: [], documents: [{
        document_ref: 'doc-1', filename: 'requirements.txt', media_type: 'text/plain', extraction_reason: 'ok', source_kind: 'generic',
      }] };
    const model = { project: base, previewCapability: { previewUrl: 'https://preview.invalid/artifact', previewOrigin: 'https://preview.invalid',
      artifactRevision: 'r1', bindingKey: 'b1', nonce: 'n1', turnId: 't1' } };
    const html = page({}, model);
    const actions = find(parseHtml(html), (n) => n.tag === 'form').map((n) => n.attrs.action);
    assert.ok(!actions.some((action) => /\/(preview-feedback|documents)(\/|$)/.test(action)));
    assert.match(html, /Send preview feedback through the text session/);
    assert.match(html, /Document upload and interpretation are unavailable/);
    assert.ok(html.includes('<iframe'), 'the configured preview remains viewable');
    assert.deepEqual(auditAccessibility(html).problems, []);
    const legacy = page({}, { ...model, textSession: undefined });
    const legacyActions = find(parseHtml(legacy), (n) => n.tag === 'form').map((n) => n.attrs.action);
    for (const suffix of ['/preview-feedback', '/documents', '/documents/doc-1/interpret']) {
      assert.ok(legacyActions.some((action) => action.endsWith(suffix)), suffix);
    }
  });

  it('prefixes every action with the public base path', () => {
    const tree = parseHtml(page());
    const actions = find(tree, (n) => n.tag === 'form' && Object.hasOwn(n.attrs, 'data-text-turn-form') || Object.hasOwn(n.attrs, 'data-text-confirm-form'))
      .map((n) => n.attrs.action);
    assert.ok(actions.length >= 3);
    for (const action of actions) assert.match(action, /^\/mnt\/projects\/p1\/text\/(turns|confirm)$/);
  });
});

describe('client enhancement helpers', () => {
  it('finds only transcript entries that are not on the page yet', () => {
    assert.deepEqual(unseenSeqs(['1', '2'], ['1', '2', '3', '4']), ['3', '4']);
    assert.deepEqual(unseenSeqs([], []), []);
    assert.deepEqual(unseenSeqs(new Set(['3']), ['3']), []);
  });

  it('does nothing without a transcript region or fetch', () => {
    assert.equal(bindTextUi({ getElementById: () => null }, {}, () => {}), null);
    assert.equal(bindTextUi({ getElementById: () => ({}) }, {}, null), null);
  });
});
