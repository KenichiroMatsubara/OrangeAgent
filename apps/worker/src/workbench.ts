/**
 * The Durable Objects that start OrangeAgent's containers (ADR 0202), one class
 * per size, because Cloudflare fixes a container's instance type by the class
 * it belongs to. Each object starts its container for one job, with no
 * network, runs the job, and destroys the container whatever happened.
 *
 * A job lent the run's Run Token reaches one host, `orangeagent.internal`: its
 * requests are handed to this Worker's own MCP Server, which puts each call
 * to the run that issued the token (ADR 0199, 0203). Nothing else gets out.
 *
 * This is the shape Cloudflare's Sandbox SDK 1.0 gives a sandbox: the
 * Durable Object starts, runs, and destroys its container through
 * `ctx.container`, and the SDK's `Files` moves the job's files in and out.
 */

import { Files } from '@cloudflare/sandbox';
import { DurableObject } from 'cloudflare:workers';

import { BRIDGE_HOST, FORMER_BRIDGE_HOST, ready, runInContainer } from './container';
import type { CodeJob, CodeResult } from './environment';
import type { Bindings } from './types';

class Workbench extends DurableObject<Bindings> {
  async run(job: CodeJob): Promise<CodeResult> {
    const { container } = this.ctx;
    if (!container) throw new Error('This Durable Object has no container bound to it.');
    if (job.bridge) {
      // This Worker's own default entrypoint, which serves the MCP Server.
      const own = (this.ctx.exports as { default?: Fetcher }).default;
      if (!own) throw new Error('This Worker cannot reach its own MCP Server from a container.');
      await container.interceptOutboundHttp(BRIDGE_HOST, own);
      await container.interceptOutboundHttp(FORMER_BRIDGE_HOST, own);
    }
    if (!container.running) container.start({ enableInternet: false });
    try {
      await ready(container);
      return await runInContainer(container, new Files(container), job);
    } finally {
      await container.destroy().catch(() => undefined);
    }
  }
}

/** 1/16 vCPU, 256 MiB. */
export class WorkbenchLite extends Workbench {}
/** 1/4 vCPU, 1 GiB. */
export class WorkbenchBasic extends Workbench {}
/** 1/2 vCPU, 4 GiB. */
export class WorkbenchStandard1 extends Workbench {}
/** 4 vCPU, 12 GiB. */
export class WorkbenchStandard4 extends Workbench {}
