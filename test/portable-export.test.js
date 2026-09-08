import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractTextItems, getDocumentProxy } from 'unpdf';

import {
  createStream,
  proposeRequirement,
  proposeConstraint,
  approveBaselineFromProposals,
  exportReviewedHandover,
  exportReviewedCsv,
  exportReviewedHtml,
  exportReviewedPdf,
  htmlExportHasActiveContent,
  findApprovedBaseline,
  currentBaseline,
  handoverRevisionIdentity,
  exportHandoverJson,
  proposeRequirementUpdate,
  neutraliseSpreadsheetFormula,
} from '../lib/index.js';
import { fontKeyForCodePoint, formatUnsupportedPdfCharacter, unsupportedPdfCharacters } from '../lib/fonts.js';

const contributor = { party_ref: 'party:contributor', roles: ['delivery_party'] };
const approver = { party_ref: 'party:approver', roles: ['requirements_approver'] };
const QA_DIR = '/tmp/aithema-ait-7-portable-handover-qa';

function reviewedStream() {
  let stream = createStream('stream:portable', ['new_product']);
  stream = proposeRequirement(stream, contributor, {
    requirement_ref: 'req.unicode',
    statement: 'Users can read Straße café — and <script>alert(1)</script> stays text',
    acceptance_criteria: ['=cmd|\' /C calc\'!A0 is not a formula', 'Long-id wraps: baseline:very-long-identifier-that-must-wrap'],
    constraint_refs: ['constraint:data.eu'],
  });
  stream = proposeConstraint(stream, contributor, {
    constraint_ref: 'constraint:data.eu',
    kind: 'data',
    statement: 'Personal data stays in the EU',
  });
  stream = approveBaselineFromProposals(
    stream,
    approver,
    stream.proposals.map((proposal) => proposal.proposal_ref),
    'baseline:portable-v1',
    '2026-09-07T16:00:00.000Z',
  );
  const first = currentBaseline(stream);
  stream = proposeRequirementUpdate(stream, contributor, {
    requirement_ref: 'req.unicode',
    statement: 'Pending note must not appear in reviewed exports',
    acceptance_criteria: ['Still a proposal'],
    constraint_refs: ['constraint:data.eu'],
  });
  stream = approveBaselineFromProposals(
    stream,
    approver,
    [stream.proposals.at(-1).proposal_ref],
    'baseline:portable-v2',
    '2026-09-07T16:10:00.000Z',
  );
  return { stream, first };
}

function approveRequirements(streamRef, baselineRef, requirements, constraints = []) {
  let stream = createStream(streamRef, ['new_product']);
  for (const requirement of requirements) {
    stream = proposeRequirement(stream, contributor, requirement);
  }
  for (const constraint of constraints) {
    stream = proposeConstraint(stream, contributor, constraint);
  }
  return approveBaselineFromProposals(
    stream,
    approver,
    stream.proposals.map((proposal) => proposal.proposal_ref),
    baselineRef,
    '2026-09-07T16:00:00.000Z',
  );
}

async function pdfPages(pdf) {
  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const extracted = await extractText(proxy, { mergePages: false });
    const items = await extractTextItems(proxy);
    const page = await proxy.getPage(1);
    const pageWidth = page.getViewport({ scale: 1 }).width;
    return {
      totalPages: extracted.totalPages,
      texts: extracted.text,
      items: items.items,
      pageWidth,
    };
  } finally {
    await proxy.loadingTask?.destroy?.();
  }
}

