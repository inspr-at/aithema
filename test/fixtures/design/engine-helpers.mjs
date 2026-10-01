import { randomUUID } from 'node:crypto';
import { TextEngine } from '../../../runtime/engine/index.js';
import { fixture } from '../../engine-helpers.test.js';
import { screen, submission } from './helpers.mjs';
import { requestDesign } from './engine.mjs';

/** Real SQLite/ledger/authorization, with synthetic reasoning and design IR. */
export function engineFixture(t, options = {}) {
  const f = fixture(t, options);
  f.engine.close();
  const reads = [];
  const reasoning = {
    async *streamChat(request) {
      const lane = request.system.startsWith('Return only JSON {say') ? 'reaction' : 'spec';
      const payload = JSON.parse(request.messages[0].content);
      f.calls.push({ lane, payload });
      request.onUsage({ input_tokens: 1, output_tokens: 1 });
      yield JSON.stringify(await (options.handler ?? requestDesign)(lane, payload));
    },
    understand() { throw new Error('Unexpected reasoning path'); },
  };
  const getDesignInput = options.getDesignInput ?? ((revision) => {
    reads.push(structuredClone(revision));
    const screen_ir = screen();
    screen_ir.nodes = [{ kind: 'text', id: 'requirement', text: revision.spec.items[0]?.content.statement ?? 'Synthetic screen' }];
    return submission(options.brand ?? 'a', { screen_ir, generation: f.client.authority.gen, client_event_id: randomUUID() });
  });
  const engineOptions = { journal: f.client, journalPort: f.port, budget: f.budget,
    authorization: f.authz, reasoning, clock: f.clock,
    maxMicro: { reaction: 100, spec: 100, design: 100 }, priceUsage: () => 7,
    designWaitMs: options.designWaitMs ?? 0, checkpoint: options.checkpoint,
    renderer: options.renderer, getDesignInput,
    onError: (error) => f.errors.push(error) };
  const engine = new TextEngine(engineOptions);
  t?.after(() => engine.close());
  return { ...f, engine, reads, getDesignInput, engineOptions, close() { engine.close(); f.close(); } };
}
