# Next release — unreleased

## Host notes

- AIT-517 adds optional `sidebar-contact` and `contact-launcher` slots. Fill them
  before mount/configure. The pinned row is outside scrolling analysis and the
  E‑Mail ask pane; empty consumes zero height. It scrolls independently with a
  30% desktop cap / 14rem stacked cap. Late insertion or growth is outside the
  reserved-geometry contract. The header launcher remains reachable before input,
  during the sidebar reveal, when folded, below 60rem, or without pinned content;
  while desktop pinned content is available it leaves Tab order but retains its 44 px reservation.
- **First-paint contract:** launcher hosts reserve 44 px more in
  `--aithema-header-actions-width` in render-blocking CSS on the placeholder and
  component (defaults 216 → 260 px desktop, 88 → 132 px below 600 px), with the
  matching `headerRailReservation({ actionsWidth: '260px' })` desktop threshold.
  Alternatively serve `firstPaintStyles` with
  `firstPaintMarkupFor({ contactLauncher: true })`, keeping its sibling placeholder
  through mount. `voice: false` still works; existing defaults and exports remain.
  Host CSS width overrides keep winning. The helper manages
  `--aithema-contact-launcher-width` (0 px by default, 44 px when declared);
  custom totals still use `--aithema-header-actions-width`.
- Contact content, click listeners, styling, accessible names, modal focus trap,
  Escape and focus return belong to the host. Besides the first-paint flag,
  there are no new configure options, event fields, contact events or exports.
  The library adds no contact form, handover request, AI processing or consent
  dependency. The mock demo's neutral
  local dialog sends nothing. New EN/DE demo keys:
  `copy.host.slots.contact`, `copy.host.slots.contactNote`; its close button reuses
  `copy.host.outbox.close`. Host slot content and copy overrides retain ownership.
