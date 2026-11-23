/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { TRANSCRIPTION_MISSING } from '@mail/domain';

import { removeTranscriptionConnection } from './transcription';
import { transcriptionInstance } from './transcripts';
import { accountDatabase } from './storage/database';
import { ACCOUNT, seedAccount, seedTranscript, TRANSCRIPTIONS_URL } from '../test/runtime';

const transcriber = env.TRANSCRIBER!;

/** A diarized transcript as OpenRouter answers one. */
const transcribed = (): Response => Response.json({
  text: '開会します。',
  duration: 3,
  words: [{ word: '開会', start: 0, end: 1, speaker: 0 }, { word: 'します。', start: 1, end: 2, speaker: 0 }],
});

/** Serves OpenRouter at the global `fetch` the Worker reads at every call: each request gets the next answer. */
const openRouter = (...answers: Array<() => Response>): { asked: number } => {
  const seen = { asked: 0 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== TRANSCRIPTIONS_URL) return new Response(null, { status: 404 });
    seen.asked += 1;
    const answer = answers.shift();
    if (!answer) throw new Error('OpenRouter was asked more often than the test said it would be.');
    return answer();
  });
  return seen;
};

const refused = (): Response => Response.json({ error: { message: 'Provider returned error' } }, { status: 502 });

const rowOf = (database: D1Database, id: string) =>
  database.prepare('SELECT state, error, lines FROM transcripts WHERE id = ?').bind(id).first<{ state: string; error: string | null; lines: string }>();

/** Starts the Workflow on one transcript, as the route does, with its waits between tries taken out. */
const start = async (id: string) => {
  const instanceId = transcriptionInstance(id, Date.now());
  const instance = await introspectWorkflowInstance(transcriber, instanceId);
  await instance.modify(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  await transcriber.create({ id: instanceId, params: { accountId: ACCOUNT, transcriptId: id } });
  return instance;
};

describe('the Workflow that transcribes a recording', () => {
  it('tries again when the transcription fails, and records the transcript the next try makes', async () => {
    const database = await seedAccount();
    const id = await seedTranscript(database);
    const seen = openRouter(refused, transcribed);

    await using instance = await start(id);
    await instance.waitForStatus('complete');

    expect(seen.asked).toBe(2);
    const row = await rowOf(database, id);
    expect(row).toMatchObject({ state: 'completed', error: null });
    expect(JSON.parse(row!.lines)).toEqual([{ at: 0, speaker: '話者1', text: '開会します。' }]);
  });

  it('records why it could not transcribe after the third try fails', async () => {
    const database = await seedAccount();
    const id = await seedTranscript(database);
    const seen = openRouter(refused, refused, refused);

    await using instance = await start(id);
    await instance.waitForStatus('complete');

    expect(seen.asked).toBe(3);
    expect(await rowOf(database, id)).toMatchObject({ state: 'failed', error: expect.stringContaining('Provider returned error') });
  });

  it('tries no more when no try could mend the failure, as when the Transcription Connection was removed', async () => {
    const database = await seedAccount();
    const id = await seedTranscript(database);
    await removeTranscriptionConnection(accountDatabase(database));
    const seen = openRouter();

    await using instance = await start(id);
    await instance.waitForStatus('complete');

    expect(seen.asked).toBe(0);
    expect(await rowOf(database, id)).toMatchObject({ state: 'failed', error: TRANSCRIPTION_MISSING });
  });
});
