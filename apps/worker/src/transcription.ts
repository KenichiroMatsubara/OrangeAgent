/**
 * A recording as OpenRouter transcribes it: the Account's Transcription
 * Connection, the one call that sends the recording, and the transcript it
 * answers with as lines of who said what, led by how far into the recording
 * it was said.
 *
 * The Connection is an OpenRouter key and model, kept apart from the AI
 * Connection, which may be any API. It is kept encrypted under the Account's
 * key in the Account's settings, as the Microsoft connection is, so it needs no
 * migration.
 */

import { eq } from 'drizzle-orm';

import { DEFAULT_TRANSCRIPTION_MODEL, RECORDING_FORMATS, type Connections, type RecordingType, type TranscriptLine } from '@mail/domain';

import { decrypt, encrypt, type CipherEnvelope } from './cryptography';
import type { Fetch } from './providers';
import { invalid, upstream } from './refusal';
import { settings } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

export const TRANSCRIPTION_SETTING = 'transcription_connection';

const TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

const credentialContext = (accountId: string): string => `transcription-connection:${accountId}`;

/** An Account's Transcription Connection as it is kept. */
export interface TranscriptionCredential {
  apiKey: string;
  model: string;
}

/** The Account's Transcription Connection, or null when none is saved. */
export const readTranscriptionConnection = async (db: AccountDatabase, key: CryptoKey, accountId: string): Promise<TranscriptionCredential | null> => {
  const stored = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, TRANSCRIPTION_SETTING)).get();
  if (!stored) return null;
  const credential = JSON.parse(await decrypt(JSON.parse(stored.value) as CipherEnvelope, key, credentialContext(accountId))) as Partial<TranscriptionCredential>;
  return credential.apiKey ? { apiKey: credential.apiKey, model: credential.model || DEFAULT_TRANSCRIPTION_MODEL } : null;
};

/** What the Connections screen shows of it: whether a key is kept, and the model named. Never the key. */
export const transcriptionView = (credential: TranscriptionCredential | null): Connections['transcription'] =>
  ({ apiKeyConfigured: credential !== null, model: credential?.model ?? '' });

/** OpenRouter names every model with its provider, so a model is only ever a full slug such as `microsoft/mai-transcribe-2`. */
const MODEL_SLUG = /^[\w.-]+\/[\w.:-]+$/u;

/**
 * Saves the Connection, keeping the key saved before when none is given, and
 * refuses a model OpenRouter could not name.
 */
export const saveTranscriptionConnection = async (input: {
  db: AccountDatabase;
  key: CryptoKey;
  accountId: string;
  apiKey?: string | undefined;
  model?: string | undefined;
}): Promise<TranscriptionCredential> => {
  const current = await readTranscriptionConnection(input.db, input.key, input.accountId);
  const apiKey = input.apiKey?.trim() || current?.apiKey || '';
  const model = input.model?.trim() || current?.model || DEFAULT_TRANSCRIPTION_MODEL;
  if (!apiKey) throw invalid('OpenRouter の API キーを入力してください。');
  if (model.length > 200 || !MODEL_SLUG.test(model)) throw invalid('model は OpenRouter のモデル名を「microsoft/mai-transcribe-2」のように提供元から書いてください。');
  const credential: TranscriptionCredential = { apiKey, model };
  const value = JSON.stringify(await encrypt(JSON.stringify(credential), input.key, credentialContext(input.accountId)));
  const updatedAt = new Date().toISOString();
  await input.db.insert(settings).values({ key: TRANSCRIPTION_SETTING, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
  return credential;
};

export const removeTranscriptionConnection = async (db: AccountDatabase): Promise<void> => {
  await db.delete(settings).where(eq(settings.key, TRANSCRIPTION_SETTING)).run();
};

/** One recording to transcribe, and the Connection it is sent through. */
export interface TranscriptionRequest {
  apiKey: string;
  model: string;
  mediaType: RecordingType;
  bytes: Uint8Array;
  signal?: AbortSignal | undefined;
}

/** A stretch of speech as OpenRouter reports it: a segment or a single word, each with its speaker when it tells them apart. */
interface Spoken {
  start?: number;
  end?: number;
  speaker?: number;
  speaker_label?: string;
}

export interface TranscriptionSegment extends Spoken {
  text: string;
}

export interface TranscriptionWord extends Spoken {
  word: string;
  /** `audio_event` for a sound that is not speech, such as laughter. */
  type?: string;
}

/** What OpenRouter answers a diarized request with: the whole text, and its segments or words when it has them. */
export interface TranscriptionResponse {
  text: string;
  duration?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
}

export interface TranscriptionProvider {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse>;
}

/**
 * The request body, written straight into one buffer: the recording is the
 * bulk of it, and base64 text a third larger than the file, so building it as
 * a string and encoding that again would hold the recording three times over.
 */
export const transcriptionBody = (fields: Record<string, unknown>, mediaType: RecordingType, bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const marker = '\u0000recording\u0000';
  const json = JSON.stringify({ ...fields, input_audio: { format: RECORDING_FORMATS[mediaType], data: marker } });
  const [before = '', after = ''] = json.split(JSON.stringify(marker));
  const encoder = new TextEncoder();
  const head = encoder.encode(`${before}"`);
  const tail = encoder.encode(`"${after}`);
  const length = Math.ceil(bytes.length / 3) * 4;
  const body = new Uint8Array(head.length + length + tail.length);
  body.set(head, 0);
  let offset = head.length;
  // A chunk of a length divisible by three encodes to base64 with no padding, so the chunks join into the one encoding of the whole.
  const CHUNK = 3 * 0x2000;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const encoded = btoa(String.fromCharCode(...bytes.subarray(start, start + CHUNK)));
    for (let index = 0; index < encoded.length; index += 1) body[offset + index] = encoded.charCodeAt(index);
    offset += encoded.length;
  }
  body.set(tail, offset);
  return body;
};

interface OpenRouterError {
  error?: { message?: string; metadata?: { raw?: unknown } };
}

const reasonOf = (body: OpenRouterError, status: number): string => {
  const raw = body.error?.metadata?.raw;
  const detail = typeof raw === 'string' ? raw : '';
  return [body.error?.message, detail].filter(Boolean).join(' ') || `HTTP ${status}`;
};

/**
 * OpenRouter's speech-to-text endpoint, asked to tell the speakers apart.
 * Speaker labels come back on its words or segments only in the verbose
 * format, which is why every request asks for it.
 */
export const openRouterTranscription = (fetcher: Fetch = (url, init) => fetch(url, init)): TranscriptionProvider => ({
  transcribe: async (request) => {
    const body = transcriptionBody({ model: request.model, diarize: true, response_format: 'verbose_json' }, request.mediaType, request.bytes);
    const response = await fetcher(TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const answer = await response.json().catch(() => ({})) as TranscriptionResponse & OpenRouterError;
    if (!response.ok) throw upstream(`OpenRouter が文字起こしできませんでした（${request.model}）: ${reasonOf(answer, response.status)}`);
    if (typeof answer.text !== 'string') throw upstream(`OpenRouter から文字起こしを受け取れませんでした（${request.model}）。`);
    return answer;
  },
});

const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
const CLOSING = /^[,.!?;:%)\]}'"’”]/u;

