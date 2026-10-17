// Access moves between the concept bar and phone dock. Guard the action row
// itself as well as the bar, and combine the two owners of its inert state.
export const CONCEPT_CONTROLS = '.concept-bar, .concept-access';
export function conceptControlsBlocked(root) {
  const { stage, emailAsk } = root.querySelector('.workspace').dataset;
  return stage !== 'live' || emailAsk === 'dock';
}
export function guardConceptControls(root) {
  const blocked = conceptControlsBlocked(root);
  for (const control of root.querySelectorAll(CONCEPT_CONTROLS)) control.inert = blocked;
}
