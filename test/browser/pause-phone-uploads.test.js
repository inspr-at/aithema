// AIT-597: split from pause-phone.test.js along whole top-level tests, as
// AIT-557 split clarify-now. Viewport evidence only, remote runner only.
// The document-upload chain and the 1440 image-input matrix run here;
// pause-phone keeps its pause tests and the 390 image-input matrix.
import { documentUploadCheck } from './document-upload-check.js';
documentUploadCheck();
import { imageInputCheck } from './image-input-check.js';
imageInputCheck([1440]);
import { intakeNoticeCheck } from './ait610-intake-notice-check.js';
intakeNoticeCheck();
