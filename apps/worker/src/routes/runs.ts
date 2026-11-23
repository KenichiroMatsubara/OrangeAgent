import type { Run, RunTranscript } from '@mail/domain';

import { readRunTranscript } from '../automation';
import { executionFor } from '../execution';
import type { Providers } from '../providers';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { accountRoute, type AccountRequest } from './account';

/** The Runs of the Account's one Execution, whichever Automation or entrance started them. */
export const runRoutes = (providers: Providers) => {
  const routes = resource();
  const execution = (request: AccountRequest<unknown>) =>
    executionFor({ env: request.env, database: request.database, accountId: request.accountId, providers });

  routes.get('/organizations/:accountId/runs', accountRoute(async (request): Promise<Run[]> => {
    const automationId = request.query('automationId')?.trim();
    return execution(request).list({ ...(automationId ? { automationId } : {}) });
  }));

  routes.get('/organizations/:accountId/runs/:runId', accountRoute(async (request): Promise<Run> => execution(request).read(request.params.runId ?? '')));

  routes.post('/organizations/:accountId/runs/:runId/decision', accountRoute<{ decision?: string }>(async (request) => {
    if (request.body.decision !== 'approve' && request.body.decision !== 'reject') throw invalid('承認するか却下するかを選んでください。');
    return execution(request).decide({
      runId: request.params.runId ?? '',
      decision: request.body.decision,
      actorIdentityId: request.session.identity_id,
    });
  }));

  routes.get('/organizations/:accountId/runs/:runId/transcript', accountRoute(async (request): Promise<RunTranscript> => {
    const run = await execution(request).read(request.params.runId ?? '');
    const transcript = run.transcript
      ? await readRunTranscript({ bucket: request.env.RECOVERY_RECEIPTS, accountKey: await request.key(), accountId: request.accountId, runId: run.id })
      : null;
    if (!transcript) throw notFound('この実行の記録は残っていません。');
    return transcript;
  }));

  return routes;
};
