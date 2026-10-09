import { get } from 'node:http';

try {
  const origin = process.env.AITHEMA_PUBLIC_ORIGIN;
  const probe = get(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`, {
    headers: origin ? { host: new URL(origin).host } : {},
    signal: AbortSignal.timeout(4000),
  }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('error', () => process.exit(1));
    response.on('end', () => {
      try { process.exit(response.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1); }
      catch { process.exit(1); }
    });
  });
  probe.on('error', () => process.exit(1));
} catch { process.exit(1); }
