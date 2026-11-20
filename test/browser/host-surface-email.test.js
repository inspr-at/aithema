// AIT-597: split from host-surface.test.js along whole top-level tests, as
// AIT-557 split clarify-now. Viewport evidence only, remote runner only.
import { test } from 'node:test';
import { combinedOfferCheck, openerEmailCheck, contactOfferCheck, inlineOfferCheck } from './contact-email-check.js';
test('AIT-506 combined offer: a saved address keeps the capture row stable', { timeout: 120_000 }, combinedOfferCheck);
test('AIT-507 integration: persisted opener alone exposes no email action or lock', { timeout: 180_000 }, openerEmailCheck);
test('AIT-517: pinned contact preserves the combined inline email offer', { timeout: 180_000 }, contactOfferCheck);
test('AIT-507 inline offer: locale/theme/width matrix, privacy, resend, call, and stable controls', { timeout: 240_000 }, inlineOfferCheck);
