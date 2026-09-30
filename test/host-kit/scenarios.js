import { routes, routePath } from './host.js';
import { admitRequest, budgetRequest, claimRequest, confirm, fixture, item, record, recoverRequest, snapshot } from './fixtures.js';

/** One executable scenario for every concrete route, reused over both transports. */
export function routeScenario(route) {
  const f = fixture();
  const request = { method: route.method, path: routePath(route.area, f.sid, route.action), token: f.token(), liveGrant: f.liveGrant };
  if (route.method === 'GET') {
    if (route.action === 'holds') request.path += '?state=open';
    return { f, request };
  }
  if (route.area === 'journal') {
    request.body = route.action === 'snapshots' ? snapshot(f.sid) : record(f.sid, route.action === 'op.result' ? 'op.result' : 'turn');
    return { f, request };
  }
  if (route.area === 'ledger') {
    if (route.action === 'admit') request.body = admitRequest(f.sid);
    else {
      const hold = f.request('ledger', 'admit', admitRequest(f.sid)).body.body.hold_id;
      if (route.action === 'claim') request.body = claimRequest(hold);
      if (route.action === 'recover') request.body = recoverRequest(hold);
      if (route.action === 'settle') {
        const claim = f.request('ledger', 'claim', claimRequest(hold)).body.body.claim_id;
        request.body = budgetRequest('settle', { claim_id: claim, outcome: 'settled', actual_micro: 20 });
      }
    }
    return { f, request };
  }
  if (['sources', 'transcript-turns'].includes(route.action)) {
    const isSource = route.action === 'sources';
    request.body = record(f.sid, isSource ? 'source' : 'turn');
    request.opKey = `${f.sid}:${isSource ? 'source' : 'turn'}:1`;
    return { f, request };
  }
  const first = item();
  confirm(f, first);
  if (route.action === 'drafts') {
    request.body = snapshot(f.sid, [first]);
    request.opKey = `${f.sid}:submit:1`;
    return { f, request };
  }
  const submitted = f.request('intake', 'drafts', snapshot(f.sid, [first]), { opKey: `${f.sid}:submit:1` });
  const old = submitted.body.snapshot.spec.items[0];
  const id = old.host.draft_id;
  request.path = routePath('intake', f.sid, route.action, id);
  if (route.action === 'accept') {
    delete request.token;
    request.person = f.host.personSession(f.sid, 'person-1');
  } else {
    const next = item({ version: 2, supersedes_item_version: { item_ref: 'REQ-1', version: 1 } });
    confirm(f, next);
    request.body = snapshot(f.sid, [{ ...old, state: 'superseded' }, next]);
    request.opKey = `${f.sid}:replace:1`;
  }
  return { f, request };
}

export { routes };
