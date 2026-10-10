// Only non-secret presentation overrides cross the server/browser boundary: the language. The first
// message is the agent's spoken AI notice (Art. 50(1), AIT-119); no override may replace it.
export function voiceOverrides(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'agent') ||
    !value.agent || typeof value.agent !== 'object' || Array.isArray(value.agent) ||
    Object.keys(value.agent).some(key => key !== 'language') ||
    value.agent.language !== undefined && (typeof value.agent.language !== 'string' ||
      !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value.agent.language))) throw new TypeError('Invalid voice presentation overrides');
  return structuredClone(value);
}
