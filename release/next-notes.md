# Next release — unreleased

## Host notes

- AIT-505: additive `hasVisitorInput(session)` core export separates active visitor/document input from host or assistant text; `hasConversationInput` remains an alias. `conversationStarted` keeps its locale-locking meaning. UI `hostOpenerTurn(session)` and `openerTranscript(session, { visible = true })` project the entrance opener without changing the canonical transcript.
