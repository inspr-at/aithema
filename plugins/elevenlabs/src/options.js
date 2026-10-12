import { AI_NOTICE, aiNoticeText } from '../../../packages/core/src/ai-notice.js';

// Only language and the matching opening AI notice or silent continuation cross this boundary.
export function voiceOverrides(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'agent') ||
    !value.agent || typeof value.agent !== 'object' || Array.isArray(value.agent) ||
    Object.keys(value.agent).some(key => !['language', 'firstMessage'].includes(key)) ||
    value.agent.language !== undefined && (typeof value.agent.language !== 'string' ||
      !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value.agent.language))) throw new TypeError('Invalid voice presentation overrides');
  if (value.agent.firstMessage !== undefined && (!Object.hasOwn(AI_NOTICE, value.agent.language ?? '') ||
    !['', aiNoticeText(value.agent.language)].includes(value.agent.firstMessage))) throw new TypeError('Invalid voice AI notice');
  return structuredClone(value);
}
