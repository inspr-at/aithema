// Preloaded only in parser children. Deny transport entrypoints before parser imports.
// The Node permission model additionally denies writes, subprocesses and workers.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => {
  process.send?.({ type: 'network-denied' });
  throw new Error('Extractor network access denied');
};
for (const [module, keys] of [[net, ['connect', 'createConnection', 'createServer']],
  [tls, ['connect', 'createServer']], [http, ['request', 'get', 'createServer']],
  [https, ['request', 'get', 'createServer']], [http2, ['connect', 'createServer', 'createSecureServer']],
  [dgram, ['createSocket']]]) for (const key of keys) module[key] = denied;
net.Socket.prototype.connect = denied;
for (const module of [dns, dns.promises]) {
  for (const key of Object.keys(module)) if (/^(?:lookup|resolve|reverse)/u.test(key)) module[key] = denied;
  for (const key of Object.getOwnPropertyNames(module.Resolver.prototype)) {
    if (/^(?:resolve|reverse)/u.test(key)) module.Resolver.prototype[key] = denied;
  }
}
globalThis.fetch = denied;
globalThis.WebSocket = class { constructor() { denied(); } };
syncBuiltinESMExports();
