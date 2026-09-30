// Explicit process death, never sleeps or races against a wall clock.
import { writeFileSync } from 'node:fs';
import { confirmBatch } from '../../../workspace/text-session.js';
import { AuditWriter } from '../../../runtime/audit/writer.js';
import { bootstrap, fixture, output, referenceSubmission, textSession, binding, bytes, record } from './support.mjs';

const [path, mode, boundary] = process.argv.slice(2);
let armed = false, specStarted = false, f;
const acknowledged = [];
const stop = (point) => {
  if (armed && point === boundary && (mode !== 'spec' || specStarted || point === 'turn.after_ack')) process.exit(42);
};
f = fixture(null, { path, handler: (lane, payload) => {
  if (armed && lane === 'spec') specStarted = true;
  stop('budget.during_request');
  return output(lane, payload);
}, checkpoint: (point) => {
  if (armed && boundary === 'reaction.mid' && point === 'reaction.before_append') {
    const turn = f.records('turn').at(-1).document;
    // Playback ack retained by a surviving browser on reconnect. Text-only
    // engine gate proves storage/context semantics, not actual audio timing.
    const partial = record('reaction', { turn_seq: turn.seq, text: 'Recorded.', delivered_prefix: 'Rec', certainty: 'delivered', complete: false },
      { writer: { kind: 'browser' } });
    const stored = f.journal.append(bytes(partial), { ...f.auth, writer_kind: 'browser' });
    acknowledged.push({ seq: stored.document.seq, bytes: stored.bytes.toString('base64') });
    writeFileSync(`${path}.acks.json`, JSON.stringify(acknowledged));
    process.exit(42);
  }
  stop(point);
}, journalOverrides: { append: (original, auth) => {
  if (armed && mode === 'audit' && JSON.parse(original).kind === 'audit.event' && JSON.parse(original).data.name === 'synthetic.lost') throw new Error('Volatile audit tail lost');
  const stored = f.journal.append(original, auth);
  acknowledged.push({ seq: stored.document.seq, bytes: stored.bytes.toString('base64') });
  writeFileSync(`${path}.acks.json`, JSON.stringify(acknowledged));
  if (JSON.parse(original).kind === 'turn') stop('turn.after_ack');
  return stored;
} }, ledgerOverrides: {
  admit: (original, auth) => { const result = f.ledger.admit(original, auth); stop('budget.admit_before_journal'); return result; },
  claim: (original, auth) => { const result = f.ledger.claim(original, auth); stop('budget.claim_before_response'); return result; },
  settle: (original, auth) => { const result = f.ledger.settle(original, auth); stop('budget.settle_response_lost'); return result; },
} });
await bootstrap(f);
const host = referenceSubmission(f, stop);
armed = true;
if (mode === 'audit') {
  const audit = new AuditWriter({ port: f.port, authority: f.auth, now: f.clock.wallNow, clock: f.clock });
  await audit.bestEffort({ name: 'synthetic.acknowledged' });
  await audit.bestEffort({ name: 'synthetic.lost' });
  stop('audit.tail');
} else if (mode === 'op') {
  const port = textSession(f, () => host.submitConfirmed());
  await confirmBatch(port, binding(f.engine.state.spec.items[0]), { einreichen: true });
} else {
  const port = textSession(f);
  await port.submitTurn({ text: 'Follow-up export detail.' });
  await port.idle();
}
throw new Error(`Crash boundary not reached: ${mode}/${boundary}`);
