import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../../core/src/session.js';
import { buildPaimosPayload, paimosImportUrl, PAIMOS_PAYLOAD_MAX_BYTES } from '../src/paimos-import.js';

const at = '2026-10-16T10:00:00.000Z';
const context = { host: 'start.example.test:3000', fallbackTitle: 'Understanding' };
const bytes = payload => Buffer.byteLength(JSON.stringify(payload), 'utf8');
function fixture(locale = 'en') {
  const session = createSession({ id: 'session-fixture', locale });
  Object.assign(session.understanding, { summary: 'A preorder app\nFor a local bakery.', signals: ['Orders arrive by phone'], openQuestions: ['Which payment methods?'] });
  session.transcript = [
    { id: 't1', role: 'user', content: 'We need a preorder app. 🥐', at },
    { id: 'a1', role: 'assistant', content: 'Which payment methods?', at, origin: 'ai-generated', model: 'fixture/model' },
    { id: 'gone1', role: 'user', content: 'Erased private text', at, erased: true },
    { id: 'gone2', role: 'assistant', content: 'Withdrawn reply', at, withdrawn: true },
  ];
  return session;
}

test('v1 maps the exported active conversation and overview without mutating them or including credentials', () => {
  const session = fixture(), original = structuredClone(session);
  session.sessionToken = 'must-not-leave-aithema'; original.sessionToken = session.sessionToken;
  const payload = buildPaimosPayload(session, context);
  assert.deepEqual(payload, {
    version: 1, source: { product: 'aithema', host: context.host, session_id: session.id }, language: 'en',
    title: 'A preorder app', summary: session.understanding.summary,
    facts: ['Orders arrive by phone'], open_points: ['Which payment methods?'],
    transcript: session.transcript.slice(0, 2).map(({ role, content, at }) => ({ role, text: content, at })),
  });
  payload.facts.push('Payload-only fact'); payload.open_points.push('Payload-only question'); payload.transcript[0].text = 'Payload-only text';
  assert.deepEqual(session, original);
  session.understanding.summary = '';
  assert.equal(buildPaimosPayload(session, context).title, context.fallbackTitle);
  session.understanding.summary = 'x'.repeat(250);
  assert.equal(buildPaimosPayload(session, context).title.length, 200);
});

test('contract v1 (AEON-1441): exactly 512 KiB fits; one UTF-8 byte more drops the oldest whole turn and counts the summary note', () => {
  const session = fixture(); session.transcript = session.transcript.slice(0, 2);
  session.transcript[0].content = '🥐';
  const spare = PAIMOS_PAYLOAD_MAX_BYTES - bytes(buildPaimosPayload(session, context));
  session.transcript[0].content += 'x'.repeat(spare);
  const exact = buildPaimosPayload(session, context);
  assert.equal(bytes(exact), PAIMOS_PAYLOAD_MAX_BYTES);
  assert.equal(exact.summary, session.understanding.summary);
  session.transcript[0].content += 'x';
  const trimmed = buildPaimosPayload(session, context);
  assert.deepEqual(trimmed.transcript, [exact.transcript[1]], 'newest turn survives unchanged');
  assert.equal(trimmed.summary, `${session.understanding.summary}\n\nThe oldest conversation turns were omitted to meet the size limit.`);
  assert.ok(bytes(trimmed) <= PAIMOS_PAYLOAD_MAX_BYTES);
});

test('contract v1 (AEON-1441): title is unchanged at 200 code points and trimmed at 201, preserving surrogate pairs', () => {
  const session = fixture();
  const title = 'x'.repeat(199) + '🥐';
  session.understanding.summary = title;
  assert.equal(buildPaimosPayload(session, context).title, title);
  session.understanding.summary += 'x';
  assert.equal(buildPaimosPayload(session, context).title, title);
  session.understanding.summary = `${title}more\nSecond line`;
  assert.equal(buildPaimosPayload(session, context).title, title);
  session.understanding.summary = '';
  assert.equal(buildPaimosPayload(session, { ...context, fallbackTitle: title + 'more' }).title, title);
});

