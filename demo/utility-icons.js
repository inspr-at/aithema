// Lucide 1.31.0, ISC, copyright Lucide Contributors. Host utility glyphs.
const paths = {
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 22c1-5 4-7 8-7s7 2 8 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
