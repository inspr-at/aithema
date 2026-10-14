import { isIP } from 'node:net';

function bucket(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return null;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  // Expand validated IPv6 literals before masking, so compressed, uppercase
  // and embedded-IPv4 spellings cannot create separate buckets.
  const normalized = ip.replace(/\d+\.\d+\.\d+\.\d+$/u, address => {
    const bytes = address.split('.').map(Number);
    return `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  });
  const [left, right] = normalized.split('::').map(part => part ? part.split(':') : []);
  const words = right === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const values = words.map(word => parseInt(word, 16));
  // Node's dual-stack socket peers can be IPv4-mapped IPv6. Treat them as the
  // same IPv4 client, including the entirely hexadecimal spelling.
  if (values.slice(0, 5).every(value => value === 0) && values[5] === 0xffff) {
    return [values[6] >> 8, values[6] & 255, values[7] >> 8, values[7] & 255].join('.');
  }
  return `${values.slice(0, 4).map(value => value.toString(16).padStart(4, '0')).join(':')}::/64`;
}

/** Host opt-in only. The peer comes from the adapter, never from HTTP headers. */
export function createClientIpResolver({ header } = {}) {
  if (header !== undefined && header !== '' && header !== 'x-forwarded-for') throw new TypeError('Invalid client IP header');
  return (request, { remoteAddress } = {}) => {
    const forwarded = header === 'x-forwarded-for' ? request.headers.get(header)?.split(',').at(-1).trim() : undefined;
    // Request-only adapters without socket metadata conservatively share a
    // bucket. The Node adapter always supplies the actual socket peer.
    return bucket(forwarded) ?? bucket(remoteAddress) ?? 'unknown-peer';
  };
}
