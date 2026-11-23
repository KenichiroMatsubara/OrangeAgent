/**
 * The Workflow that transcribes one recording: it tries, and when the
 * transcription itself fails it tries again a minute later and then two
 * minutes after that, before it records why the recording could not be
 * transcribed. The transcript's row in the Account's D1 stays the one record
 * of what came of it; the Workflow only wakes the work on time and carries it
 * on when the Worker running it goes away.
 *
 * A running instance replays the steps it finished by their names and order,
 * so a step is never renamed, reordered, or made to return something else
 * while an instance may still be running.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';

import { productionProviders } from './providers';
import { activeAccountDatabase } from './routes/request-context';
import { recordTranscriptionFailure, transcribeOnce, type Transcription } from './transcripts';
import type { Bindings } from './types';

export const TRANSCRIBE_STEP = 'transcribe';
export const FAILURE_STEP = 'record the failure';

/**
 * Three tries in all. Each may take a quarter of an hour, less than the time
 * after which a transcript nobody touches is shown as stopped (STALLED_MS), as
 * each try touches it when it starts.
 */
export const TRANSCRIBE_CONFIG = {
  retries: { limit: 2, delay: '1 minute', backoff: 'exponential' },
  timeout: '15 minutes',
} satisfies WorkflowStepConfig;

export class Transcriber extends WorkflowEntrypoint<Bindings, Transcription> {
  override async run(event: Readonly<WorkflowEvent<Transcription>>, step: WorkflowStep): Promise<void> {
    const { accountId, transcriptId } = event.payload;
    try {
      await step.do(TRANSCRIBE_STEP, TRANSCRIBE_CONFIG, async () => {
        const database = await activeAccountDatabase(this.env, accountId);
        if (!database) throw new Error('Account database is unavailable.');
        await transcribeOnce({ env: this.env, providers: productionProviders(), database, accountId, id: transcriptId });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do(FAILURE_STEP, async () => {
        const database = await activeAccountDatabase(this.env, accountId);
        if (database) await recordTranscriptionFailure(database, transcriptId, new Error(message));
      });
    }
  }
}
