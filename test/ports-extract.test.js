import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { activePdfParserCount, extractDocument, extractPdfInChild } from '../runtime/extract.js';
import { MAX_CHARS_PER_FILE } from '../lib/extract-limits.js';
import { createStream, exportHandoverJson } from '../lib/index.js';

const bytes = (text) => Buffer.from(text, 'utf8');

function observeFork(t) {
  const fork = childProcess.fork;
  let signal;
  const spawned = new Promise((resolve) => { signal = resolve; });
  const children = [];
  t.mock.method(childProcess, 'fork', (...args) => {
    // Observe the real parser; no substitute parser or remote host is involved.
    const child = fork(...args);
    children.push(child);
    signal({ child, exited: once(child, 'exit') });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { spawned, children };
}

describe('extraction port cancellation and preserved behavior', () => {
  for (const mimeType of ['text/plain', 'application/json', 'application/pdf', 'image/png']) {
    it(`rejects pre-cancelled ${mimeType} extraction without spawning a parser`, async (t) => {
      const observed = observeFork(t);
      const abort = new AbortController(); abort.abort();
      await assert.rejects(extractDocument(bytes('synthetic'), mimeType, { signal: abort.signal }), { name: 'AbortError', code: 'cancelled' });
      assert.equal(observed.children.length, 0);
      assert.equal(activePdfParserCount(), 0);
    });
  }

  it('does not spawn if cancelled while immediate slot acquisition is yielding', async (t) => {
    const observed = observeFork(t);
    const abort = new AbortController();
    const work = extractPdfInChild(bytes('%PDF-1.7'), { signal: abort.signal });
    const rejected = assert.rejects(work, { name: 'AbortError', code: 'cancelled' });
    abort.abort();
    await rejected;
    assert.equal(observed.children.length, 0);
    assert.equal(activePdfParserCount(), 0);
  });

  it('SIGKILLs an actual in-flight PDF child and rejects promptly', async (t) => {
    const observed = observeFork(t);
    const abort = new AbortController();
    const work = extractDocument(bytes('%PDF-1.7\nsynthetic incomplete PDF'), 'application/pdf', { signal: abort.signal });
    const rejected = assert.rejects(work, { name: 'AbortError', code: 'cancelled' });
    const { child, exited } = await observed.spawned;
    assert.equal(activePdfParserCount(), 1);
    const start = performance.now();
    abort.abort();
    await rejected;
    assert.ok(performance.now() - start < 1000, 'cancellation waited for the extraction deadline');
    assert.equal(child.killed, true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH');
    assert.equal(activePdfParserCount(), 0);
  });

  it('removes a cancelled queued request, frees the slot, and lets a later parser finish', async (t) => {
    const observed = observeFork(t);
    const runningAbort = new AbortController();
    const active = extractPdfInChild(bytes('%PDF-1.7'), { signal: runningAbort.signal });
    const activeRejected = assert.rejects(active, { name: 'AbortError' });
    const { exited } = await observed.spawned;
    const queuedAbort = new AbortController();
    const queued = extractPdfInChild(bytes('%PDF-1.7'), { signal: queuedAbort.signal });
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
    queuedAbort.abort();
    await queuedRejected;
    assert.equal(observed.children.length, 1);
    assert.equal(activePdfParserCount(), 1);
    runningAbort.abort();
    await activeRejected;
    await exited;
    const result = await extractPdfInChild(bytes('clearly not a PDF'));
    assert.deepEqual(result, { text: null, reason: 'malformed', truncated: false });
    assert.equal(observed.children.length, 2);
    assert.equal(activePdfParserCount(), 0);
  });

  it('preserves normalization, plain text, JSON uncertainty, empty and unsupported results', async () => {
    const signal = new AbortController().signal;
    assert.deepEqual(await extractDocument(bytes('  a\r\n\n\n\n\nb  '), 'text/plain', { signal }), {
      text: 'a\n\n\nb', reason: 'ok', truncated: false, media_type: 'text/plain', own_format: false,
    });
    const json = await extractDocument(bytes('{broken JSON'), 'application/json', { signal });
    assert.equal(json.text, '{broken JSON');
    assert.equal(json.uncertainty, 'json_parse_failed');
    assert.equal((await extractDocument(bytes(''), 'text/plain', { signal })).reason, 'empty');
    assert.equal((await extractDocument(bytes('demo'), 'image/png', { signal })).reason, 'unsupported');
    assert.equal((await extractDocument(bytes('a,b\n1,2'), 'application/octet-stream', { filename: 'demo.csv', signal })).media_type, 'text/csv');
  });

  it('preserves bounded text and inert XML without fetching external entities', async () => {
    const long = await extractDocument(bytes('a'.repeat(MAX_CHARS_PER_FILE + 1)), 'text/plain');
    assert.equal(long.text.length, MAX_CHARS_PER_FILE);
    assert.equal(long.truncated, true);
    const xml = '<!DOCTYPE demo [<!ENTITY x SYSTEM "https://never-contact.example.invalid/">]><demo>&x;</demo>';
    const result = await extractDocument(bytes(xml), 'application/xml');
    assert.equal(result.text, xml);
    assert.equal(result.reason, 'ok');
  });

  it('preserves recognition of the existing own-format JSON handover', async () => {
    const handover = exportHandoverJson(createStream('stream:ports-demo', ['new_product']));
    const result = await extractDocument(bytes(JSON.stringify(handover)), 'application/json', { signal: new AbortController().signal });
    assert.equal(result.own_format, true);
    assert.deepEqual(result.parsed, handover);
  });
});
