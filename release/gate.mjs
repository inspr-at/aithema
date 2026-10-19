import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseTag, compareVersions, migrationGate, parseVersion } from './lib/version.mjs';
import { normalizedDigest } from './normalize.mjs';

const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const isCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

function markerMessage(object) {
  const split = object.indexOf('\n\n');
  if (split < 0) throw new Error('Invalid candidate marker object');
  // Signed annotated tags are also valid. Signatures are outside the JSON message.
  const message = object.slice(split + 2).split(/\n-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE)-----/u)[0].trim();
  return JSON.parse(message);
}

// Helpers can validate the exact output of `git cat-file -p refs/tags/...`
// before pushing a marker. This checks both its JSON and direct commit binding.
export function parseCandidateMarker(tag, object) {
  try {
    const header = object.slice(0, object.indexOf('\n\n')).split('\n');
    const value = markerMessage(object);
    parseVersion({ ...value, version_scheme: 'inspr-calver-3' });
    if (tag !== `candidate/v${value.version}` || !Number.isSafeInteger(value.release_sequence) || value.release_sequence < 1 ||
      !isCommit(value.source_commit) || !isDigest(value.manifest_sha256) || !isDigest(value.normalized_digest) ||
      !header.includes('type commit') || header[0] !== `object ${value.source_commit}`) throw new Error('Invalid fields or commit');
    return value;
  } catch (cause) {
    throw new Error(`Invalid candidate marker fields or commit: ${tag}`, { cause });
  }
}

export function candidateGate(ref, { root = process.cwd(), directory = join(root, 'dist/release') } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const source = JSON.parse(readFileSync(join(root, 'release/version.json')));
  assertReleaseTag(ref, source);
  git(['fetch', '--no-tags', 'origin',
    'refs/tags/candidate/*:refs/tags/candidate/*',
    'refs/tags/release-failed/*:refs/tags/release-failed/*',
    'refs/tags/v*:refs/tags/v*']);
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('Tagged commit differs from checked-out candidate');
  const tags = git(['tag', '--list']).split('\n');
  if (tags.includes(`release-failed/v${source.version}`)) throw new Error('Coordinate is failed-terminal; re-runs are refused');
  const name = `candidate/v${source.version}`;
  if (!tags.includes(name)) throw new Error('Candidate marker missing');
  function marker(tag) {
    const fullRef = `refs/tags/${tag}`;
    if (git(['cat-file', '-t', fullRef]) !== 'tag') throw new Error(`Candidate marker must be annotated: ${tag}`);
    return parseCandidateMarker(tag, git(['cat-file', '-p', fullRef]));
  }
  const selected = marker(name);
  if (selected.source_commit !== commit || selected.release_sequence !== source.release_sequence) throw new Error('Candidate marker commit or sequence mismatch');
  for (const tag of tags.filter(tag => tag.startsWith('candidate/v'))) {
    let other;
    try {
      other = tag === name ? selected : marker(tag);
    } catch (error) {
      // A broken immutable marker must still close its claimed sequence. An
      // unrelated (or unreadable) sequence cannot poison all future releases.
      let sequence;
      try { sequence = markerMessage(git(['cat-file', '-p', `refs/tags/${tag}`])).release_sequence; } catch { /* no readable claim */ }
      if (sequence === selected.release_sequence || typeof sequence === 'string' && Number(sequence) === selected.release_sequence) throw error;
      console.warn(`Warning: ignoring malformed ${tag} (sequence ${sequence ?? 'unknown'}, candidate sequence ${selected.release_sequence}): ${error.message}`);
      continue;
    }
    if (other.release_sequence === selected.release_sequence && compareVersions(
      { ...other, version_scheme: 'inspr-calver-3' }, { ...selected, version_scheme: 'inspr-calver-3' }) > 0) {
      throw new Error(`Candidate marker superseded by active ${tag}`);
    }
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY required for published release admission');
  // gh uses this workflow's GH_TOKEN. Only GET requests; every page is read.
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Invalid published release response');
  const history = JSON.parse(readFileSync(join(root, 'release/history.json'))).releases;
  const publishedTags = new Set();
  for (const release of pages.flat()) {
    if (release.draft === true) continue;
    if (release.draft !== false || !/^v[0-9.]+$/u.test(release.tag_name ?? '')) throw new Error('Unknown published release coordinate');
    const tag = release.tag_name;
    const publishedCommit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    // Pre-CalVer tags have no version.json. Their explicit, commit-bound ledger
    // is the migration anchor; later releases use the reserved source at the tag.
    const historical = history.find(entry => entry.tag === tag);
    const published = historical ?? JSON.parse(git(['show', `refs/tags/${tag}:release/version.json`]));
    parseVersion(published);
    if (`v${published.version}` !== tag || historical && historical.source_commit !== publishedCommit ||
      published.release_channel !== source.release_channel || !Number.isSafeInteger(published.release_sequence) || published.release_sequence < 1) {
      throw new Error('Published release sequence or source binding invalid');
    }
    if (published.release_sequence >= selected.release_sequence) throw new Error(`Published release sequence ${published.release_sequence} >= ${selected.release_sequence}`);
    publishedTags.add(tag);
  }
  // A pushed v-tag remains in flight until publication or an explicit terminal
  // failure. Read its sequence at that commit, including remote-only tags just
  // fetched above; neither a missing candidate marker nor a draft closes it.
  for (const tag of tags.filter(tag => tag.startsWith('v') && `refs/tags/${tag}` !== ref)) {
    if (publishedTags.has(tag) || tags.includes(`release-failed/${tag}`)) continue;
    let sequence;
    try {
      sequence = JSON.parse(git(['show', `refs/tags/${tag}^{commit}:release/version.json`])).release_sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid release sequence');
    } catch (cause) {
      throw new Error(`Unreadable release sequence for in-flight ${tag}`, { cause });
    }
    if (sequence === selected.release_sequence) throw new Error(`Another in-flight tag ${tag} claims release sequence ${sequence}`);
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'release-set.json')));
  if (manifest.mode !== 'release' || manifest.source.commit !== commit || manifest.version !== source.version ||
    manifest.release_sequence !== source.release_sequence || manifest.release_channel !== source.release_channel) throw new Error('Built release differs from tagged candidate');
  if (normalizedDigest(directory) !== selected.normalized_digest) throw new Error('Candidate normalized digest mismatch');
  return selected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(readFileSync(new URL('./version.json', import.meta.url)));
  const [command, input, directory] = process.argv.slice(2);
  if (command === 'tag') assertReleaseTag(input, source);
  else if (command === 'candidate') console.log(JSON.stringify(candidateGate(input, { ...(directory ? { directory: resolve(directory) } : {}) })));
  else if (command === 'qualification') {
    const evidence = input ? JSON.parse(readFileSync(input)) : {};
    const gate = migrationGate(source, evidence); console.log(JSON.stringify(gate));
    if (!gate.authoritative) process.exitCode = 1;
  } else throw new Error('Usage: node release/gate.mjs tag refs/tags/vVERSION | candidate refs/tags/vVERSION [dist/release] | qualification [evidence.json]');
}
