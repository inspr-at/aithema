#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { adminRequest } from './admin-socket.js';
import { validateMailCap } from './mail-cap-policy.js';

const usage = 'Usage: node demo/admin-cli.js [--socket PATH] settings | audit [--after ID] [--limit N] | provider-cap | mail-cap | reconcile-uncertain [--dry-run|--apply] [--limit N] | '
  + 'set-allowances --base-revision N --anonymous USD --email-given USD --email-confirmed USD | set-confirmation --base-revision N --enabled true|false | '
  + 'set-mail-cap --base-revision N --hour N --day N | set-mail-ip-cap --base-revision N --hour N --day N';
try {
  const args = process.argv.slice(2);
  let socket = process.env.AITHEMA_ADMIN_SOCKET ?? join(dirname(resolve(process.env.AITHEMA_DB ?? '.data/session.sqlite')), 'ops', 'admin');
  if (args[0] === '--socket') { args.shift(); socket = args.shift(); }
  const command = args.shift();
  if (!['settings', 'set-allowances', 'set-confirmation', 'set-mail-cap', 'set-mail-ip-cap', 'audit', 'provider-cap', 'mail-cap', 'reconcile-uncertain'].includes(command)) throw new Error(usage);
  const options = {};
  while (args.length) {
    const key = args.shift(), value = ['--apply', '--dry-run'].includes(key) ? true : args.shift();
    if (!key?.startsWith('--') || value === undefined || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = value;
  }
  let payload;
  const keys = Object.keys(options);
  if (command === 'reconcile-uncertain') {
    if (keys.some(key => !['--apply', '--dry-run', '--limit'].includes(key)) || options['--apply'] && options['--dry-run'] ||
      options['--limit'] !== undefined && (!/^[1-9]\d*$/u.test(options['--limit']) || Number(options['--limit']) > 100)) throw new Error(usage);
    payload = { apply: options['--apply'] === true, ...(options['--limit'] === undefined ? {} : { limit: Number(options['--limit']) }) };
  } else if (command === 'set-allowances') {
    const required = ['--base-revision', '--anonymous', '--email-given', '--email-confirmed'];
    if (keys.length !== required.length || required.some(key => !Object.hasOwn(options, key)) || !/^[1-9]\d*$/u.test(options['--base-revision'])) throw new Error(usage);
    payload = { baseRevision: Number(options['--base-revision']), allowancesUsd: {
      anonymous: options['--anonymous'], emailGiven: options['--email-given'], emailConfirmed: options['--email-confirmed'] } };
  } else if (['set-mail-cap', 'set-mail-ip-cap'].includes(command)) {
    const required = ['--base-revision', '--hour', '--day'];
    if (keys.length !== required.length || required.some(key => !Object.hasOwn(options, key)) ||
      !/^[1-9]\d*$/u.test(options['--base-revision']) || !Number.isSafeInteger(Number(options['--base-revision'])) ||
      ['--hour', '--day'].some(key => !/^(0|[1-9]\d*)$/u.test(options[key]) || !Number.isSafeInteger(Number(options[key])))) throw new Error(usage);
    const cap = { hour: Number(options['--hour']), day: Number(options['--day']) };
    validateMailCap(cap);
    payload = { baseRevision: Number(options['--base-revision']), [command === 'set-mail-cap' ? 'mailCap' : 'mailIpCap']: cap };
  } else if (command === 'set-confirmation') {
    if (keys.length !== 2 || !/^[1-9]\d*$/u.test(options['--base-revision'] ?? '') || !['true', 'false'].includes(options['--enabled'])) throw new Error(usage);
    payload = { baseRevision: Number(options['--base-revision']), confirmationEnabled: options['--enabled'] === 'true' };
  } else if (command === 'audit') {
    if (keys.some(key => !['--after', '--limit'].includes(key))) throw new Error(usage);
    payload = Object.fromEntries(keys.map(key => [key.slice(2), options[key]]));
  } else if (keys.length) throw new Error(usage);
  const result = await adminRequest(socket, command, payload);
  console.log(JSON.stringify(result.body, null, 2));
  if (result.status !== 200) process.exitCode = 1;
} catch (error) {
  console.error(['ENOENT', 'ECONNREFUSED'].includes(error.code)
    ? 'The Aithema host is not running. Start the authoritative host before using the OPS CLI; there is no offline database fallback.' : error.message);
  process.exitCode = 1;
}