// All field and byte boundaries below come from contract v1 (AEON-1441).
for (const [field, source, limit] of [['summary', 'summary', 4000], ['facts', 'signals', 500], ['open_points', 'openQuestions', 500]]) {
  test(`contract v1 (AEON-1441): ${field} is unchanged at ${limit} code points; one over ends in a counted ellipsis`, () => {
    const session = fixture(), exact = 'x'.repeat(limit - 2) + '🥐y';
    const assign = value => { session.understanding[source] = field === 'summary' ? value : [value]; };
    const read = () => { const payload = buildPaimosPayload(session, context); return field === 'summary' ? payload[field] : payload[field][0]; };
    assign(exact); assert.equal(read(), exact);
    assign(exact + 'z'); const original = structuredClone(session);
    assert.equal(read(), 'x'.repeat(limit - 2) + '🥐…');
    assert.equal(Array.from(read()).length, limit);
    assert.deepEqual(session, original);
  });
}

for (const [field, source] of [['facts', 'signals'], ['open_points', 'openQuestions']]) {
  test(`contract v1 (AEON-1441): ${field} keeps exactly 50 items and drops the later 51st item`, () => {
    const session = fixture(), items = Array.from({ length: 50 }, (_, index) => `Item ${index}`);
    session.understanding[source] = [...items];
    assert.deepEqual(buildPaimosPayload(session, context)[field], items);
    session.understanding[source].push('Later item');
    assert.deepEqual(buildPaimosPayload(session, context)[field], items);
    assert.equal(session.understanding[source].length, 51);
  });
}

