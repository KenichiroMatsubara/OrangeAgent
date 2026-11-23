/**
 * A Chat Completions answer as the provider streams it, which is how Pi asks
 * every model: the test writes the answer whole, as one non-streamed body
 * would hold it, and this sends it as the chunks of one stream.
 */

interface Answer {
  model?: string;
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: Record<string, unknown>;
}

export const streamedCompletion = (answer: Answer): Response => {
  const model = answer.model ?? 'test-model';
  const message = answer.choices?.[0]?.message ?? {};
  const calls = message.tool_calls ?? [];
  const chunk = (delta: unknown, finish: string | null, usage?: Record<string, unknown>) => `data: ${JSON.stringify({
    id: 'completion-1', object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
  const body = [
    chunk({ role: 'assistant', ...(message.content ? { content: message.content } : {}) }, null),
    ...calls.map((call, index) => chunk({ tool_calls: [{ index, id: call.id ?? `call-${index}`, type: 'function', function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' } }] }, null)),
    chunk({}, calls.length ? 'tool_calls' : 'stop', answer.usage),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
