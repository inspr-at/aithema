# Next release — unreleased

These changes are for the release after 261015164601.0.0, not the first reset release.

- AIT-202: remove `markLocalVoice` from `@inspr/aithema-server/local-voice-identity`.
  AIT-218 made that compatibility function reject every call; hosts must remove
  imports of it. The subpath retains `isLocalVoice` for recognition. Only the
  simulator factory creates private frozen identity pairings; no public API
  enrolls providers.
- Composed voice and its generic core component helpers remain source-only proof
  code, without public package subpaths or module-tarball admission.
