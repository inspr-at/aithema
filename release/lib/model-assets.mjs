const fields = ['id', 'kind', 'source', 'license', 'sha256', 'bytes'];
const headers = ['ID', 'Kind', 'Source', 'License', 'SHA-256', 'Bytes'];
const noneRow = ['none bundled', '—', '—', '—', '—', '—'];

/** Validate the closed model/voice inventory; hashes are lowercase SHA-256 hex. */
export function validateModelAssets(assets) {
  if (!Array.isArray(assets)) throw new Error('NOTICES.json model_assets must be an array');
  const ids = new Set();
  for (const [index, entry] of assets.entries()) {
    const label = `NOTICES.json model_assets[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).sort().join(',') !== [...fields].sort().join(',')) {
      throw new Error(`${label} must contain exactly ${fields.join(', ')}`);
    }
    for (const key of ['id', 'source', 'license']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()
          || entry[key].trim() !== entry[key] || /[\r\n\x00-\x1f]/.test(entry[key])) {
        throw new Error(`${label}.${key} must be a non-empty single-line string`);
      }
    }
    if (!['weights', 'voice'].includes(entry.kind)) throw new Error(`${label}.kind must be weights or voice`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`${label}.sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`${label}.bytes must be a non-negative safe integer`);
    }
    if (ids.has(entry.id)) throw new Error(`${label}: duplicate model asset id ${entry.id}`);
    ids.add(entry.id);
  }
  return assets;
}

function tableCells(line) {
  const cells = [];
  let cell = '';
  const text = line.trim();
  if (!text.startsWith('|') || !text.endsWith('|')) throw new Error('README model assets table needs enclosing pipes');
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] === '\\' && ['|', '\\'].includes(text[i + 1])) cell += text[++i];
    else if (text[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += text[i];
  }
  cells.push(cell.trim());
  return cells.map((value) => /^`[^`]*`$/.test(value) ? value.slice(1, -1) : value);
}

function visibleLines(readme) {
  let fence;
  return readme.replace(/<!--(?:[\s\S]*?-->|[\s\S]*$)/g, (comment) => comment.replace(/[^\r\n]/g, ''))
    .split(/\r?\n/).map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence[0] && marker.length >= fence.length
            && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
        return '';
      }
      if (marker) { fence = marker; return ''; }
      return line;
    });
}

/** Require a one-to-one table inside README's existing Provenance section. */
export function verifyModelAssets(notices, readme) {
  const assets = validateModelAssets(notices?.model_assets);
  const lines = visibleLines(readme);
  const sections = lines.flatMap((line, i) => /^## Provenance\s*$/.test(line) ? [i] : []);
  if (sections.length !== 1) throw new Error('README.md must have exactly one Provenance section');
  const start = sections[0] + 1;
  const end = lines.findIndex((line, i) => i >= start && /^#{1,2} /.test(line));
  const provenance = lines.slice(start, end === -1 ? undefined : end);
  const titles = provenance.flatMap((line, i) => /^### Model weights and voices\s*$/.test(line) ? [i] : []);
  if (titles.length !== 1) throw new Error('README Provenance needs exactly one Model weights and voices table');
  const tableStart = titles[0] + 1;
  const tableEnd = provenance.findIndex((line, i) => i >= tableStart && /^#{1,3} /.test(line));
  const rows = provenance.slice(tableStart, tableEnd === -1 ? undefined : tableEnd)
    .filter((line) => /^ {0,3}\|/.test(line)).map(tableCells);
  if (JSON.stringify(rows[0]) !== JSON.stringify(headers)
      || rows[1]?.length !== fields.length || !rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))) {
    throw new Error('README model assets table has invalid headers or separator');
  }
  const actual = rows.slice(2);
  const expected = assets.length ? assets.map((asset) => fields.map((key) => String(asset[key]))) : [noneRow];
  const sortRows = (items) => [...items].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (JSON.stringify(sortRows(actual)) !== JSON.stringify(sortRows(expected))) {
    throw new Error('README Model weights and voices table must match NOTICES.json model_assets 1:1 (none bundled when empty)');
  }
  return assets.length;
}