function compactText(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

describe('reviewed portable export', () => {
  it('JSON, CSV, HTML and PDF bind one explicit retained revision and omit pending notes', async () => {
    const { stream, first } = reviewedStream();
    const identity = { baseline_ref: first.baseline_ref, revision: first.revision };
    const json = exportReviewedHandover(stream, identity, '2026-09-07T16:20:00.000Z');
    const csv = exportReviewedCsv(stream, identity, undefined, '2026-09-07T16:20:00.000Z');
    const html = exportReviewedHtml(json);
    const pdf = await exportReviewedPdf(json);

    assert.equal(json.pending_proposals.length, 0);
    assert.equal(json.decisions.length, 0);
    assert.equal(json.baseline.revision, 1);
    assert.equal(json.baseline.content_digest, first.content_digest);
    assert.equal(json.baseline.revision_seal, first.revision_seal);
    assert.equal(handoverRevisionIdentity(json).baseline_ref, 'baseline:portable-v1');
    assert.equal(csv.includes('Pending note must not appear'), false);
    assert.ok(csv.includes(first.content_digest));
    assert.ok(csv.includes(first.revision_seal));
    assert.ok(csv.includes(neutraliseSpreadsheetFormula('=cmd|\' /C calc\'!A0 is not a formula')));
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(htmlExportHasActiveContent(html), false);
    assert.match(html, /Straße café/);
    assert.doesNotMatch(html, /https?:\/\/[^\s]+/);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdf.includes(Buffer.from('/JavaScript')), false);

    const proxy = await getDocumentProxy(new Uint8Array(pdf));
    try {
      const extracted = await extractText(proxy, { mergePages: false });
      const items = await extractTextItems(proxy);
      const page = await proxy.getPage(1);
      const pageWidth = page.getViewport({ scale: 1 }).width;
      assert.equal(extracted.totalPages, 1);
      assert.ok(extracted.totalPages >= 1 && extracted.totalPages <= 2);
      const text = extracted.text.join('\n');
      assert.match(text, /Straße café/);
      assert.match(text, /baseline:portable-v1/);
      assert.ok(text.includes(first.content_digest));
      assert.equal(text.includes('Pending note must not appear'), false);
      assert.match(extracted.text[0], /Page 1 of 1/);
      const footer = items.items[0].filter((item) => /^Page \d+ of \d+$/.test(item.str.trim()));
      assert.equal(footer.length, 1);
      assert.ok(footer[0].y < 120, `footer must stay in the bottom margin, y=${footer[0].y}`);
      const rightEdge = Math.max(...items.items[0].map((item) => item.x + item.width));
      assert.ok(rightEdge <= pageWidth + 0.75, `text clipped the page edge at ${rightEdge} > ${pageWidth}`);
    } finally {
      await proxy.loadingTask?.destroy?.();
    }

    mkdirSync(QA_DIR, { recursive: true });
    writeFileSync(`${QA_DIR}/reviewed-r1.json`, `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(`${QA_DIR}/reviewed-r1.csv`, csv);
    writeFileSync(`${QA_DIR}/reviewed-r1.html`, html);
    writeFileSync(`${QA_DIR}/reviewed-r1.pdf`, pdf);
  });

  it('refuses an unknown revision instead of exporting the mutable latest', () => {
    const { stream } = reviewedStream();
    const latest = currentBaseline(stream);
    assert.throws(
      () => findApprovedBaseline(stream, { baseline_ref: latest.baseline_ref, revision: 99 }),
      /no approved baseline/,
    );
    assert.throws(
      () => exportReviewedHandover(stream, { baseline_ref: latest.baseline_ref, revision: 1 }),
      /no approved baseline/,
    );
  });

  it('full stream handover still exists and can include pending notes unlike reviewed export', () => {
    const { stream, first } = reviewedStream();
    const full = exportHandoverJson(stream, '2026-09-07T16:20:00.000Z');
    assert.equal(full.baseline.revision, 2);
    assert.notEqual(full.baseline.content_digest, first.content_digest);
    const reviewed = exportReviewedHandover(stream, {
      baseline_ref: first.baseline_ref,
      revision: first.revision,
    });
    assert.equal(reviewed.baseline.content_digest, first.content_digest);
  });

  it('keeps a long unbroken identifier on the sheet and preserves every character', async () => {
    assert.equal(fontKeyForCodePoint('A'.codePointAt(0)), 'latin');
    assert.equal(fontKeyForCodePoint('漢'.codePointAt(0)), null);
    assert.deepEqual(unsupportedPdfCharacters('Straße café Ελληνικά Кириллица 漢字'), ['漢', '字']);

    const token = `urn:aithema:baseline:IDBEGIN${'W'.repeat(220)}IDEND`;
    const stream = approveRequirements('stream:wrap', 'baseline:wrap', [{
      requirement_ref: 'req.wrap',
      statement: token,
      acceptance_criteria: ['Every character of the unbroken identifier remains'],
      constraint_refs: [],
    }]);
    const pdf = await exportReviewedPdf(exportReviewedHandover(stream, {
      baseline_ref: 'baseline:wrap',
      revision: 1,
    }, '2026-09-07T16:20:00.000Z'));
    const pages = await pdfPages(pdf);
    assert.equal(pages.totalPages, 1);
    assert.ok(pages.totalPages >= 1 && pages.totalPages <= 2);
    assert.match(pages.texts[0], /Page 1 of 1/);
    assert.ok(
      compactText(pages.texts.join('')).includes(`IDBEGIN${'W'.repeat(220)}IDEND`),
      'wrapped identifier lost characters',
    );
    const rightEdge = Math.max(...pages.items.flat().map((item) => item.x + item.width));
    assert.ok(rightEdge <= pages.pageWidth + 0.75, `identifier ran off the page at ${rightEdge}`);
    const footer = pages.items[0].filter((item) => /^Page \d+ of \d+$/.test(item.str.trim()));
    assert.equal(footer.length, 1);
    assert.ok(footer[0].y < 120, `footer y=${footer[0].y} is not on the content page bottom`);
  });

  it('numbers every content page and does not append footer-only pages', async () => {
    const requirements = Array.from({ length: 14 }, (_, index) => ({
      requirement_ref: `req.multi.${index + 1}`,
      statement: `Requirement ${index + 1} keeps pagination honest. ${'Need enough body text to fill the printable area of an A4 page. '.repeat(8)}`,
      acceptance_criteria: [
        `Criterion ${index + 1}a ${'acceptance detail '.repeat(12)}`,
        `Criterion ${index + 1}b ${'more wrapping text '.repeat(12)}`,
      ],
      constraint_refs: [],
    }));
    const stream = approveRequirements('stream:pages', 'baseline:pages', requirements);
    const pdf = await exportReviewedPdf(exportReviewedHandover(stream, {
      baseline_ref: 'baseline:pages',
      revision: 1,
    }, '2026-09-07T16:20:00.000Z'));
    const pages = await pdfPages(pdf);
    assert.ok(pages.totalPages >= 2, `expected a multi-page PDF, got ${pages.totalPages}`);
    assert.ok(pages.totalPages <= 8, `unexpected extra pages: ${pages.totalPages}`);
    assert.equal(pages.texts.length, pages.totalPages);
    for (const [index, text] of pages.texts.entries()) {
      assert.match(text, new RegExp(`Page ${index + 1} of ${pages.totalPages}`));
      assert.equal(/^\s*Page \d+ of \d+\s*$/.test(text), false, `page ${index + 1} is footer-only`);
      const footer = pages.items[index].filter((item) => /^Page \d+ of \d+$/.test(item.str.trim()));
      assert.equal(footer.length, 1);
      assert.ok(footer[0].y < 120, `page ${index + 1} footer y=${footer[0].y} left the bottom margin`);
    }
    const compact = compactText(pages.texts.join(''));
    for (const requirement of requirements) {
      assert.ok(compact.includes(compactText(requirement.requirement_ref)));
      assert.ok(compact.includes(compactText(`Requirement ${requirement.requirement_ref.slice('req.multi.'.length)} keeps pagination honest.`)));
    }
  });

  it('embeds documented scripts and refuses unsupported glyphs instead of dropping them', async () => {
    const supported = approveRequirements('stream:scripts', 'baseline:scripts', [{
      requirement_ref: 'req.scripts',
      statement: 'Users can read Straße café Ελληνικά Кириллица',
      acceptance_criteria: ['Latin, Greek, and Cyrillic stay in the PDF'],
      constraint_refs: [],
    }]);
    const supportedPdf = await exportReviewedPdf(exportReviewedHandover(supported, {
      baseline_ref: 'baseline:scripts',
      revision: 1,
    }, '2026-09-07T16:20:00.000Z'));
    const supportedPages = await pdfPages(supportedPdf);
    const supportedText = supportedPages.texts.join('\n');
    assert.match(supportedText, /Straße café/);
    assert.match(supportedText, /Ελληνικά/);
    assert.match(supportedText, /Кириллица/);
    assert.equal(supportedPages.totalPages, 1);

    const cjk = approveRequirements('stream:cjk', 'baseline:cjk', [{
      requirement_ref: 'req.cjk',
      statement: 'Users can read Straße café Ελληνικά Кириллица 漢字',
      acceptance_criteria: ['CJK must not become missing glyphs'],
      constraint_refs: [],
    }]);
    const handover = exportReviewedHandover(cjk, {
      baseline_ref: 'baseline:cjk',
      revision: 1,
    }, '2026-09-07T16:20:00.000Z');
    await assert.rejects(
      () => exportReviewedPdf(handover),
      (error) => {
        assert.equal(error.code, 'export_pdf_unsupported_script');
        assert.match(error.message, /HTML or JSON/);
        assert.match(error.message, /U\+6F22|cannot paint/);
        assert.match(error.message, /subset files only \(not full Unicode coverage\)/);
        assert.doesNotMatch(error.message, /Latin Extended Additional|universal/i);
        return true;
      },
    );
    const html = exportReviewedHtml(handover);
    assert.match(html, /漢字/);
    assert.match(JSON.stringify(handover), /漢字/);
  });

  it('refuses Vietnamese and invisible word-processor punctuation with readable codepoint samples', async () => {
    assert.equal(fontKeyForCodePoint('ệ'.codePointAt(0)), null);
    assert.equal(formatUnsupportedPdfCharacter('\u202F'), 'U+202F');
    assert.equal(formatUnsupportedPdfCharacter('\u2192'), 'U+2192');

    const vietnamese = approveRequirements('stream:vi', 'baseline:vi', [{
      requirement_ref: 'req.vi',
      statement: 'Users can read tiếng Việt with ệ',
      acceptance_criteria: ['Latin Extended Additional is not embedded'],
      constraint_refs: [],
    }]);
    await assert.rejects(
      () => exportReviewedPdf(exportReviewedHandover(vietnamese, {
        baseline_ref: 'baseline:vi',
        revision: 1,
      }, '2026-09-07T16:20:00.000Z')),
      (error) => {
        assert.equal(error.code, 'export_pdf_unsupported_script');
        assert.match(error.message, /U\+1EC7|U\+1EBF|U\+1EC7/);
        assert.match(error.message, /not full Unicode coverage/);
        return true;
      },
    );

    const invisible = approveRequirements('stream:invisible', 'baseline:invisible', [{
      requirement_ref: 'req.invisible',
      statement: 'Paste\u202Fwith\u2007spaces\u200Eand\u2011hyphen',
      acceptance_criteria: ['→ and ✓ stay unsupported too: \u2192 \u2713'],
      constraint_refs: [],
    }]);
    await assert.rejects(
      () => exportReviewedPdf(exportReviewedHandover(invisible, {
        baseline_ref: 'baseline:invisible',
        revision: 1,
      }, '2026-09-07T16:20:00.000Z')),
      (error) => {
        assert.match(error.message, /U\+202F/);
        assert.match(error.message, /U\+2007/);
        assert.match(error.message, /U\+200E/);
        assert.match(error.message, /U\+2011/);
        assert.match(error.message, /U\+2192/);
        assert.match(error.message, /U\+2713/);
        return true;
      },
    );
  });
});
