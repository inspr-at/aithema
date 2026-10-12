// The agreed no-op while AIT-140 builds reveal.js. At integration, change the session-element
// import to ./reveal.js. The call site already supplies the complete shared contract.
export function createReveal({ band, orb, controls, links, version, copy, motion }) {
  return { destroy() {}, setMotion() {}, close() {} };
}
