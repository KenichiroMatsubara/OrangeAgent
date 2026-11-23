/**
 * 文字起こし: a recording uploaded on its own screen, transcribed speaker by
 * speaker through the Transcription Connection, and, when the person asks,
 * written up as minutes by the AI Connection. Neither is Operator Chat: no
 * tool is offered, nothing is written anywhere but here, and no Run is kept.
 *
 * Transcribing and writing take longer than a request lasts, so each is
 * started by the route and carried on in a Durable Object, which records what
 * came of it on the row. A row still marked as in progress long after its
 * work last moved is shown as stopped, so it can be started again.
 */

import { desc, eq } from 'drizzle-orm';

import {
  MINUTES_MISSING,
  RECORDING_BYTES,
  TRANSCRIPTION_MISSING,
  isRecordingType,
  oversizedRecordingText,
  recordingType,
  transcriptPlainText,
  unsupportedRecordingText,
  type RecordingType,
  type TranscriptDetail,
  type TranscriptLine,
  type TranscriptSummary,
} from '@mail/domain';

import { aiConnection } from './ai';
import { now } from './clock';
import { accountKeyFor } from './keys';
import type { Providers } from './providers';
import { conflict, invalid, notFound } from './refusal';
import { transcripts } from './storage/account-schema';
import { accountDatabase, type AccountDatabase } from './storage/database';
import { durationOf, readTranscriptionConnection, transcriptLines } from './transcription';
import type { Bindings } from './types';

type Row = typeof transcripts.$inferSelect;

const recordingKey = (accountId: string, id: string): string => `transcripts/${accountId}/${id}`;

/** How long work may go without a word before it is taken to have stopped: a Durable Object that went away records nothing. */
export const STALLED_MS = 20 * 60 * 1000;

const STALLED_TRANSCRIPTION = '文字起こしが途中で止まりました。もう一度文字起こしできます。';
const STALLED_MINUTES = '議事録づくりが途中で止まりました。もう一度作れます。';

/** The longest title a transcript is renamed to. */
const TITLE_LENGTH = 120;

/** The longest instructions minutes are asked to be written with. */
const INSTRUCTIONS_LENGTH = 2000;

const stalled = (row: Row, at: Date): boolean => at.getTime() - Date.parse(row.updatedAt) > STALLED_MS;

const linesOf = (stored: string): TranscriptLine[] => {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((line): line is TranscriptLine => typeof line === 'object' && line !== null && typeof (line as TranscriptLine).text === 'string') : [];
  } catch {
    return [];
  }
};

