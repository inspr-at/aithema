const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const zonePattern = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/;
const periodPattern = /^([0-9]{4})-(0[1-9]|1[0-2])$/;
const HOUR = 3_600_000;

function formatter(timeZone) {
  // Intl also accepts numeric UTC offsets on recent Node releases; v1
  // requires a named IANA zone (including UTC and recognized IANA aliases).
  if (typeof timeZone !== 'string' || timeZone.length > 128 || !zonePattern.test(timeZone)) {
    throw new TypeError('time_zone must be an IANA name');
  }
  return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

/** Validate semantic constraints not expressible by the foundation schema subset. */
export function checkDeploymentPeriod(value) {
  const fields = ['deployment_id', 'period', 'time_zone', 'ceiling_micro', 'notify_at'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))
      || typeof value.deployment_id !== 'string' || value.deployment_id.length > 128
      || value.deployment_id !== value.deployment_id.trim() || !idPattern.test(value.deployment_id)
      || value.period !== 'month' || !Number.isSafeInteger(value.ceiling_micro) || value.ceiling_micro < 0
      || !Array.isArray(value.notify_at) || value.notify_at.length > 4
      || !Array.from(value.notify_at).every((ratio, i) => Number.isFinite(ratio) && ratio > 0 && ratio <= 1
        && (i === 0 || ratio > value.notify_at[i - 1]))) {
    throw new TypeError('Invalid deployment_period policy; notify_at must be strictly increasing ratios in (0,1]');
  }
  formatter(value.time_zone);
  return structuredClone(value);
}

function parts(format, at) {
  const values = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]));
  return { year: values.era === 'BC' ? 1 - Number(values.year) : Number(values.year),
    month: Number(values.month), day: Number(values.day), hour: Number(values.hour),
    minute: Number(values.minute), second: Number(values.second) };
}

function utc({ year, month, day = 1, hour = 0, minute = 0, second = 0 }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function monthIndex({ year, month }) { return year * 12 + month - 1; }
function monthId(index) { return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`; }

/** Earlier midnight for overlaps; first valid instant after a midnight gap. */
function boundary(index, format) {
  const nominal = utc({ year: Math.floor(index / 12), month: index % 12 + 1 });
  const offsets = new Set();
  let before = nominal - 36 * HOUR;
  let after = null;
  for (let at = before; at <= nominal + 36 * HOUR; at += HOUR) {
    const local = parts(format, at);
    offsets.add(utc(local) - at);
    if (after === null) {
      if (monthIndex(local) >= index) after = at;
      else before = at;
    }
  }
  const midnights = [...offsets].map((offset) => nominal - offset).filter((at) => {
    const local = parts(format, at);
    return monthIndex(local) === index && local.day === 1 && local.hour === 0 && local.minute === 0 && local.second === 0;
  });
  if (midnights.length) return Math.min(...midnights);
  if (after === null) throw new RangeError('Cannot resolve deployment month boundary');
  while (after - before > 1) {
    const at = Math.floor((before + after) / 2);
    if (monthIndex(parts(format, at)) >= index) after = at;
    else before = at;
  }
  return after;
}

/** @returns {{period_id:string, start_at:string, end_at:string}} */
export function deploymentPeriodBounds(periodId, timeZone) {
  const match = typeof periodId === 'string' && periodPattern.exec(periodId);
  if (!match || match[0] !== periodId) throw new TypeError('period_id must be YYYY-MM');
  const index = Number(match[1]) * 12 + Number(match[2]) - 1;
  const format = formatter(timeZone);
  return { period_id: periodId, start_at: new Date(boundary(index, format)).toISOString(),
    end_at: new Date(boundary(index + 1, format)).toISOString() };
}

/** Calendar month in the host zone, as a contiguous half-open [start,end). */
export function deploymentPeriodAt(at, timeZone) {
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new TypeError('Admission clock must be epoch milliseconds');
  let index = monthIndex(parts(formatter(timeZone), at));
  let result = deploymentPeriodBounds(monthId(index), timeZone);
  // A midnight overlap can briefly display the preceding month again. The
  // earlier start still owns that instant; adjacent periods never overlap.
  if (at >= Date.parse(result.end_at)) result = deploymentPeriodBounds(monthId(++index), timeZone);
  else if (at < Date.parse(result.start_at)) result = deploymentPeriodBounds(monthId(--index), timeZone);
  return result;
}

/** Exact threshold in integer micro-units, avoiding floating-point multiplication. */
export function notificationThreshold(ceiling, ratio) {
  const [mantissa, exponent = '0'] = String(ratio).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = fraction.length - Number(exponent);
  const denominator = 10n ** BigInt(scale);
  return (BigInt(ceiling) * digits + denominator - 1n) / denominator;
}
