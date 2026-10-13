// The final General section: native navigation and a same-origin POST form.
// Auth state comes from the host, never from visitor identity or a local role.
export class OperatorSettings {
  constructor({ parent, copy, operator }) {
    if (operator?.url !== '/api/operator/login/' || operator.logoutUrl !== '/api/operator/logout/') return;
    this.copy = copy; this.operator = operator;
    const section = parent.ownerDocument.createElement('section'); section.className = 'operator-section';
    section.innerHTML = `<div class="operator-row">
      <a class="operator-view operator-login" href="/api/operator/login/">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 4h6v16h-6M3 12h12m-4-4 4 4-4 4"/></svg><span></span></a>
      <form class="operator-view operator-signed-in" method="post" action="/api/operator/logout/">
        <span class="operator-name"></span><span aria-hidden="true"> · </span><button type="submit" class="operator-logout"></button></form>
      </div><div class="operator-notice"><p class="m-notice operator-error" role="status" aria-live="polite"></p>
        <p class="m-notice operator-error-measure" aria-hidden="true"></p></div>`;
    this.element = section; parent.append(section); this.paint();
  }
  setCopy(copy) { this.copy = copy; this.paint(); }
  set(operator) { this.operator = operator; this.paint(); }
  paint() {
    const s = this.element; if (!s) return;
    const c = this.copy.settings, signedIn = typeof this.operator.name === 'string';
    for (const node of s.querySelectorAll('.operator-view')) {
      const shown = node.classList.contains('operator-signed-in') === signedIn;
      node.classList.toggle('on', shown); node.inert = !shown; node.setAttribute('aria-hidden', String(!shown));
    }
    s.querySelector('.operator-login span').textContent = c.operatorLogin.replace('{provider}', this.operator.provider);
    s.querySelector('.operator-name').textContent = c.operatorName.replace('{name}', this.operator.name ?? '');
    s.querySelector('.operator-logout').textContent = c.operatorLogout;
    s.querySelector('.operator-error').textContent = this.operator.error && !signedIn ? c.operatorError : '';
    s.querySelector('.operator-error-measure').textContent = c.operatorError;
  }
}
