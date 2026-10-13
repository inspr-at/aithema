export const MAIL_CAP_HOUR_CEILING = 1_000;
export const MAIL_CAP_DAY_CEILING = 10_000;

/** Shared by the authoritative settings writer and the OPS CLI. Zero pauses mail. */
export function validateMailCap({ hour, day }) {
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > MAIL_CAP_HOUR_CEILING) {
    throw new TypeError(`Mail cap hour must be an integer from 0 to ${MAIL_CAP_HOUR_CEILING}`);
  }
  if (!Number.isSafeInteger(day) || day < 0 || day > MAIL_CAP_DAY_CEILING) {
    throw new TypeError(`Mail cap day must be an integer from 0 to ${MAIL_CAP_DAY_CEILING}`);
  }
  if (hour > day) throw new TypeError('Mail cap hour must be less than or equal to day');
}
