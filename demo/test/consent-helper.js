import { postJson } from '../../packages/ui/src/post-json.js';
// Component integration tests arrange the server grant directly; page actions
// and navigation are exercised by consent-page and start-journey tests.
export async function reviseMockConsent(component, granted = true) {
  // AIT-625: the request leaves from the component's page, as the element's own requests do.
  const response = await postJson(`/api/sessions/${component.session.id}/consent`, { granted }, { view: component.ownerDocument.defaultView });
  if (!response.ok) throw new Error('Consent fixture failed');
  component.receive((await response.json()).event);
}
