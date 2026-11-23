import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptDetail, TranscriptList, TranscriptSummary } from '@mail/domain';

import { app } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { MINUTES_INSTRUCTIONS } from './transcripts';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture?.close();
  fixture = undefined;
});

const ACCOUNT = '/api/organizations/organization-1';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);

/** Calls the Worker and waits for the work it carries on after answering, as the Durable Object would. */
const call = async (app_: TestApp, request: Request): Promise<Response> => {
  const tasks: Array<Promise<unknown>> = [];
  const context = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); }, passThroughOnException: () => undefined, props: {} };
  const response = await app.fetch(request, app_.environment, context as unknown as ExecutionContext);
  await Promise.all(tasks);
  return response;
};

const data = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

const upload = (app_: TestApp, filename: string, bytes: Uint8Array<ArrayBuffer>, type = 'audio/mpeg'): Promise<Response> => {
  const form = new FormData();
  form.set('recording', new File([bytes], filename, { type }));
  return call(app_, app_.request(`${ACCOUNT}/transcripts`, { method: 'POST', body: form }));
};

const connectTranscription = (app_: TestApp, body: Record<string, unknown> = { apiKey: 'sk-or-key' }): Promise<Response> =>
  call(app_, app_.jsonRequest(`${ACCOUNT}/connections/transcription`, body, 'PUT'));

const connectAi = async (app_: TestApp): Promise<void> => {
  const response = await call(app_, app_.jsonRequest(`${ACCOUNT}/connections/ai`, { apiKey: 'ai-key', provider: 'openrouter', model: 'test-model' }, 'PUT'));
  expect(response.status).toBe(200);
};

const detail = async (app_: TestApp, id: string): Promise<TranscriptDetail> =>
  data<TranscriptDetail>(await call(app_, app_.request(`${ACCOUNT}/transcripts/${id}`)));

