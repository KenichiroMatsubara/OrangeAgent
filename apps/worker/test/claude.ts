/** A Messages API response as Anthropic streams it, every block whole in its start event. */
export const streamed = (message: Record<string, unknown> & { content: unknown[] }): Response => {
  const { content, stop_reason: stopReason, stop_sequence: stopSequence, usage, container, ...rest } = message;
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage, ...(container ? { container } : {}) } },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: stopSequence ?? null, ...(container ? { container } : {}) }, usage },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
};
