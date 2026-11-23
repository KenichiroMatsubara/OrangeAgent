/**
 * The tools a run lends the JavaScript `code.run` runs in a Dynamic Worker
 * (`isolate.ts`): `env.TOOLS`, an RPC stub of this Worker's own `RunTools`
 * entrypoint, which holds the run's Run Token and puts every call to the run
 * that issued it, as the MCP Server does for a container's calls (ADR 0199,
 * 0203). The code reaches no network: the stub is its only way out, and it
 * calls only the tools the run offers, answered by the run's own handlers.
 * The token stays in this Worker and never reaches the code.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';

import { reachRun } from './rendezvous';
import { FileAnswer } from './turns';
import type { Bindings } from './types';

/** Whose run the stub calls: the Account and the Run Token the run issued. */
export interface ToolboxProps {
  accountId: string;
  token: string;
}

/** What the code finds as `env.TOOLS` and `tools`. */
export interface LentTools {
  call(name: string, arguments_?: Record<string, unknown>): Promise<unknown>;
  list(): Promise<Array<{ name: string; description: string }>>;
}

const ENDED = 'The run that lent these tools has ended, or its Run Token has expired, so the call was not made.';

/** A tool's answer as the code reads it: the answer itself, and the files it read beside it as their bytes. */
const plain = (value: unknown): unknown => value instanceof FileAnswer
  ? { answer: value.answer, files: value.files.map((file) => ({ filename: file.filename, mediaType: file.mediaType, bytes: file.bytes })) }
  : value;

export class RunTools extends WorkerEntrypoint<Bindings, ToolboxProps> {
  private reach() {
    const { accountId, token } = this.ctx.props;
    return this.env.RUN_CALLS ? reachRun({ namespace: this.env.RUN_CALLS, presented: token, accountId }) : Promise.resolve(null);
  }

  async call(name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> {
    const reached = await this.reach();
    if (!reached) return { isError: true, message: ENDED };
    if (!reached.tools.some((tool) => tool.name === name)) return { isError: true, message: `${name} is not one of the tools this run was given.` };
    return plain(await reached.call(name, arguments_ && typeof arguments_ === 'object' ? arguments_ : {}));
  }

  async list(): Promise<Array<{ name: string; description: string }>> {
    const reached = await this.reach();
    return reached ? reached.tools.map(({ name, description }) => ({ name, description })) : [];
  }
}

/** The Account a run's MCP Server URL path names, `/api/public/organizations/{account}/mcp`. */
export const accountOfPath = (path: string): string | null => {
  const found = /\/organizations\/([^/]+)\/mcp$/u.exec(path);
  return found?.[1] ? decodeURIComponent(found[1]) : null;
};

/** The stub of `RunTools` for one run's Run Token, which the Dynamic Worker is given as `env.TOOLS`. */
export const lentTools = (props: ToolboxProps): Fetcher => {
  const entrypoint = (exports as unknown as { RunTools?: (options: { props: ToolboxProps }) => Fetcher }).RunTools;
  if (!entrypoint) throw new Error('This Worker does not export RunTools, so it cannot lend a run\'s tools to its code.');
  return entrypoint({ props });
};
