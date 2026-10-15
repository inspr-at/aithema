// Explicit historical declarations from the archived release manifests; never inferred from punctuation.
const legacySchemes = ['legacy', 'legacy-semver-public', 'legacy-semver-private'];
const family = scheme => legacySchemes.includes(scheme) ? 'legacy' : scheme;
const calendars = ['inspr-calver-3', 'inspr-calendar-v2'];
const calendarPattern = /^([1-9][0-9])(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9])\.0\.0$/u;
const v1Pattern = /^([0-9]{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])(?:\.([01][0-9]|2[0-3])\.([0-5][0-9])\.([0-5][0-9]))?$/u;
const legacyPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const sign = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function parseVersion(record) {
  if (!record || typeof record.version !== 'string' || ![...legacySchemes, 'inspr-calendar-v1', ...calendars].includes(record.version_scheme)) throw new TypeError('Explicit known version_scheme required');
  const { version, version_scheme } = record;
  if (version.includes('\n') || version.includes('\r')) throw new TypeError('Invalid version coordinate');
  const pattern = calendars.includes(version_scheme) ? calendarPattern : version_scheme === 'inspr-calendar-v1' ? v1Pattern : legacyPattern;
  const match = pattern.exec(version);
  if (!match) throw new TypeError('Invalid version coordinate');
  const fields = match.slice(1).map(value => Number(value ?? 0));
  if (!legacySchemes.includes(version_scheme)) {
    const [yy, month, day] = fields;
    const date = new Date(Date.UTC(2000 + yy, month - 1, day));
    if (date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new TypeError('Invalid calendar date');
  }
  return { ...record, fields };
}
export function compareVersions(left, right, anchor) {
  const a = parseVersion(left), b = parseVersion(right);
  if (calendars.includes(a.version_scheme) && calendars.includes(b.version_scheme)) return sign(BigInt(a.version.split('.')[0]), BigInt(b.version.split('.')[0]));
  if (family(a.version_scheme) === family(b.version_scheme)) {
    for (let i = 0; i < a.fields.length; i++) { const order = sign(a.fields[i], b.fields[i]); if (order) return order; }
    return 0;
  }
  if (!anchor || anchor.last_legacy_scheme === undefined || anchor.first_calendar_version === null ||
    anchor.first_calendar_sequence !== anchor.last_legacy_sequence + 1 || a.release_channel !== b.release_channel || !a.release_channel) throw new TypeError('Mixed-era ordering requires a migration anchor and channel');
  parseVersion({ version: anchor.last_legacy_version, version_scheme: anchor.last_legacy_scheme });
  parseVersion({ version: anchor.first_calendar_version, version_scheme: 'inspr-calver-3' });
  for (const item of [a, b]) {
    if (!Number.isSafeInteger(item.release_sequence) || item.release_sequence < 1) throw new TypeError('Migration anchor requires a release sequence');
    if (calendars.includes(item.version_scheme)) {
      if (item.release_sequence < anchor.first_calendar_sequence || compareVersions(item, { version: anchor.first_calendar_version, version_scheme: 'inspr-calver-3' }) < 0) throw new TypeError('Calendar version predates anchor');
    } else if (family(item.version_scheme) !== family(anchor.last_legacy_scheme) || item.release_sequence > anchor.last_legacy_sequence ||
      compareVersions(item, { version: anchor.last_legacy_version, version_scheme: anchor.last_legacy_scheme }) > 0) throw new TypeError('Legacy version exceeds anchor');
  }
  return sign(a.release_sequence, b.release_sequence);
}
// Pure reservation planning. The caller persists the returned source once, after owner authorization for a candidate or publication.
export function reserveVersion(source, { now, publishGo = false, candidateGo = false, previous } = {}) {
  if (!publishGo && !candidateGo) throw new Error('Candidate authorization or separate publish go required before reservation');
  if (source.status !== 'unreserved') throw new Error('Coordinate already reserved; changed outputs need a new source reservation');
  parseVersion(source);
  if (source.migration.target_scheme !== 'inspr-calver-3' || !Number.isSafeInteger(source.migration.first_calendar_sequence) ||
    source.migration.first_calendar_sequence !== source.migration.last_legacy_sequence + 1 ||
    source.migration.first_calendar_version !== null && !previous) throw new TypeError('Reservation requires a complete migration anchor and prior ledger');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2010 || date.getUTCFullYear() > 2099) throw new TypeError('Invalid UTC reservation date');
  const digits = date.toISOString().slice(2, 19).replace(/[-:T]/gu, '');
  const version = `${digits}.0.0`;
  const result = { ...structuredClone(source), status: 'reserved', version_scheme: 'inspr-calver-3', version,
    release_sequence: previous ? previous.release_sequence + 1 : source.migration.first_calendar_sequence };
  parseVersion(result);
  if (previous) {
    parseVersion(previous);
    if (!calendars.includes(previous.version_scheme) || previous.release_channel !== source.release_channel || !Number.isSafeInteger(previous.release_sequence) ||
      compareVersions(result, previous) <= 0) throw new Error('Reservation must be later; wait for the next second');
  }
  result.migration.first_calendar_version ??= version;
  return result;
}
export function assertReleaseTag(ref, source) {
  if (source.status !== 'reserved' || source.version_scheme !== 'inspr-calver-3') throw new Error('Release requires a reserved CalVer3 source');
  parseVersion(source);
  if (ref !== `refs/tags/v${source.version}`) throw new Error('Release tag does not match admitted version');
}
export const qualificationInputs = ['inventory', 'consumer-gates', 'presentation-pin', 'immutable-candidate', 'signatures', 'update-path', 'deployment-pin', 'exact-rollback', 'public-representation'];
export function migrationGate(source, evidence = {}) {
  parseVersion(source);
  const pending = qualificationInputs.filter(key => evidence[key]?.status !== 'verified' || typeof evidence[key]?.reference !== 'string' || !evidence[key].reference.trim());
  if (source.status !== 'reserved') pending.unshift('reservation');
  if (source.version_scheme !== 'inspr-calver-3' || !source.migration.first_calendar_version ||
    !Number.isSafeInteger(source.release_sequence) || source.release_sequence < source.migration.first_calendar_sequence) pending.unshift('migration-anchor');
  if (!/^sha256:[a-f0-9]{64}$/u.test(evidence['immutable-candidate']?.artifact_sha256 ?? '') ||
    !/^[a-f0-9]{40}$/u.test(evidence['immutable-candidate']?.source_commit ?? '') ||
    evidence['immutable-candidate']?.version !== source.version) pending.push('candidate-binding');
  return { authoritative: pending.length === 0, pending,
    qualifications: { 'AIT-139': 'not measured (Markus decision)', 'AIT-160': 'not measured (Markus decision)' } };
}