test('contract v1 (AEON-1441): exactly 2,000 active transcript turns stay unchanged; one over drops the oldest', () => {
  const session = fixture();
  session.transcript = Array.from({ length: 2000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}`, at }));
  const exact = buildPaimosPayload(session, context);
  assert.deepEqual(exact.transcript, session.transcript.map(({ role, content, at }) => ({ role, text: content, at })));
  assert.equal(exact.summary, session.understanding.summary);
  session.transcript.unshift({ role: 'user', content: 'Oldest turn', at });
  session.transcript.push({ role: 'assistant', content: 'Withdrawn', at, withdrawn: true });
  const trimmed = buildPaimosPayload(session, context);
  assert.deepEqual(trimmed.transcript, exact.transcript);
  assert.equal(trimmed.summary, `${exact.summary}\n\nThe oldest conversation turns were omitted to meet the size limit.`);
});

for (const locale of ['de', 'en']) for (const reason of ['turn count', 'bytes']) {
  test(`contract v1 (AEON-1441): ${locale} omitted note fits a near-4,000 summary after ${reason} trimming`, () => {
    const session = fixture(locale);
    const note = locale === 'de' ? 'Die ältesten Gesprächsbeiträge wurden wegen der Größenbegrenzung weggelassen.' : 'The oldest conversation turns were omitted to meet the size limit.';
    const bodyLimit = 4000 - Array.from(note).length - 2;
    session.understanding.summary = 'x'.repeat(bodyLimit - 2) + '🥐' + 'y'.repeat(4000 - bodyLimit + 1);
    if (reason === 'turn count') session.transcript = Array.from({ length: 2001 }, (_, i) => ({ role: 'user', content: `Turn ${i}`, at }));
    else session.transcript = [{ role: 'user', content: 'x'.repeat(PAIMOS_PAYLOAD_MAX_BYTES), at }, { role: 'assistant', content: 'Newest', at }];
    const original = structuredClone(session), payload = buildPaimosPayload(session, context);
    assert.equal(payload.summary, 'x'.repeat(bodyLimit - 2) + `🥐…\n\n${note}`);
    assert.equal(Array.from(payload.summary).length, 4000);
    assert.equal(payload.transcript.length, reason === 'turn count' ? 2000 : 1);
    assert.ok(bytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES);
    assert.deepEqual(session, original);
  });
}

test('contract v1 (AEON-1441): count and byte caps both remove oldest turns and add the note once', () => {
  const session = fixture();
  session.transcript = Array.from({ length: 2001 }, (_, index) => ({ role: 'user', content: index < 2 ? 'x'.repeat(PAIMOS_PAYLOAD_MAX_BYTES) : `Turn ${index}`, at }));
  const payload = buildPaimosPayload(session, context);
  assert.deepEqual(payload.transcript, session.transcript.slice(2).map(({ role, content, at }) => ({ role, text: content, at })));
  assert.equal(payload.summary.split('The oldest conversation turns').length - 1, 1);
  assert.ok(bytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES);
});

for (const locale of ['de', 'en', 'fr']) test(`contract v1 (AEON-1441): byte cap removes only the necessary oldest turns and localizes the note (${locale})`, () => {
  const session = fixture(); session.locale = locale;
  session.transcript = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: undefined,
    content: `${index}:` + '漢🥐"\\\n'.repeat(8000), at }));
  const original = structuredClone(session), payload = buildPaimosPayload(session, context);
  assert.ok(payload.transcript.length > 0 && payload.transcript.length < session.transcript.length);
  const dropped = session.transcript.length - payload.transcript.length;
  assert.deepEqual(payload.transcript, session.transcript.slice(dropped).map(({ role, content, at }) => ({ role, text: content, at })));
  assert.ok(bytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES);
  const previous = session.transcript[dropped - 1];
  assert.ok(bytes({ ...payload, transcript: [{ role: previous.role, text: previous.content, at: previous.at }, ...payload.transcript] }) > PAIMOS_PAYLOAD_MAX_BYTES);
  assert.match(payload.summary, locale === 'de' ? /ältesten Gesprächsbeiträge/u : /oldest conversation turns/u);
  assert.deepEqual(session, original);
});

test('contract v1 (AEON-1441): oversized turns are omitted, overview fields are bounded and oversized metadata fails closed', () => {
  const session = fixture(); session.transcript = [{ role: 'user', content: 'x'.repeat(PAIMOS_PAYLOAD_MAX_BYTES), at }];
  const payload = buildPaimosPayload(session, context);
  assert.deepEqual(payload.transcript, []); assert.ok(bytes(payload) <= PAIMOS_PAYLOAD_MAX_BYTES);
  session.understanding.summary = 'x'.repeat(PAIMOS_PAYLOAD_MAX_BYTES);
  const bounded = buildPaimosPayload(session, context);
  assert.equal(Array.from(bounded.summary).length, 4000);
  assert.ok(bytes(bounded) <= PAIMOS_PAYLOAD_MAX_BYTES);
  assert.throws(() => buildPaimosPayload(session, { ...context, host: 'x'.repeat(PAIMOS_PAYLOAD_MAX_BYTES) }), RangeError);
});

test('host options require numeric v1 and a full HTTP(S) URL without credentials', () => {
  for (const url of ['https://paimos.example.test/import/project-draft', 'http://localhost:3001/import/project-draft']) {
    assert.equal(paimosImportUrl({ paimosImportUrl: url, paimosImportVersion: 1 }), url);
  }
  for (const options of [undefined, {}, ...[undefined, 0, 2, '1'].map(version => ({ paimosImportUrl: 'https://paimos.example.test', paimosImportVersion: version })),
    ...['', '/import/project-draft', '//paimos.example.test/import/project-draft', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/import',
      'https://', 'https://user:password@paimos.example.test/import/project-draft', ' https://paimos.example.test', 'https://paimos.example.test/\nimport',
      'https:\\paimos.example.test', 1].map(url => ({ paimosImportUrl: url, paimosImportVersion: 1 }))]) {
    assert.equal(paimosImportUrl(options), null);
  }
});
