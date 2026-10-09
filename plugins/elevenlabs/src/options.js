// Only non-secret presentation overrides cross the server/browser boundary.
export function voiceOverrides(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'agent') ||
    !value.agent || typeof value.agent !== 'object' || Array.isArray(value.agent) ||
    Object.keys(value.agent).some(key => !['language', 'firstMessage'].includes(key)) ||
    Object.values(value.agent).some(item => typeof item !== 'string') ||
    value.agent.language !== undefined && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value.agent.language) ||
    (value.agent.firstMessage?.length ?? 0) > 16_384) throw new TypeError('Invalid voice presentation overrides');
  return structuredClone(value);
}
