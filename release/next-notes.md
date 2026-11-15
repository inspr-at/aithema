# Next release — unreleased

## Host notes

- AIT-515: `understanding.signals` remains `string[]` and is now newest-first by
  first-seen server sequence, with stable provider-order ties. Current finals
  hide omitted texts; rewordings are new keys, without replacement IDs or an
  updated mark. Current lists retain the 24-item cap. First-N consumers and the
  import payload now receive newest signals first.
- Additive final-event/snapshot/export `understanding.signalItems` contains
  `{key,text,firstSeen,basis?}`. Model signals accept strict `{text,basis}` objects
  (`visitor | assistant | document`) and compatible untagged plain strings.
  Only assistant attribution shows an unconfirmed tag; it never confirms slots.
  `signalKey(text)` is an additive core root/understanding export for exact NFKC,
  lowercase, whitespace-collapsed identity.
- The server-owned snapshot `signalLedger` lives outside `understanding`, includes
  conservative `turnIds` / `uploadIds` dependencies and retains omitted identities.
  It survives upload, correction, locale and grant-only resets; source erasure,
  withdrawal and relevant consent withdrawal prune it. It uses erasable content
  references in storage; raw ledger text is excluded from journal metadata.
  Legacy snapshots seed identities from their current final. The historical
  ledger is not exported; current signalItems and ordered strings are.
- The signal overview starts at five, with a native total-count toggle and
  conversation-local expansion. Pointer/focus defer asynchronous list changes;
  source removal redacts immediately. One to three new keys get a two-second
  highlight (static with reduced motion); first/whole lists and reconnects stay
  quiet. New host-overridable EN/DE keys: `signalsAll` = `Show all ({n})` /
  `Alle anzeigen ({n})`, shared `showLess` = `Show less` / `Weniger anzeigen`,
  `signalUnconfirmed` = `unconfirmed` / `unbestätigt`. Missing keys fall back to
  the active locale. Summary/signal prompts use direct “you” / formal “Sie”,
  avoid provenance prose and preserve quoted evidence.
