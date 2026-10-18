// Keep the SPDX identifier atomic while the translated prefix can wrap.
export function paintLicenseLabel(link, value) {
  const identifier = 'AGPL-3.0-only', start = value.indexOf(identifier);
  if (start < 0) { link.textContent = value; return; }
  const label = link.ownerDocument.createElement('span');
  const token = link.ownerDocument.createElement('span');
  token.className = 'demo-license-id'; token.textContent = identifier;
  label.append(value.slice(0, start), token, value.slice(start + identifier.length));
  link.replaceChildren(label);
}
