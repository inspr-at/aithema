// Synthetic refusal contracts shared by server and component fixtures.
export const clarifyRefusals = [
  ...['admission deadline', 'budget reconciling', 'budget denied', 'plugin unhealthy', 'consent port unavailable'].map(admissionReason => ({
    name: admissionReason, status: 403, body: { error: 'focus-refused', reason: 'not-admitted', admissionReason }, branch: 'generic',
  })),
  { name: 'invalid-request', status: 400, body: { error: 'focus-refused', reason: 'invalid-request' }, branch: 'generic' },
  { name: 'consent-required', status: 403, body: { error: 'focus-refused', reason: 'consent-required', admissionReason: 'current processing consent required' }, branch: 'refused' },
  { name: 'one-hour', status: 403, body: { error: 'focus-refused', reason: 'not-admitted', admissionReason: 'one-hour' }, branch: 'refused' },
];
