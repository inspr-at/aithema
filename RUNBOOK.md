# Runbook

## Admin: erase a session or visitor

Use the service account and the existing 0600 admin socket of the authoritative
running server. The CLI has no offline database fallback and needs no visitor
cookie. Do not open the live database for SQL erasure.

```sh
docker exec --user node start2 node /app/demo/admin-cli.js erase-session SESSION_ID
# Only when the entire visitor, including every conversation and saved identity, must be erased:
docker exec --user node start2 node /app/demo/admin-cli.js erase-session SESSION_ID --visitor
docker exec --user node start2 node /app/demo/admin-cli.js audit --after 0 --limit 100
```

Replace `start2` with the running container name. For a local server, use
`node demo/admin-cli.js --socket /absolute/path/to/ops/admin erase-session SESSION_ID`.
The socket override precedes the command. Never send an operator erase to the
public listener; it has no such endpoint.

A single erase retains the visitor identity and other conversations. `--visitor`
resolves the stored owner from the seed session, erases all that visitor's live
conversations, and drains the same identity projection and mail cleanup used by
HTTP visitor erase. An erased seed still identifies its visitor while its
tombstone exists. A retained/purged ID that no longer exists returns `not-found`
(exit 1); choose an existing session for that visitor instead.

The receipt has `result: erased` or `already-erased`, `erasedSessions` and the
scope flag `visitor`. Repeated calls do not create another erase event. Content,
uploads and dependent artifacts are erased through the application path; in-flight
work is invalidated and SSE streams receive `session.erased` then disconnect.
Accounting rows, owner attribution, confirmed/uncertain financial totals and
provider spend remain available. `providerDeletion: not-confirmed` describes
upstream deletion; local erasure does not claim provider deletion.

The existing HTTP erase cancels running work and stops voice; it does **not**
refuse active calls or pending dispatch. The operator command deliberately
preflights the whole scope and returns 409 `voice-call-active` for connecting,
active or closing calls, or `pending-dispatch` for queued/running reasoning,
nonterminal ledger attempts, wallet admission holds, pending uploads/concepts or
handover delivery. No session is erased on these preflight refusals. End the call
or let dispatch settle, then retry. Other sessions can keep writing events.

Unknown IDs, refusals, invalid socket requests, failures and idempotent retries
are recorded in the existing admin audit with the socket-owner operator, UTC
time, session ID, `visitor` flag and result. No content, email, cookie or
caller-supplied actor is recorded. Invalid IDs/flags are recorded as null.
Audit retention follows the existing 180-day policy. An `erasure-failed` response
means erasure may already have started; inspect the audit and retry the same
scope. Financial reconciliation remains a separate command.