/**
 * Words joined as they are written: Japanese and Chinese with nothing between
 * them, other words with a space, and punctuation against the word before it.
 */
export const joinedWords = (pieces: readonly string[]): string => pieces.reduce((text, piece) => {
  const word = piece.trim();
  if (!word) return text;
  if (!text) return word;
  const spaced = !SPACELESS.test(text.at(-1) ?? '') && !SPACELESS.test(word[0] ?? '') && !CLOSING.test(word);
  return spaced ? `${text} ${word}` : `${text}${word}`;
}, '');

const speakerKey = (spoken: Spoken): string | null => {
  if (typeof spoken.speaker_label === 'string' && spoken.speaker_label.trim()) return `label:${spoken.speaker_label.trim()}`;
  if (typeof spoken.speaker === 'number' && Number.isFinite(spoken.speaker)) return `index:${spoken.speaker}`;
  return null;
};

const startOf = (spoken: Spoken): number | null => typeof spoken.start === 'number' && Number.isFinite(spoken.start) ? spoken.start : null;

/**
 * The transcript as one line per change of speaker. Each provider labels
 * speakers in its own way, by index or by name, on segments or on words, so
 * each label is renamed 話者1, 話者2, and on in the order they first speak. A
 * response with no speakers is its segments, one line each, or its whole text.
 */
export const transcriptLines = (response: TranscriptionResponse): { lines: TranscriptLine[]; speakers: number | null } => {
  const segments = response.segments ?? [];
  const words = (response.words ?? []).filter((word) => typeof word.word === 'string');
  const pieces: Array<{ spoken: Spoken; text: string }> = segments.some((segment) => speakerKey(segment) !== null)
    ? segments.map((segment) => ({ spoken: segment, text: segment.text }))
    : words.some((word) => speakerKey(word) !== null)
      ? words.map((word) => ({ spoken: word, text: word.type === 'audio_event' ? `(${word.word.replace(/^\(|\)$/gu, '')})` : word.word }))
      : segments.map((segment) => ({ spoken: segment, text: segment.text }));
  const diarized = pieces.some((piece) => speakerKey(piece.spoken) !== null);
  if (!pieces.length) return { lines: response.text.trim() ? [{ at: null, speaker: null, text: response.text.trim() }] : [], speakers: null };
  const names = new Map<string, string>();
  const nameOf = (key: string | null): string | null => {
    if (key === null) return null;
    if (!names.has(key)) names.set(key, `話者${names.size + 1}`);
    return names.get(key) ?? null;
  };
  const turns: Array<{ at: number | null; speaker: string | null; pieces: string[] }> = [];
  for (const piece of pieces) {
    const speaker = nameOf(speakerKey(piece.spoken));
    const last = turns.at(-1);
    // Without speakers each segment is a line of its own, with its own time.
    if (diarized && last && last.speaker === speaker) last.pieces.push(piece.text);
    else turns.push({ at: startOf(piece.spoken), speaker, pieces: [piece.text] });
  }
  const lines = turns
    .map((turn) => ({ at: turn.at, speaker: turn.speaker, text: joinedWords(turn.pieces) }))
    .filter((line) => line.text);
  return { lines, speakers: diarized ? names.size : null };
};

/** How long the recording is, as the model reports it or as its last word or segment ends. */
export const durationOf = (response: TranscriptionResponse): number | null => {
  if (typeof response.duration === 'number' && Number.isFinite(response.duration)) return response.duration;
  const ends = [...response.segments ?? [], ...response.words ?? []].map((spoken) => spoken.end).filter((end): end is number => typeof end === 'number' && Number.isFinite(end));
  return ends.length ? Math.max(...ends) : null;
};
