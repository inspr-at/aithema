# Next release — unreleased

## Host notes

- AIT-509: visual consent text is now silent at idle for all hosts. The bound
  rail keeps its sizers; Settings keeps per-feature status and withdrawal.
- Validated visual requests blocked only by consent offer a just-in-time ask in
  the reserved rail slot. Its memory-only continuation expires within three
  minutes and needs a newer authoritative covering grant; cancellation, review,
  decline, navigation, superseding input and source/session/settings changes do
  not dispatch. Start's intent implementation and voice gesture rules stay as-is.
- `aithema-consent` adds `reason: 'use', intent: 'concept'`. Both fields are open
  enums; unknown values mean review. A host may grant the items mapped by
  the consent document's `features.images` in its own combined Start consent to avoid a later ask.
  No image-input consent item is added by this change.
- New component methods `openConsent(feature, opener?)` and `cancelConsent()` let
  hosts use the existing in-page editor or dismiss a pending concept. The demo
  uses the in-page editor; the navigating Start test host remains.
- Copy adds `conceptConsent` and `conceptConsentAction` in EN/DE. Host overrides
  win, including legacy `featureConsent.images` / `featureConsent.action` overrides.
- `ConceptLane` adds optional `consentRequired(session, visualKind)` preflight.
  `concept.state.status.consentRequest: {id, sourceTurnId}` is additive metadata
  on `phase: 'waiting'`; it carries no durable grant or automatic retry.
