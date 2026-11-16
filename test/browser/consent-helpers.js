// D509b keeps a navigating host for the existing consent-page and AIT-501
// return checks while the demo itself uses the in-page editor.
export async function useNavigatingConsentHost(page) {
  await page.evaluateOnNewDocument(() => {
    if (window !== window.top) return;
    window.addEventListener('aithema-consent', event => {
      const id = event.detail.sessionId;
      event.stopImmediatePropagation();
      location.assign(`/consent/?session=${encodeURIComponent(id)}&return=/`);
    }, { capture: true });
  });
}

// Keep existing component behaviour/geometry tests in the same document.
export async function mockConsent(page, granted = true) {
  return page.evaluate(async granted => {
    const c = document.querySelector('aithema-session');
    const { postJson } = await import('/packages/ui/src/post-json.js');
    const response = await postJson(`/api/sessions/${c.session.id}/consent`, { granted });
    if (!response.ok) throw new Error('Consent fixture failed');
    c.receive((await response.json()).event);
  }, granted);
}
