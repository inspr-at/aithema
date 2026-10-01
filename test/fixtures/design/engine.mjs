import { defaultOutput } from '../../engine-helpers.test.js';

export const requestDesign = (lane, payload) => lane === 'reaction'
  ? { say: 'Design requested.', question_id: null, tools: [{ name: 'design_intent' }] }
  : defaultOutput(lane, payload);

export async function textDesign(f) {
  const seq = f.personTurn();
  await f.engine.start();
  await f.engine.passSpec();
  await f.engine.react(seq);
  await f.clock.advance(0);
  return f.engine.state;
}
