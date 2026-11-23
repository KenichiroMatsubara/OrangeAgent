/**
 * What the Worker writes to its own log, where Workers Logs keeps it: one JSON
 * line per event, searchable by its fields.
 */

/** The longest a logged tool argument is written out; the rest is cut so one log line stays readable. */
const LOGGED_ARGUMENTS = 2_000;

/**
 * Writes one failed tool call to the Worker's log, as one JSON line Workers
 * Logs can search by its fields: which run, which tool, with what, and why.
 */
export const logToolFailure = (input: { tool: string; arguments: string; error: string; trace?: Readonly<Record<string, string>> }): void => {
  const arguments_ = input.arguments.length > LOGGED_ARGUMENTS ? `${input.arguments.slice(0, LOGGED_ARGUMENTS)}…` : input.arguments;
  console.error(JSON.stringify({ event: 'tool_failed', ...input.trace, tool: input.tool, arguments: arguments_, error: input.error }));
};

/**
 * Writes what one model request consumed to the Worker's log, as one JSON
 * line Workers Logs can filter and chart by its fields: the run and the
 * provider, which request of the run it was (`request` 1 is the first, whose
 * cache read is what the conversation before the message was served again
 * with), how many messages it carried, and how much of its prompt the
 * provider served from its prompt cache (`cachedTokens` of `promptTokens`,
 * and `cachedPercent`) and wrote to it (`cacheWriteTokens`, where the provider
 * says), and what it cost in US dollars where that is known (`costUsd`, with
 * `costBilled` true when the provider billed it rather than Pi's catalog
 * pricing it).
 */
export const logModelUsage = (input: {
  model: string;
  host: string;
  request: number;
  messages: number;
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number; cacheWriteTokens?: number; costUsd?: number; costBilled?: boolean };
  trace?: Readonly<Record<string, string>>;
}): void => {
  const { usage } = input;
  console.log(JSON.stringify({
    event: 'model_usage',
    ...input.trace,
    model: input.model,
    host: input.host,
    request: input.request,
    messages: input.messages,
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    cachedPercent: usage.promptTokens ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0,
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    completionTokens: usage.completionTokens,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd, costBilled: usage.costBilled === true }),
  }));
};

/**
 * Writes one call of a run's browser to the Worker's log: which tool, whether
 * it did what it was asked (`ok`), and how long it took in milliseconds
 * (`ms`), loading and settling the page and reading it back included. The
 * call that started the browser also says how long starting it took
 * (`startMs`), which `ms` includes.
 */
export const logBrowserCall = (input: { tool: string; ok: boolean; ms: number; startMs?: number; trace?: Readonly<Record<string, string>> }): void => {
  console.log(JSON.stringify({
    event: 'browser_call',
    ...input.trace,
    tool: input.tool,
    ok: input.ok,
    ms: input.ms,
    ...(input.startMs === undefined ? {} : { startMs: input.startMs }),
  }));
};

/**
 * Writes one Browser Run session to the Worker's log: how long it was held,
 * from acquiring it to closing it (`ms`), which is the time Browser Run bills,
 * and how many browser calls it served (`calls`).
 */
export const logBrowserSession = (input: { ms: number; calls: number; trace?: Readonly<Record<string, string>> }): void => {
  console.log(JSON.stringify({ event: 'browser_session', ...input.trace, ms: input.ms, calls: input.calls }));
};

/**
 * Writes one end of a Browser Login's sign-in to the Worker's log: `started`
 * when its browser is acquired, and `ended` with how it ended (`how`) when
 * OrangeAgent closes it. The two lines of one sign-in share its `loginId`, and
 * the time between them is what Browser Run bills; a sign-in nobody saved or
 * stopped ends when Browser Run's twenty minutes run out, with no `ended`.
 */
export const logBrowserSignIn = (input: { accountId: string; loginId: string; phase: 'started' | 'ended'; how?: 'saved' | 'cancelled' | 'removed' | 'replaced' | 'failed' }): void => {
  console.log(JSON.stringify({ event: 'browser_sign_in', accountId: input.accountId, loginId: input.loginId, phase: input.phase, ...(input.how ? { how: input.how } : {}) }));
};
