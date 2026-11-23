import type { Automation, AutomationInput, AutomationTrial, AutomationUpdate } from '@mail/domain';

import { aiConnection } from '../ai';
import { accountThinking, automationConnection, planAutomation, runnableAutomations } from '../automation';
import { createAutomation, deleteAutomation, listAutomations, readAutomation, updateAutomation } from '../automations';
import { accountFacts, previousRunAt, RECORDS_FACTS, runAccount, timedRequest } from '../facts';
import type { Providers } from '../providers';
import { conflict, notFound } from '../refusal';
import { resource } from '../response';
import { accountRoute, created, type Created } from './account';

/** Every Automation: each read, added, changed, and removed the same way, and tried without writing anything. */
export const automationRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/automations', accountRoute(async ({ db }): Promise<Automation[]> => listAutomations(db)));

  routes.get('/organizations/:accountId/automations/:automationId', accountRoute(async ({ db, params }): Promise<Automation> =>
    readAutomation(db, params.automationId ?? '')));

  routes.post('/organizations/:accountId/automations', accountRoute<Partial<AutomationInput>>(async ({ env, db, database, accountId, body }): Promise<Created<Automation>> =>
    created(await createAutomation(db, accountId, body, (await aiConnection(env, accountId, database))?.models ?? []))));

  routes.patch('/organizations/:accountId/automations/:automationId', accountRoute<AutomationUpdate>(async ({ env, db, database, accountId, body, params }): Promise<Automation> =>
    updateAutomation(db, params.automationId ?? '', body, body.model === undefined ? [] : (await aiConnection(env, accountId, database))?.models ?? [])));

  routes.delete('/organizations/:accountId/automations/:automationId', accountRoute(async ({ db, params }) => {
    const id = params.automationId ?? '';
    await deleteAutomation(db, id);
    return { id, deleted: true };
  }));

  /**
   * Runs one Automation now, in any state, as its Trigger Time would: it reads
   * what it reads, and every write it decides on is planned and shown, none
   * applied and no Run recorded.
   */
  routes.post('/organizations/:accountId/automations/:automationId/trial', accountRoute(async ({ env, db, database, accountId, params, key }): Promise<AutomationTrial> => {
    const [automation] = await runnableAutomations(db, { activeOnly: false, id: params.automationId ?? '' });
    if (!automation) throw notFound('自動化が見つかりません。');
    const at = new Date();
    const thinking = await accountThinking({ env, database, accountId, providers, accountKey: await key(), at });
    if (!thinking) throw conflict('先に AI 接続を設定してください。');
    const facts = `${accountFacts(await runAccount(env, { database, accountId }))}\n\n${RECORDS_FACTS}`;
    const request = timedRequest({ at, previous: await previousRunAt(database, automation.id) });
    const plan = await planAutomation({ thinking, automation, work: { request, facts }, executionMode: 'unattended', runId: `trial:${automation.id}` });
    if (!plan.skills) throw conflict(plan.error ?? 'この自動化が使うスキルが見つかりません。');
    return {
      automation: { id: automation.id, revision: automation.revision },
      model: plan.thought?.model ?? automationConnection(thinking.connection, automation.model).model,
      output: plan.thought?.output ?? '',
      toolCalls: plan.thought?.toolCallCount ?? 0,
      tokens: plan.thought?.tokens ?? 0,
      planned: plan.writes.map(({ tool, arguments: arguments_ }) => ({ tool, arguments: arguments_ })),
      error: plan.error,
    };
  }));

  return routes;
};