/** Answers OpenRouter with a diarized transcript, or with `refusal`, and the AI endpoint with `minutes`, recording what each was sent. */
const stub = (input: { minutes?: string; refusal?: { status: number; message: string } } = {}) => {
  const sent = { transcriptions: [] as Array<Record<string, unknown>>, models: [] as Array<{ messages: Array<{ role: string; content: unknown }> }> };
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // OpenRouter's model list, which says how much the model reads.
    if (String(url).endsWith('/models')) return Response.json({ data: [] });
    // The AI Connection is on OpenRouter too, so only its Chat Completions are the model's.
    if (String(url).startsWith('https://openrouter.ai/') && !String(url).endsWith('/chat/completions')) {
      sent.transcriptions.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>);
      if (input.refusal) return Response.json({ error: { message: input.refusal.message } }, { status: input.refusal.status });
      return Response.json({
        text: '開会します。賛成です。',
        duration: 12.5,
        words: [
          { word: '開会', start: 0.5, end: 1, speaker: 0 },
          { word: 'します。', start: 1, end: 1.4, speaker: 0 },
          { word: '賛成', start: 2, end: 2.5, speaker: 1 },
          { word: 'です。', start: 2.5, end: 2.8, speaker: 1 },
        ],
      });
    }
    sent.models.push(JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: unknown }> });
    // The model streams its answer, as every provider does for Pi.
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(`${chunk({ role: 'assistant', content: input.minutes ?? '' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return sent;
};

describe('Transcription Connection', () => {
  it('keeps the OpenRouter key apart from the AI Connection, showing only that it is kept and the model', async () => {
    fixture = await createAutomationTestApp();
    expect((await connectTranscription(fixture, {})).status).toBe(400);
    expect((await connectTranscription(fixture, { apiKey: 'sk-or-key', model: 'mai-transcribe-2' })).status).toBe(400);

    await expect(data(await connectTranscription(fixture))).resolves.toEqual({ apiKeyConfigured: true, model: 'microsoft/mai-transcribe-2' });
    await expect(data(await connectTranscription(fixture, { model: 'x-ai/grok-stt-1.0' }))).resolves.toEqual({ apiKeyConfigured: true, model: 'x-ai/grok-stt-1.0' });
    const connections = await call(fixture, fixture.request(`${ACCOUNT}/connections`));
    const body = await connections.json() as { data: Record<string, unknown> };
    expect(body.data.transcription).toEqual({ apiKeyConfigured: true, model: 'x-ai/grok-stt-1.0' });
    expect(JSON.stringify(body)).not.toContain('sk-or-key');
    expect(JSON.stringify(fixture.account.rows('SELECT value FROM settings'))).not.toContain('sk-or-key');

    const removed = await call(fixture, fixture.request(`${ACCOUNT}/connections/transcription`, { method: 'DELETE' }));
    await expect(data(removed)).resolves.toEqual({ apiKeyConfigured: false, model: '' });
  });
});

describe('文字起こし', () => {
  it('refuses a recording before keeping it while nothing would transcribe it, and anything that is no recording', async () => {
    const kept = await createAutomationTestApp();
    fixture = kept;
    stub();

    const unconnected = await upload(fixture, '総会.mp3', MP3);
    expect(unconnected.status).toBe(409);
    await connectTranscription(fixture);
    const photo = await upload(fixture, '総会.m4a', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), 'audio/mp4');
    expect(photo.status).toBe(400);
    const empty = await call(fixture, fixture.request(`${ACCOUNT}/transcripts`, { method: 'POST', body: new FormData() }));
    expect(empty.status).toBe(400);

    expect(fixture.account.rows('SELECT id FROM transcripts')).toEqual([]);
    expect(kept.transcriptR2.keys().filter((key) => key.startsWith('transcripts/'))).toEqual([]);
    await expect(data<TranscriptList>(await call(fixture, fixture.request(`${ACCOUNT}/transcripts`)))).resolves.toEqual({ transcripts: [], transcription: true, minutes: false });
  });

  it('transcribes an uploaded recording speaker by speaker, plays it back, and writes minutes from it when asked', async () => {
    const kept = await createAutomationTestApp();
    fixture = kept;
    await connectTranscription(fixture);
    const sent = stub({ minutes: '## 決定事項\n- 開会した（話者2 が賛成）' });

    const uploaded = await upload(fixture, '総会.mp3', MP3, 'application/octet-stream');
    expect(uploaded.status).toBe(201);
    const summary = await data<TranscriptSummary>(uploaded);
    expect(summary).toMatchObject({ title: '総会.mp3', mediaType: 'audio/mpeg', size: MP3.length, state: 'transcribing', model: 'microsoft/mai-transcribe-2' });
    expect(sent.transcriptions).toEqual([{
      model: 'microsoft/mai-transcribe-2', diarize: true, response_format: 'verbose_json',
      input_audio: { format: 'mp3', data: Buffer.from(MP3).toString('base64') },
    }]);

    const transcribed = await detail(fixture, summary.id);
    expect(transcribed).toMatchObject({ state: 'completed', error: null, speakers: 2, durationSeconds: 12.5, minutesState: null, minutes: null });
    expect(transcribed.lines).toEqual([
      { at: 0.5, speaker: '話者1', text: '開会します。' },
      { at: 2, speaker: '話者2', text: '賛成です。' },
    ]);

    const recording = await call(fixture, fixture.request(`${ACCOUNT}/transcripts/${summary.id}/recording`));
    expect(recording.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(new Uint8Array(await recording.arrayBuffer())).toEqual(MP3);

    const unconnected = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/minutes`, {}, 'POST'));
    expect(unconnected.status).toBe(409);
    await connectAi(fixture);
    const asked = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/minutes`, { instructions: '箇条書きで短く' }, 'POST'));
    await expect(data<TranscriptDetail>(asked)).resolves.toMatchObject({ minutesState: 'writing', minutesInstructions: '箇条書きで短く' });

    expect(sent.models[0]?.messages).toEqual([
      { role: 'system', content: MINUTES_INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: expect.stringContaining('箇条書きで短く') }] },
    ]);
    expect(JSON.stringify(sent.models[0]?.messages[1]?.content)).toContain('Transcript:\\n[0:00:00] 話者1: 開会します。\\n[0:00:02] 話者2: 賛成です。');
    await expect(detail(fixture, summary.id)).resolves.toMatchObject({ minutesState: 'completed', minutes: '## 決定事項\n- 開会した（話者2 が賛成）', minutesModel: 'test-model', minutesError: null });

    const renamed = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}`, { title: '10月の総会' }, 'PATCH'));
    await expect(data(renamed)).resolves.toMatchObject({ title: '10月の総会' });
    await expect(data<TranscriptList>(await call(fixture, fixture.request(`${ACCOUNT}/transcripts`)))).resolves.toMatchObject({
      transcripts: [{ id: summary.id, title: '10月の総会', state: 'completed', minutesState: 'completed' }], transcription: true, minutes: true,
    });

    const removed = await call(fixture, fixture.request(`${ACCOUNT}/transcripts/${summary.id}`, { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(fixture.account.rows('SELECT id FROM transcripts')).toEqual([]);
    expect(kept.transcriptR2.keys().filter((key) => key.startsWith('transcripts/'))).toEqual([]);
  });

  it('records why OpenRouter refused, and transcribes it again when asked', async () => {
    fixture = await createAutomationTestApp();
    await connectTranscription(fixture);
    stub({ refusal: { status: 402, message: 'Insufficient credits' } });

    const summary = await data<TranscriptSummary>(await upload(fixture, '総会.mp3', MP3));

    await expect(detail(fixture, summary.id)).resolves.toMatchObject({
      state: 'failed', error: 'OpenRouter が文字起こしできませんでした（microsoft/mai-transcribe-2）: Insufficient credits', lines: [],
    });
    const early = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/minutes`, {}, 'POST'));
    expect(early.status).toBe(409);

    stub();
    const again = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/transcribe`, {}, 'POST'));
    expect(again.status).toBe(200);
    await expect(detail(fixture, summary.id)).resolves.toMatchObject({ state: 'completed', error: null, speakers: 2 });
  });

  it('shows work that went quiet long ago as stopped, so it can be started again', async () => {
    fixture = await createAutomationTestApp();
    await connectTranscription(fixture);
    // A transcription whose Durable Object went away before it recorded anything.
    vi.stubGlobal('fetch', async (): Promise<Response> => new Promise<Response>(() => undefined));
    const form = new FormData();
    form.set('recording', new File([MP3], '総会.mp3', { type: 'audio/mpeg' }));
    const response = await app.fetch(fixture.request(`${ACCOUNT}/transcripts`, { method: 'POST', body: form }), fixture.environment, {
      waitUntil: () => undefined, passThroughOnException: () => undefined, props: {},
    } as unknown as ExecutionContext);
    const summary = await data<TranscriptSummary>(response);

    const busy = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/transcribe`, {}, 'POST'));
    expect(busy.status).toBe(409);
    fixture.account.execute('UPDATE transcripts SET updated_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', summary.id);

    await expect(detail(fixture, summary.id)).resolves.toMatchObject({ state: 'failed', error: '文字起こしが途中で止まりました。もう一度文字起こしできます。' });
    stub();
    const again = await call(fixture, fixture.jsonRequest(`${ACCOUNT}/transcripts/${summary.id}/transcribe`, {}, 'POST'));
    expect(again.status).toBe(200);
    await expect(detail(fixture, summary.id)).resolves.toMatchObject({ state: 'completed' });
  });
});
