# Next release — unreleased

## Host notes — image input (AIT-510)

- New public module `@inspr/aithema-plugin-image-input` (17 modules total), with
  pinned sharp 0.35.5 and platform-specific native/libvips dependencies. Install
  optional binaries in production. Docker and CI run the production-only fixture
  qualifier; see NOTICES.json for Apache-2.0/LGPL and transitive declarations.
- PNG/JPEG/WebP/GIF first frame only; no HEIC. Per-preset
  `imageInput: { plugin: 'image-input' }` selects the local normalizer. Each
  reasoning lane binding separately declares
  `imageInput: { maxImages, maxTokensPerImage, perImageMicro? }`; missing
  capability refuses image dispatch. Demo environment:
  `AITHEMA_OPENROUTER_IMAGE_INPUT` (model-keyed JSON). Fees enter reservations and
  OpenRouter's per-image provider price cap.
- New optional consent item `image-input`, feature `imageInput`, and demo contract
  string. Existing model item stays version 1. Granting/withdrawing image input
  preserves replies; withdrawing it erases pixels. Granting both `images` and
  `image-input` in a host's start consent avoids any later consent line or ask.
  Explicit host feature mappings and copy overrides keep precedence.
- Additive `aithema-consent` values `reason: 'use'`, `intent: 'attach'` and
  `features: ['imageInput', ...]`; file selection waits in memory for at most
  three minutes. Reason and intent are open enums.
- Upload states `staged-pending`, `staged-ready`, `staged-refused`, and
  `staged-discarded` are non-input. Thirty-minute orphan expiry/removal/session
  switch discard without cascade or model work. Sent images use withdrawal.
  Metadata adds kind/digest/w/h/expiresAt; turn events add attachments.
- `/turns` accepts up to four owned ready `attachments` IDs and blank text with
  attachments; atomic send and retry receipts include the IDs. Live-call image
  sends return `image-live-call`. Image-only purpose classification is neutral.
  `maxImagesPerSession`/`AITHEMA_UPLOAD_MAX_IMAGES` default to eight, independently
  of documents; byte ceilings remain shared.
- New owner-authenticated no-store `GET /uploads/:id/image`, fixed staging tiles
  and reserved transcript thumbnail boxes, revocable blob URLs, and normalized
  image files in ZIP export under images/. Bytes stay outside JSON/events/logs.
- Image requests retain references until dispatch, use at most four images from
  the last two user turns, and leave draft understanding text-only. One shared
  text-plus-image token helper serves all three admission/settlement/pricing sites.
  The text-only Reasoning contract remains unchanged. Additive image types,
  image-input core subpath/helpers, manifest kind and normalize operation are
  listed in README.md.
- New EN/DE copy: imageConsentJit, imageInputFeature, imagePreparing, imageRemove,
  imageLiveCall, imageUnsupportedModel, imageWithheld, uploadsSupported,
  uploadsReselect (plural), imageRefusals and their per-reason entries (including batch limits),
  features.imageInput, featureConsent.imageInput, processingConsent.items.image-input,
  plus native/capability refusal reasons and updated upload format/retention copy.
  Refusals persist through typing in the bounded reason slot, below blocking
  failures and attach-time consent. README documents every additive host surface.

- Lower-level additions: storage turnReceipt/imageUpload/expireStagedUploads,
  postTurn guard.attachments, completeUpload image results, upload-handler now
  and cancelImages, runtime imageInputAvailability/normalizeImageUpload,
  exportSession images, reasoningRequest imageOnly, and dispatch-only
  createChatCompletions prepareDispatch/resolveImage/imageDispatchCurrent.
  Unsupported image filenames stay in the non-input refusal path even for
  direct multipart callers; the format help line lists the exact accepted types.

- Extensionless files labelled with an image MIME type and excluded HEIC/AVIF
  containers stay in the staged, non-input refusal path; they never fall through
  to document extraction or schedule model work. HEIC remains unsupported.
