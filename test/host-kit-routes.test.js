import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadContractFile } from '../contracts/validate.js';
import { signToken } from './host-kit/index.js';
import { sessionClaims, validDocuments } from './host-kit/fixtures.js';
import { routeScenario, routes } from './host-kit/scenarios.js';

describe('host kit exact outer capability matrix (AIT-44a/c)', () => {
  const matrix = loadContractFile('capabilities.json');
  const expectedCapabilities = new Map([
    ['POST intake/sources', 'intake.write'],
    ['POST intake/transcript-turns', 'intake.write'],
    ['POST intake/drafts', 'intake.write'],
    ['POST intake/replace', 'intake.write'],
    ['GET intake/', 'intake.read'],
    ['POST intake/accept', 'intake.decide'],
    ['POST journal/records', 'aithema.journal.write'],
    ['POST journal/snapshots', 'aithema.journal.write'],
    ['POST journal/op.result', 'aithema.journal.write'],
    ['GET journal/records', 'aithema.journal.read'],
    ['GET journal/cursor', 'aithema.journal.read'],
    ['GET journal/authority', 'aithema.authority.read'],
    ['POST ledger/admit', 'aithema.ledger'],
    ['POST ledger/claim', 'aithema.ledger'],
    ['POST ledger/settle', 'aithema.ledger'],
    ['POST ledger/recover', 'aithema.ledger'],
    ['GET ledger/holds', 'aithema.ledger'],
  ]);
  it('covers every host-owned route group, excluding host-to-service callbacks', () => {
    const signature = (r) => JSON.stringify({ class: r.class, capability: r.capability, checks: r.checks });
    assert.deepEqual([...new Set(routes.map(signature))].sort(), matrix.routes
      .filter((r) => r.class !== 'host-to-service').map(signature).sort());
    assert.deepEqual(routes.map((r) => [`${r.method} ${r.area}/${r.action}`, r.capability]), [...expectedCapabilities]);
  });

  for (const route of routes) {
    it(`${route.method} ${route.area}/${route.action || '(snapshot)'}: requires its exact capability, scope and authority`, () => {
      const { f, request } = routeScenario(route);
      const capability = expectedCapabilities.get(`${route.method} ${route.area}/${route.action}`);
      assert.equal(route.capability, capability);
      if (route.class === 'person-only') {
        assert.equal(f.host.request({ ...request, person: undefined, token: f.token() }).status, 403);
        assert.equal(f.host.request({ ...request, token: signToken(f.key, sessionClaims(f.sid)) }).status, 403);
        assert.equal(f.host.request(request).status, 200);
        return;
      }
      for (const different of matrix.delegated_allowed.filter((cap) => cap !== capability)) {
        assert.equal(f.host.request({ ...request, token: f.token({ capabilities: [different] }) }).status, 403, different);
      }
      assert.equal(f.host.request({ ...request, token: signToken(f.key, sessionClaims(f.sid)) }).status, 401);
      assert.equal(f.host.request({ ...request, token: undefined }).status, 401);
      assert.equal(f.host.request({ ...request, token: f.token({ tid: 'tenant-other' }) }).status, 403);
      assert.equal(f.host.request({ ...request, token: f.token({ sid: randomUUID() }) }).status, 403);
      if (route.checks.includes('pid')) assert.equal(f.host.request({ ...request, token: f.token({ pid: 'project-other' }) }).status, 403);
      assert.equal(f.host.request({ ...request, token: f.token({ sub: 'plugin-other' }) }).status, 403);
      assert.equal(f.host.request({ ...request, token: f.token({ act: { sub: 'person-other' } }) }).status, 403);
      assert.equal(f.host.request({ ...request, token: f.token({ iat: f.now() - 1000, exp: f.now() - 60 }) }).status, 401);
      if (route.checks.includes('epoch')) assert.equal(f.host.request({ ...request, token: f.token({ auth_epoch: 2 }) }).body.code, 'revoked');
      if (route.class === 'write' || route.class === 'control') assert.equal(f.host.request({ ...request, token: f.token({ gen: 2 }) }).body.code, 'fenced_generation');
      const good = f.host.request({ ...request, token: f.token({ capabilities: [capability] }) });
      assert.equal(good.status, 200, JSON.stringify(good.body));
      validDocuments(good.body);
      f.host.takeover(f.sid);
      if (route.class === 'read') {
        assert.equal(f.host.request(request).status, 200, 'read matrix intentionally omits generation');
      } else {
        assert.equal(f.host.request(request).body.code, 'fenced_generation', 'fencing must also precede exact replay');
      }
      f.host.revoke(f.sid);
      const revoked = f.host.request(request);
      if (route.checks.includes('epoch')) assert.equal(revoked.body.code, 'revoked');
      else assert.equal(revoked.status, 200, 'authority must report changes to old tokens');
    });
  }
});
