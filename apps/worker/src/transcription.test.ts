import { describe, expect, it } from 'vitest';

import { durationOf, joinedWords, openRouterTranscription, transcriptLines, transcriptionBody } from './transcription';

const decoded = (body: Uint8Array): { model: string; diarize?: boolean; response_format?: string; input_audio: { format: string; data: string } } =>
  JSON.parse(new TextDecoder().decode(body)) as { model: string; input_audio: { format: string; data: string } };

describe('the request a recording is sent in', () => {
  it('writes the recording as one base64 string inside the JSON body, whatever its length', () => {
    for (const length of [0, 1, 2, 3, 3 * 0x2000 - 1, 3 * 0x2000, 3 * 0x2000 + 1, 70_001]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);
      const body = decoded(transcriptionBody({ model: 'microsoft/mai-transcribe-2', diarize: true }, 'audio/mpeg', bytes));
      expect(body.model).toBe('microsoft/mai-transcribe-2');
      expect(body.diarize).toBe(true);
      expect(body.input_audio.format).toBe('mp3');
      expect(body.input_audio.data).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('names each recording by the format OpenRouter takes it in', () => {
    expect(decoded(transcriptionBody({}, 'audio/mp4', new Uint8Array([1]))).input_audio.format).toBe('m4a');
    expect(decoded(transcriptionBody({}, 'audio/wav', new Uint8Array([1]))).input_audio.format).toBe('wav');
  });
});

describe('OpenRouter speech-to-text', () => {
  it('asks it to tell the speakers apart, in the verbose format that carries their labels', async () => {
    const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = openRouterTranscription(async (url, init) => {
      sent.push({ url, init });
      return Response.json({ text: 'こんにちは', words: [] });
    });

    await expect(provider.transcribe({ apiKey: 'sk-or-key', model: 'microsoft/mai-transcribe-2', mediaType: 'audio/mp4', bytes: new Uint8Array([1, 2, 3]) }))
      .resolves.toEqual({ text: 'こんにちは', words: [] });

    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(new Headers(sent[0]?.init?.headers).get('Authorization')).toBe('Bearer sk-or-key');
    expect(decoded(sent[0]?.init?.body as Uint8Array)).toEqual({
      model: 'microsoft/mai-transcribe-2', diarize: true, response_format: 'verbose_json', input_audio: { format: 'm4a', data: 'AQID' },
    });
  });

  it('says why OpenRouter refused, in its own words and with the model asked', async () => {
    const provider = openRouterTranscription(async () => Response.json({ error: { message: 'Model cannot diarize' } }, { status: 400 }));
    await expect(provider.transcribe({ apiKey: 'k', model: 'openai/whisper-1', mediaType: 'audio/mpeg', bytes: new Uint8Array([1]) }))
      .rejects.toThrow('OpenRouter が文字起こしできませんでした（openai/whisper-1）: Model cannot diarize');
  });
});

describe('a transcript, speaker by speaker', () => {
  it('joins Japanese words with nothing between them, and other words with a space', () => {
    expect(joinedWords(['今日', 'は', '総会', 'です', '。'])).toBe('今日は総会です。');
    expect(joinedWords(['Hello', ',', 'world', '.', 'Next', 'item'])).toBe('Hello, world. Next item');
    expect(joinedWords(['議題', 'は', 'FlareChat', 'の', '導入'])).toBe('議題はFlareChatの導入');
  });

  it('makes one line per change of speaker from words labelled by index, naming them in the order they first speak', () => {
    expect(transcriptLines({
      text: '',
      words: [
        { word: '始め', start: 1.2, end: 1.5, speaker: 3 },
        { word: 'ます', start: 1.5, end: 1.8, speaker: 3 },
        { word: 'はい', start: 2.0, end: 2.3, speaker: 0 },
        { word: 'laughter', start: 2.4, end: 2.6, speaker: 0, type: 'audio_event' },
        { word: '次', start: 65, end: 65.4, speaker: 3 },
      ],
    })).toEqual({
      lines: [
        { at: 1.2, speaker: '話者1', text: '始めます' },
        { at: 2.0, speaker: '話者2', text: 'はい(laughter)' },
        { at: 65, speaker: '話者1', text: '次' },
      ],
      speakers: 2,
    });
  });

  it('prefers segments that carry speakers, labelled by name', () => {
    expect(transcriptLines({
      text: '',
      segments: [
        { text: '議事に入ります。', start: 0, end: 2, speaker_label: 'Guest-2' },
        { text: '一つ目は会計です。', start: 2, end: 4, speaker_label: 'Guest-2' },
        { text: '承知しました。', start: 4, end: 5, speaker_label: 'Guest-1' },
      ],
      words: [{ word: '議事', start: 0, end: 1 }],
    }).lines).toEqual([
      { at: 0, speaker: '話者1', text: '議事に入ります。一つ目は会計です。' },
      { at: 4, speaker: '話者2', text: '承知しました。' },
    ]);
  });

  it('keeps each segment its own line, and names no speaker, when the model told none apart', () => {
    expect(transcriptLines({ text: '', segments: [{ text: 'ひとつ', start: 0 }, { text: 'ふたつ', start: 3 }] }))
      .toEqual({ lines: [{ at: 0, speaker: null, text: 'ひとつ' }, { at: 3, speaker: null, text: 'ふたつ' }], speakers: null });
    expect(transcriptLines({ text: ' 全文だけ ' })).toEqual({ lines: [{ at: null, speaker: null, text: '全文だけ' }], speakers: null });
    expect(transcriptLines({ text: '' })).toEqual({ lines: [], speakers: null });
  });

  it('says how long the recording is, as the model reports it or as its last word ends', () => {
    expect(durationOf({ text: '', duration: 3600.5 })).toBe(3600.5);
    expect(durationOf({ text: '', words: [{ word: 'a', start: 0, end: 12.5 }, { word: 'b', start: 12.5, end: 13 }] })).toBe(13);
    expect(durationOf({ text: '' })).toBeNull();
  });
});
