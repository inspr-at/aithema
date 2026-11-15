# Next release — unreleased

## Host notes

- AIT-511/AIT-513: the transcript uses the remaining height and voice recovery
  notices appear as interactive transcript end content at every width. A voice
  binding reserves no empty notice row. Image visuals retain their 44 px bar;
  unbound visuals reserve none. Short transcripts align at the top without a
  visible question card, and beside their question when a card is present.
- The composer grows upward with its draft, capped by 40% of the visual viewport
  and the reply/card budget; short phone viewports allow at most three lines.
  Short desktop viewports reduce outer spacing in both composer states; longer
  used-up copy scrolls in its keyboard-focusable body. Attach, Send and the bottom
  edge stay fixed. Failed sends and answer-chip
  sends retain a separate draft and its size; accepted typed/device sends reset
  the matching draft. Follow mode re-pins; a resting transcript pointer wins
  and Latest exposes the occluded tail.
- Additive measured CSS outputs on the workspace:
  `--aithema-composer-height` and `--aithema-composer-growth`. Hosts keep their
  existing height/theme/copy overrides. No new options, copy keys, events or
  package exports. Phone dock subtraction, card margin, notice end reservation
  and pointer slack remain distinct padding/clearance owners. A trailing phone
  conversation margin reserves only visitor growth to keep the stacked overview
  frame fixed.
