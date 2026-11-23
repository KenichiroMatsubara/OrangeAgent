/**
 * The Trigger Time: finds each Account's Automations whose stated time has
 * arrived and runs them. A run starts knowing nothing of its previous runs
 * except when the latest one began, and finds its own work through its tools,
 * as its Skills tell it to, so nothing it once concluded can stand in for what
 * the world says now.
 *
 * An Automation is moved to its next stated time before it runs, so a slow run
 * cannot be picked up a second time while it is still going. Each tick also
 * keeps the Account's runs moving: it expires approvals left too long and
 * resumes writes an interrupted run left unfinished. And it copies a share of
 * the Tasks the Account kept in FlareChat into Google Tasks, until none is left
 * (ADR 0198).
 */

import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';

import { accountThinking, runAutomation, runnableAutomations, type AutomationOutcome } from './automation';
import { createDatabaseAccess } from './database-access';
import { executionFor } from './execution';
import { accountFacts, previousRunAt, RECORDS_FACTS, runAccount, timedRequest } from './facts';
import { openInbox, verifyInboxCredential } from './inbox';
import { accountKeyFor } from './keys';
import { productionProviders, type Providers } from './providers';
import { nextScheduledRun } from './schedule';
import { ensureStarterAutomations } from './starter';
import { createAccountStore } from './storage/account-store';
import { hasTasksToMove, moveTasksToGoogle } from './tasks';
import { accounts } from './storage/control-schema';
import { automations } from './storage/account-schema';
import { accountDatabase, controlDatabase } from './storage/database';
import type { Bindings } from './types';

/** The ids of the Automations that are on and whose stated time has arrived, oldest first. */
const dueAutomationIds = async (database: D1Database, at: Date): Promise<string[]> =>
  (await accountDatabase(database).select({ id: automations.id }).from(automations)
    .where(and(
      eq(automations.trigger, 'schedule'),
      eq(automations.enabled, true),
      isNotNull(automations.nextRunAt),
      lte(automations.nextRunAt, at.toISOString()),
    ))
    .orderBy(asc(automations.nextRunAt)).all()).map(({ id }) => id);

/** Moves an Automation to its next stated time. */
const advance = async (database: D1Database, automationId: string, at: Date): Promise<void> => {
  const db = accountDatabase(database);
  const row = await db.select({ schedule: automations.schedule }).from(automations).where(eq(automations.id, automationId)).get();
  await db.update(automations)
    .set({ nextRunAt: row?.schedule ? nextScheduledRun({ schedule: row.schedule, after: at }) : null, updatedAt: at.toISOString() })
    .where(eq(automations.id, automationId)).run();
};

/**
 * Copies the next share of the Tasks an Account kept in FlareChat into Google
 * Tasks, once its Automation Inbox's grant reaches Google Tasks. An Account
 * with no mailbox, or one connected before the grant asked for Google Tasks,
 * keeps its rows as they are until it connects one. A failure is logged and
 * tried again at the next tick: it must not stop the Account's Automations.
 */
const moveKeptTasks = async (input: { env: Bindings; database: D1Database; accountId: string; providers: Providers }): Promise<void> => {
  try {
    if (!await hasTasksToMove(input.database)) return;
    const inbox = await createAccountStore(accountDatabase(input.database)).currentAutomation();
    if (inbox?.status !== 'active' || !inbox.tasksGranted) return;
    const session = await openInbox({ env: input.env, accountId: input.accountId, database: input.database, google: input.providers.google });
    const { moved } = await moveTasksToGoogle({ database: input.database, session: { google: input.providers.google, accessToken: session.accessToken } });
    console.log(JSON.stringify({ event: 'tasks_moved_to_google', accountId: input.accountId, moved }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'tasks_move_failed',
      accountId: input.accountId,
      message: error instanceof Error ? error.message : 'The Account’s Tasks could not be copied into Google Tasks.',
    }));
  }
};

/** Runs every Account's due Automations once each. */
export const runDueAutomations = async (env: Bindings, at: Date, providers: Providers = productionProviders()): Promise<AutomationOutcome[]> => {
  const activeAccounts = await controlDatabase(env.CONTROL_DB).select({
    id: accounts.id,
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(and(eq(accounts.status, 'active'), isNotNull(accounts.databaseId))).all();
  const outcomes: AutomationOutcome[] = [];
  const databases = createDatabaseAccess(env);
  for (const account of activeAccounts) {
    // One Account whose database or schema is unreachable must not stop the Accounts after it.
    try {
      const database = (await databases.open({ kind: 'organization', bindingName: account.bindingName, databaseId: account.databaseId })).raw;
      await ensureStarterAutomations(accountDatabase(database), account.id);
      const execution = executionFor({ env, database, accountId: account.id, providers });
      await execution.abandonStalled();
      await execution.expireApprovals();
      await execution.resumeDue();
      await moveKeptTasks({ env, database, accountId: account.id, providers });
      const due = await dueAutomationIds(database, at);
      if (!due.length) continue;
      await verifyInboxCredential({ env, accountId: account.id, database, google: providers.google });
      const accountKey = await accountKeyFor(env, account.id);
      const thinking = await accountThinking({ env, database, accountId: account.id, providers, accountKey, at });
      const facts = `${accountFacts(await runAccount(env, { database, accountId: account.id }))}\n\n${RECORDS_FACTS}`;
      for (const automationId of due) {
        const previous = await previousRunAt(database, automationId);
        await advance(database, automationId, at);
        const [automation] = await runnableAutomations(accountDatabase(database), { activeOnly: true, id: automationId });
        if (!automation) continue;
        if (!thinking) {
          const { id: runId } = await execution.open({
            trigger: 'schedule', automation: { id: automation.id, revision: automation.revision }, executionMode: automation.executionMode,
          });
          const error = 'This Automation needs an active AI Connection.';
          await execution.close(runId, {
            outcome: 'failed',
            thought: { model: null, skills: [], toolCalls: 0, tokens: 0, output: null, error, transcriptKey: null, transcriptExpiresAt: null },
          });
          outcomes.push({ runId, status: 'failed', output: '', error, unreachableServers: [] });
          continue;
        }
        outcomes.push(await runAutomation({
          thinking, execution, bucket: env.RECOVERY_RECEIPTS, accountId: account.id, automation,
          work: { request: timedRequest({ at, previous }), facts },
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'timed_automations_skipped',
        accountId: account.id,
        message: error instanceof Error ? error.message : 'The Account’s Automations could not run.',
      }));
    }
  }
  return outcomes;
};
