import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { serveExtractor } from '../../packages/core/src/extractor-process.js';
serveExtractor(async () => {
  const probes = [() => fetch('https://never-contact.example.invalid/'),
    () => new WebSocket('wss://never-contact.example.invalid/'),
    () => net.connect(80, 'never-contact.example.invalid'), () => tls.connect(443, 'never-contact.example.invalid'),
    () => http.get('http://never-contact.example.invalid/'), () => https.get('https://never-contact.example.invalid/'),
    () => http2.connect('https://never-contact.example.invalid/'),
    () => dns.lookup('never-contact.example.invalid', () => {}),
    () => dns.promises.resolve('never-contact.example.invalid'),
    () => new dns.Resolver().resolve('never-contact.example.invalid', () => {}), () => dgram.createSocket('udp4'),
    // Invalid arguments are safe even if the guard regresses: neither probe can send or bind.
    () => { const socket = new dgram.Socket('udp4'); try { socket.send(null, -1, -1, -1); } finally { socket.close(); } },
    () => { const socket = new dgram.Socket('udp4'); try { socket.bind({ port: -1 }); } finally { socket.close(); } }];
  let denied = 0;
  for (const probe of probes) {
    try { await probe(); } catch (error) { if (error.message === 'Extractor network access denied') denied++; }
  }
  return { segments: [{ text: `Denied ${denied}/${probes.length} transports` }] };
});
