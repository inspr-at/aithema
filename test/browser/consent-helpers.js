// Keep existing component behaviour/geometry tests in the same document. The
// dedicated journey spec exercises the real consent-page actions and return.
export async function mockConsent(page, granted = true) {
  return page.evaluate(async granted => {
    const c = document.querySelector('aithema-session');
    const { postJson } = await import('/packages/ui/src/post-json.js');
    const response = await postJson(`/api/sessions/${c.session.id}/consent`, { granted });
    if (!response.ok) throw new Error('Consent fixture failed');
    c.receive((await response.json()).event);
  }, granted);
}
