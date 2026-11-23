import { ownerURL } from './owner-request.js';
import { postJson } from './post-json.js';

export const operatorLoginRoute = '/api/operator/login/';
export const operatorLogoutRoute = '/api/operator/logout/';

// The sign-in entry needs top-level navigation so the identity provider can redirect.
export function guardOperatorLogin(link, { admin = false } = {}) {
  const path = admin ? `${operatorLoginRoute}?return=admin` : operatorLoginRoute;
  try { link.href = ownerURL(link.ownerDocument.defaultView, path).href; }
  catch { link.removeAttribute('href'); }
}

export function wireOperatorLogout(form, { showError, onLogout }) {
  let pending = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    showError(false);
    try {
      const view = form.ownerDocument.defaultView;
      const response = await postJson(operatorLogoutRoute, {}, { view, cache: 'no-store', headers: { accept: 'application/json' } });
      if (response.status !== 204) throw new Error('Operator logout failed');
      onLogout?.();
      view.location.assign(new URL('/#settings-general', view.origin).href);
    } catch {
      showError(true);
    } finally {
      pending = false;
    }
  });
  form.querySelector('button').disabled = false;
}
