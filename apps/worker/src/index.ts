import { app } from './app';
import { runBackgroundWork } from './background/runner';

import type { Bindings } from './types';

export { ChatExchanges } from './exchange-object';
export { RunCalls } from './rendezvous-object';
export { ChatThreads } from './thread';
export { RunTools } from './toolbox';
export { Transcriber } from './transcriber';
export { WorkbenchBasic, WorkbenchLite, WorkbenchStandard1, WorkbenchStandard4 } from './workbench';

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Bindings, context: ExecutionContext) => {
    context.waitUntil(runBackgroundWork(env));
  },
} satisfies ExportedHandler<Bindings>;
