// Startup must stay external: only the exact import map is hash-approved inline.
import 'html-preview';

window.violations = [];
addEventListener('securitypolicyviolation', event => window.violations.push({
  directive: event.effectiveDirective, blocked: event.blockedURI,
  disposition: event.disposition, policy: event.originalPolicy, trusted: event.isTrusted,
}));
window.show = html => {
  document.querySelector('aithema-html-preview').artifact = {
    bytes: new TextEncoder().encode(html), mediaType: 'text/html',
  };
};
window.ready = true;
