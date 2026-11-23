import { retryProvisioning } from '../onboarding';
import { dispatchDueAccountJobs } from '../job-dispatch';
import { indexPendingMemories } from '../memory/upkeep';
import { runDueAutomations } from '../timed';
import { productionProviders, type Providers } from '../providers';
import { REMINDER_JOB_KIND, reminderJobHandler } from '../reminders';
import type { Bindings } from '../types';

/**
 * The one tick. It runs the work that is late the moment its stated time
 * passes: queued Jobs, and every Automation whose Trigger Time has arrived.
 * It also indexes any memory not yet in the Memory's indexes.
 * One cron means no two invocations ever start the same Automation at once.
 */
export const DUE_WORK_CRON = '*/30 * * * *';

/**
 * Deployment-facing background capability. Individual Job, reminder, and
 * Automation implementations stay behind this one scheduled-use-case seam.
 */
export const runBackgroundWork = async (env: Bindings, providers: Providers = productionProviders()): Promise<void> => {
  const dueAt = new Date().toISOString();
  await retryProvisioning(env);
  await dispatchDueAccountJobs(env, dueAt, { [REMINDER_JOB_KIND]: reminderJobHandler(env, providers) });
  await runDueAutomations(env, new Date(dueAt), providers);
  await indexPendingMemories(env);
};
