// Historical operation tests exercise HTTP fan-out through the adapter codec.
// Their identity, budget, receipt and lifecycle assertions remain unchanged.
import { createVoiceTurnOperations as createTextOperations } from '../packages/server/src/voice-turns.js';
import { runElevenLabsReply } from '../plugins/elevenlabs/src/reply.js';

export function createVoiceTurnOperations(options) {
  const turns = createTextOperations(options);
  return { ...turns, run: (context, execute, opts) => runElevenLabsReply(turns, context, execute, opts) };
}
