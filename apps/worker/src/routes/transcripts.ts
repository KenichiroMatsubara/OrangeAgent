import type { MinutesInput, TranscriptDetail, TranscriptList, TranscriptSummary } from '@mail/domain';

import { aiConnection } from '../ai';
import type { Providers } from '../providers';
import { invalid } from '../refusal';
import { resource } from '../response';
import { readTranscriptionConnection } from '../transcription';
import {
  createTranscript,
  listTranscripts,
  performTranscriptWork,
  readRecording,
  readTranscript,
  removeTranscript,
  renameTranscript,
  requestMinutes,
  restartTranscription,
  transcriptionInstance,
  type TranscriptWork,
} from '../transcripts';
import { accountRoute, created, type AccountRequest } from './account';

/** The form field a recording is uploaded in. */
const RECORDING_FIELD = 'recording';

/**
 * Starts work that outlasts this request. A transcription runs as a Workflow,
 * which tries again when the transcription fails; minutes, and a
 * transcription where no Workflow is bound, run in the Durable Object, which
 * keeps running once the screen that asked is closed, or, where there is
 * none, as this request's own background task.
 */
const launch = async (request: AccountRequest<unknown>, providers: Providers, work: TranscriptWork): Promise<void> => {
  const { env, database } = request;
  if (work.kind === 'transcribe' && env.TRANSCRIBER) {
    await env.TRANSCRIBER.create({
      id: transcriptionInstance(work.transcriptId, Date.now()),
      params: { accountId: work.accountId, transcriptId: work.transcriptId },
    });
    return;
  }
  if (env.CHAT_EXCHANGES) {
    const object = env.CHAT_EXCHANGES.get(env.CHAT_EXCHANGES.idFromName(`transcript:${work.transcriptId}`));
    await object.fetch('https://chat-exchange.internal/transcripts', { method: 'POST', body: JSON.stringify(work) });
    return;
  }
  request.waitUntil(performTranscriptWork({ env, providers, database, work }));
};

/** The 文字起こし screen: recordings uploaded, their transcripts, and the minutes written from them. */
export const transcriptRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/transcripts', accountRoute(async (request): Promise<TranscriptList> => {
    const [transcripts, transcription, ai] = await Promise.all([
      listTranscripts(request.db),
      request.key().then((key) => readTranscriptionConnection(request.db, key, request.accountId)),
      aiConnection(request.env, request.accountId, request.database),
    ]);
    return { transcripts, transcription: transcription !== null, minutes: ai !== null };
  }));

  routes.post('/organizations/:accountId/transcripts', accountRoute(async (request) => {
    const form = await request.raw.formData().catch((): never => { throw invalid('録音を読み取れませんでした。'); });
    const file = form.get(RECORDING_FIELD);
    if (!file || typeof file === 'string') throw invalid('録音を選んでください。');
    const transcript = await createTranscript({
      db: request.db,
      bucket: request.env.RECOVERY_RECEIPTS,
      key: await request.key(),
      accountId: request.accountId,
      upload: { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
      createdBy: request.session.display_name.trim() || request.session.email,
    });
    await launch(request, providers, { kind: 'transcribe', accountId: request.accountId, transcriptId: transcript.id });
    return created(transcript);
  }, { body: 'file' }));

  routes.get('/organizations/:accountId/transcripts/:transcriptId', accountRoute(async (request): Promise<TranscriptDetail> =>
    readTranscript(request.db, request.params.transcriptId ?? '')));

  routes.patch('/organizations/:accountId/transcripts/:transcriptId', accountRoute<{ title?: unknown }>(async (request): Promise<TranscriptSummary> => {
    if (typeof request.body.title !== 'string') throw invalid('名前を入力してください。');
    return renameTranscript(request.db, request.params.transcriptId ?? '', request.body.title);
  }));

  routes.delete('/organizations/:accountId/transcripts/:transcriptId', accountRoute(async (request) => {
    const id = request.params.transcriptId ?? '';
    await removeTranscript({ db: request.db, bucket: request.env.RECOVERY_RECEIPTS, id });
    return { id, deleted: true };
  }));

  routes.post('/organizations/:accountId/transcripts/:transcriptId/transcribe', accountRoute(async (request): Promise<TranscriptSummary> => {
    const transcript = await restartTranscription({ db: request.db, key: await request.key(), accountId: request.accountId, id: request.params.transcriptId ?? '' });
    await launch(request, providers, { kind: 'transcribe', accountId: request.accountId, transcriptId: transcript.id });
    return transcript;
  }));

  routes.post('/organizations/:accountId/transcripts/:transcriptId/minutes', accountRoute<MinutesInput>(async (request): Promise<TranscriptDetail> => {
    const instructions = request.body.instructions;
    if (instructions !== undefined && typeof instructions !== 'string') throw invalid('議事録への指示は文字で入力してください。');
    const transcript = await requestMinutes({
      env: request.env, database: request.database, accountId: request.accountId, id: request.params.transcriptId ?? '', instructions: instructions ?? '',
    });
    await launch(request, providers, { kind: 'minutes', accountId: request.accountId, transcriptId: transcript.id });
    return transcript;
  }));

  /** The recording as it was uploaded, to be played on the screen beside its transcript. */
  routes.get('/organizations/:accountId/transcripts/:transcriptId/recording', accountRoute(async (request): Promise<Response> => {
    const recording = await readRecording({ db: request.db, bucket: request.env.RECOVERY_RECEIPTS, id: request.params.transcriptId ?? '' });
    return new Response(recording.body, {
      headers: {
        'Content-Type': recording.mediaType,
        'Content-Length': String(recording.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(recording.filename)}`,
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }));

  return routes;
};
