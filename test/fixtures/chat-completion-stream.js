const encoder = new TextEncoder();

export function completionStream(content, { id, usage, finish = 'stop' } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      const send = value => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      send({ id, choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
      if (usage !== undefined) send({ id, choices: [], usage });
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