export const summaryOf = (row: Row, at: Date = new Date()): TranscriptSummary => {
  const stoppedTranscribing = row.state === 'transcribing' && stalled(row, at);
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    mediaType: row.mediaType,
    size: row.size,
    state: stoppedTranscribing ? 'failed' : row.state,
    error: stoppedTranscribing ? STALLED_TRANSCRIPTION : row.error,
    durationSeconds: row.durationSeconds,
    model: row.model,
    speakers: row.speakers,
    minutesState: row.minutesState === 'writing' && stalled(row, at) ? 'failed' : row.minutesState,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const detailOf = (row: Row, at: Date = new Date()): TranscriptDetail => {
  const summary = summaryOf(row, at);
  const stoppedWriting = row.minutesState === 'writing' && summary.minutesState === 'failed';
  return {
    ...summary,
    lines: linesOf(row.lines),
    minutes: row.minutes,
    minutesError: stoppedWriting ? STALLED_MINUTES : row.minutesError,
    minutesModel: row.minutesModel,
    minutesInstructions: row.minutesInstructions,
  };
};

const rowOf = async (db: AccountDatabase, id: string): Promise<Row> => {
  const row = await db.select().from(transcripts).where(eq(transcripts.id, id)).get();
  if (!row) throw notFound('文字起こしが見つかりません。');
  return row;
};

export const listTranscripts = async (db: AccountDatabase): Promise<TranscriptSummary[]> => {
  const at = new Date();
  return (await db.select().from(transcripts).orderBy(desc(transcripts.createdAt)).all()).map((row) => summaryOf(row, at));
};

export const readTranscript = async (db: AccountDatabase, id: string): Promise<TranscriptDetail> => detailOf(await rowOf(db, id));

/** A recording as it was uploaded, before it is kept. */
export interface Upload {
  filename: string;
  bytes: Uint8Array;
}

/**
 * The kind of recording an upload is, read from its bytes whatever its name
 * or the type the browser gave it, or the refusal that says why it is none or
 * too large.
 */
export const recordingOf = (upload: Upload): RecordingType => {
  const kind = recordingType(upload.bytes);
  if (!kind) throw invalid(unsupportedRecordingText(upload.filename));
  if (upload.bytes.byteLength > RECORDING_BYTES) throw invalid(oversizedRecordingText(upload.filename));
  return kind;
};

/**
 * Keeps an uploaded recording and records it as being transcribed. It is
 * refused before anything is kept while nothing could transcribe it.
 */
export const createTranscript = async (input: {
  db: AccountDatabase;
  bucket: R2Bucket;
  key: CryptoKey;
  accountId: string;
  upload: Upload;
  createdBy: string;
}): Promise<TranscriptSummary> => {
  const filename = input.upload.filename.trim();
  if (!filename) throw invalid('録音を読み取れませんでした。');
  const mediaType = recordingOf(input.upload);
  const connection = await readTranscriptionConnection(input.db, input.key, input.accountId);
  if (!connection) throw conflict(TRANSCRIPTION_MISSING);
  const id = crypto.randomUUID();
  const objectKey = recordingKey(input.accountId, id);
  await input.bucket.put(objectKey, input.upload.bytes, { httpMetadata: { contentType: mediaType } });
  const timestamp = now();
  const row: Row = {
    id, title: filename.slice(0, TITLE_LENGTH), filename, mediaType, size: input.upload.bytes.byteLength, objectKey,
    state: 'transcribing', error: null, model: connection.model, durationSeconds: null, speakers: null, lines: '[]',
    minutesState: null, minutes: null, minutesError: null, minutesModel: null, minutesInstructions: '',
    createdBy: input.createdBy, createdAt: timestamp, updatedAt: timestamp,
  };
  await input.db.insert(transcripts).values(row).run();
  return summaryOf(row);
};

/** Marks a recording to be transcribed again, refused while it is being transcribed now. */
export const restartTranscription = async (input: { db: AccountDatabase; key: CryptoKey; accountId: string; id: string }): Promise<TranscriptSummary> => {
  const row = await rowOf(input.db, input.id);
  if (summaryOf(row).state === 'transcribing') throw conflict('いま文字起こししています。終わるまで待ってください。');
  const connection = await readTranscriptionConnection(input.db, input.key, input.accountId);
  if (!connection) throw conflict(TRANSCRIPTION_MISSING);
  const next: Row = { ...row, state: 'transcribing', error: null, model: connection.model, updatedAt: now() };
  await input.db.update(transcripts).set({ state: next.state, error: null, model: next.model, updatedAt: next.updatedAt }).where(eq(transcripts.id, row.id)).run();
  return summaryOf(next);
};

/** Marks a transcript's minutes to be written, with what the person asked, refused until there is a transcript and an AI Connection. */
export const requestMinutes = async (input: { env: Bindings; database: D1Database; accountId: string; id: string; instructions: string }): Promise<TranscriptDetail> => {
  const db = accountDatabase(input.database);
  const row = await rowOf(db, input.id);
  const current = detailOf(row);
  if (current.state !== 'completed') throw conflict('文字起こしが終わってから議事録を作れます。');
  if (current.minutesState === 'writing') throw conflict('いま議事録を作っています。終わるまで待ってください。');
  if (!current.lines.length) throw conflict('文字起こしに言葉がないため、議事録を作れません。');
  const connection = await aiConnection(input.env, input.accountId, input.database);
  if (!connection) throw conflict(MINUTES_MISSING);
  const instructions = input.instructions.trim();
  if (instructions.length > INSTRUCTIONS_LENGTH) throw invalid(`議事録への指示は ${INSTRUCTIONS_LENGTH} 文字までです。`);
  const updatedAt = now();
  await db.update(transcripts).set({ minutesState: 'writing', minutesError: null, minutesModel: connection.model, minutesInstructions: instructions, updatedAt })
    .where(eq(transcripts.id, row.id)).run();
  return detailOf({ ...row, minutesState: 'writing', minutesError: null, minutesModel: connection.model, minutesInstructions: instructions, updatedAt });
};

export const renameTranscript = async (db: AccountDatabase, id: string, title: string): Promise<TranscriptSummary> => {
  const named = title.trim();
  if (!named) throw invalid('名前を入力してください。');
  if (named.length > TITLE_LENGTH) throw invalid(`名前は ${TITLE_LENGTH} 文字までです。`);
  const row = await rowOf(db, id);
  await db.update(transcripts).set({ title: named }).where(eq(transcripts.id, id)).run();
  return summaryOf({ ...row, title: named });
};

/** Removes a transcript, its minutes, and the recording: the row first, since bytes no row points at are unreadable. */
export const removeTranscript = async (input: { db: AccountDatabase; bucket: R2Bucket; id: string }): Promise<void> => {
  const row = await rowOf(input.db, input.id);
  await input.db.delete(transcripts).where(eq(transcripts.id, row.id)).run();
  await input.bucket.delete(row.objectKey);
};

export const readRecording = async (input: { db: AccountDatabase; bucket: R2Bucket; id: string }): Promise<{ filename: string; mediaType: string; body: ReadableStream; size: number }> => {
  const row = await rowOf(input.db, input.id);
  const object = await input.bucket.get(row.objectKey);
  if (!object) throw notFound('録音が見つかりません。');
  return { filename: row.filename, mediaType: row.mediaType, body: object.body, size: object.size };
};

/** The work a Durable Object carries on after the route that started it has answered. */
export interface TranscriptWork {
  kind: 'transcribe' | 'minutes';
  accountId: string;
  transcriptId: string;
}

/** The recording one instance of the Transcriber Workflow transcribes (transcriber.ts). */
export interface Transcription {
  accountId: string;
  transcriptId: string;
}

/** The instance one start of a transcription runs as; a transcription started again is a new one. */
export const transcriptionInstance = (transcriptId: string, startedAt: number): string => `transcript-${transcriptId}-${startedAt}`;

const failureOf = (error: unknown): string => error instanceof Error && error.message ? error.message : '理由が分からないまま失敗しました。';

/** Records why a recording could not be transcribed; a transcript deleted meanwhile has nothing to record on. */
export const recordTranscriptionFailure = async (database: D1Database, id: string, error: unknown): Promise<void> => {
  await accountDatabase(database).update(transcripts).set({ state: 'failed', error: failureOf(error), updatedAt: now() }).where(eq(transcripts.id, id)).run();
};

/**
 * Tries once to transcribe the recording and records the transcript. A
 * failure no other try can mend — no Transcription Connection, a file that is
 * not a recording, a recording gone — is recorded as the transcript's and
 * ends the work; a failure of the transcription itself is thrown, so the
 * caller decides whether to try again. A transcript deleted meanwhile ends
 * the work with nothing recorded. Each try first marks the transcript as
 * worked on now, so one tried again is never shown as stopped.
 */
export const transcribeOnce = async (input: { env: Bindings; providers: Providers; database: D1Database; accountId: string; id: string }): Promise<void> => {
  const db = accountDatabase(input.database);
  const row = await db.select().from(transcripts).where(eq(transcripts.id, input.id)).get();
  if (!row) return;
  await db.update(transcripts).set({ updatedAt: now() }).where(eq(transcripts.id, row.id)).run();
  let request: { apiKey: string; model: string; bytes: Uint8Array };
  try {
    const connection = await readTranscriptionConnection(db, await accountKeyFor(input.env, input.accountId), input.accountId);
    if (!connection) throw conflict(TRANSCRIPTION_MISSING);
    if (!isRecordingType(row.mediaType)) throw invalid(unsupportedRecordingText(row.filename));
    const object = await input.env.RECOVERY_RECEIPTS.get(row.objectKey);
    if (!object) throw notFound('録音が見つかりません。');
    request = { apiKey: connection.apiKey, model: connection.model, bytes: new Uint8Array(await object.arrayBuffer()) };
  } catch (error) {
    await recordTranscriptionFailure(input.database, row.id, error);
    return;
  }
  const response = await input.providers.transcription.transcribe({ ...request, mediaType: row.mediaType });
  const { lines, speakers } = transcriptLines(response);
  await db.update(transcripts).set({
    state: 'completed', error: null, model: request.model, lines: JSON.stringify(lines), speakers, durationSeconds: durationOf(response), updatedAt: now(),
  }).where(eq(transcripts.id, row.id)).run();
};

/** Transcribes the recording once and records the transcript, or why it could not be made. */
const transcribe = async (input: { env: Bindings; providers: Providers; database: D1Database; accountId: string; id: string }): Promise<void> => {
  try {
    await transcribeOnce(input);
  } catch (error) {
    await recordTranscriptionFailure(input.database, input.id, error);
  }
};

/**
 * What the model writing minutes is told. The transcript names speakers by
 * voice alone, so it is told never to name one unless what is said shows who
 * they are, and to write only what was said.
 */
export const MINUTES_INSTRUCTIONS = [
  'You write the minutes of a meeting from the transcript of its recording. Write them in Japanese, as Markdown, and answer with the minutes alone.',
  'Use these sections, leaving out one the transcript gives nothing for: ## 概要 (what the meeting was for, and its date, place, and attendees only where the transcript says them), ## 議題と議論 (one ### heading per topic, with its main points and who raised them), ## 決定事項, ## 宿題・次のアクション (each with who takes it on and by when, where said), ## 次回.',
  'Speakers are labelled 話者1, 話者2, and on: they were told apart by voice and not identified, and one person may appear under two labels. Keep the labels; give a name only where what is said shows who the speaker is, and mark it as inferred, as in 話者2（山田さんと思われる）.',
  'Write only what the transcript supports. Where something is unclear or was misheard, say so rather than guess. The times in the transcript are how far into the recording each line was said, not the time of day.',
].join('\n');

const minutesRequest = (row: Row): string => [
  `Recording: ${row.filename}`,
  ...(row.minutesInstructions ? [`How the person asked the minutes to be written, which comes before the sections above where they differ: ${row.minutesInstructions}`] : []),
  '',
  'Transcript:',
  transcriptPlainText(linesOf(row.lines)),
].join('\n');

/** Writes the minutes with the AI Connection and records them, or why they could not be written. */
const writeMinutes = async (input: { env: Bindings; providers: Providers; database: D1Database; accountId: string; id: string }): Promise<void> => {
  const db = accountDatabase(input.database);
  const row = await rowOf(db, input.id);
  try {
    const connection = await aiConnection(input.env, input.accountId, input.database);
    if (!connection) throw conflict(MINUTES_MISSING);
    const completion = await input.providers.ai.completeTurn({
      apiKey: connection.apiKey, baseUrl: connection.baseUrl, model: connection.model, tools: [],
      messages: [{ role: 'system', content: MINUTES_INSTRUCTIONS }, { role: 'user', content: minutesRequest(row) }],
    });
    const minutes = completion.content.trim();
    if (!minutes) throw new Error('AI が議事録を返しませんでした。');
    await db.update(transcripts).set({ minutesState: 'completed', minutes, minutesError: null, minutesModel: completion.model || connection.model, updatedAt: now() })
      .where(eq(transcripts.id, row.id)).run();
  } catch (error) {
    await db.update(transcripts).set({ minutesState: 'failed', minutesError: failureOf(error), updatedAt: now() }).where(eq(transcripts.id, row.id)).run();
  }
};

/** Carries on one piece of work to its end; it never throws, since what came of it is recorded on the row. */
export const performTranscriptWork = async (input: { env: Bindings; providers: Providers; database: D1Database; work: TranscriptWork }): Promise<void> => {
  const { work } = input;
  const run = work.kind === 'transcribe' ? transcribe : writeMinutes;
  try {
    await run({ env: input.env, providers: input.providers, database: input.database, accountId: work.accountId, id: work.transcriptId });
  } catch (error) {
    // The row itself could not be read, as when it was deleted meanwhile; there is nothing to record on.
    console.error(JSON.stringify({ event: 'transcript_work_failed', kind: work.kind, transcriptId: work.transcriptId, message: failureOf(error) }));
  }
};
