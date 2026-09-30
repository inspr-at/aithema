import { readFileSync } from 'node:fs';
import { SqliteJournal } from '../../../runtime/journal/sqlite.js';
import { authority, now } from './helpers.mjs';

// The parent pre-creates the host. Exit without close() to leave WAL recovery to
// a fresh process. All data is synthetic; this fixture never opens a socket.
const [path, submission, mode] = process.argv.slice(2);
const journal = new SqliteJournal(path, { now });
if (mode === 'commit') journal.append(readFileSync(submission), authority());
process.exit(23);
