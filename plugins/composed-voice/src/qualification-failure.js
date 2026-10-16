import { PluginError } from '@inspr/aithema-core/invocation';

// Only these harness-owned, value-free reasons cross the control boundary or
// enter failure.json. Provider messages and arbitrary error properties do not.
export const QUALIFICATION_SAMPLE_FAILURES = Object.freeze({
  'missing-transcript': 'Missing qualification transcript',
  'missing-audio': 'Missing qualification audio',
  'stop-failed': 'Qualification stop failed',
  'pcm-bound': 'Bounded server PCM required',
  'report-rejected': 'Qualification report rejected',
  'sample-failed': 'OPS sample failed; retain reservations and inspect server evidence',
});

export class QualificationSampleFailure extends PluginError {
  constructor(reason) {
    if (!Object.hasOwn(QUALIFICATION_SAMPLE_FAILURES, reason)) throw new TypeError('Unknown qualification sample failure');
    super(reason === 'pcm-bound' ? 'limit' : reason.startsWith('missing-') ? 'invalid-output' : 'provider',
      QUALIFICATION_SAMPLE_FAILURES[reason]);
    this.reason = reason;
  }
}
