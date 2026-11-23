/**
 * A recording uploaded on 文字起こし: the kinds accepted, how each is
 * recognised by its bytes, the largest one taken, and the words both the
 * Worker and the screen refuse one with.
 */

/** Each accepted recording, as the format OpenRouter is sent it in. */
export const RECORDING_FORMATS = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
} as const;

export type RecordingType = keyof typeof RECORDING_FORMATS;

export const isRecordingType = (type: string): type is RecordingType => Object.hasOwn(RECORDING_FORMATS, type);

/** What the file picker offers: each type, and each extension, since a browser often types an M4A as `audio/x-m4a` or not at all. */
export const RECORDING_PICKABLE = [...Object.keys(RECORDING_FORMATS), '.mp3', '.m4a', '.mp4', '.wav', '.webm', '.ogg', '.oga', '.flac', '.aac'].join(',');

/**
 * The largest recording taken: about 70 minutes at 64 kbps. It is sent to be
 * transcribed as base64 inside one JSON body, a third larger than the file,
 * and both are held in the Worker's memory at once.
 */
export const RECORDING_BYTES = 32 * 1024 * 1024;

/** The OpenRouter model a Transcription Connection names until another is chosen: it tells speakers apart and reads Japanese. */
export const DEFAULT_TRANSCRIPTION_MODEL = 'microsoft/mai-transcribe-2';

/** The sentence both the Worker and the screen give while no Transcription Connection is saved. */
export const TRANSCRIPTION_MISSING = '文字起こしするには、設定の「接続」の「AI」で、文字起こし用の OpenRouter の API キーを登録してください。';

/** The sentence both the Worker and the screen give while no AI Connection is saved to write minutes with. */
export const MINUTES_MISSING = '議事録を書くには、設定の「接続」の「AI」で AI 接続を登録してください。';

export const unsupportedRecordingText = (filename: string): string =>
  `${filename} は音声として読み取れませんでした。MP3・M4A（MP4）・WAV・WebM・Ogg・FLAC・AAC の録音を選んでください。`;

export const oversizedRecordingText = (filename: string): string =>
  `${filename} は大きすぎます。録音は ${RECORDING_BYTES / 1024 / 1024} MB までです。モノラル・64 kbps 程度の MP3 か M4A に書き出し直すか、分けてアップロードしてください。`;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** The brands an ISO media file carries when it is a still image, as a HEIC or AVIF photo is, rather than a recording. */
const IMAGE_BRANDS: readonly string[] = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis'];

const brandOf = (bytes: Uint8Array): string => String.fromCharCode(...bytes.subarray(8, 12));

/**
 * The recording a file's first bytes say it is, whatever its name or type,
 * or null. A frame of MPEG audio and one of AAC both begin with a run of set
 * bits; AAC's ADTS header alone has its two layer bits clear, and either is
 * taken only when the rest of its header holds no reserved value, so a stray
 * run of set bits at the start of some other file is not taken for one. An
 * MP4 file, as a phone's voice memo or a meeting's recording is, is sent as
 * M4A, the same container; a photo kept in that container is not one.
 */
export const recordingType = (bytes: Uint8Array): RecordingType | null => {
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WAVE'), 8)) return 'audio/wav';
  if (startsWith(bytes, ascii('ID3'))) return 'audio/mpeg';
  if (startsWith(bytes, ascii('ftyp'), 4)) return IMAGE_BRANDS.includes(brandOf(bytes)) ? null : 'audio/mp4';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm';
  if (startsWith(bytes, ascii('OggS'))) return 'audio/ogg';
  if (startsWith(bytes, ascii('fLaC'))) return 'audio/flac';
  if (bytes.length < 4 || bytes[0] !== 0xff) return null;
  const [second, third] = [bytes[1] ?? 0, bytes[2] ?? 0];
  // ADTS: a sampling frequency index of 13 or more is reserved.
  if ((second & 0xf6) === 0xf0) return ((third >> 2) & 0x0f) < 13 ? 'audio/aac' : null;
  // MPEG audio: a reserved version or layer, a bitrate index of all ones, or a reserved sample rate is no frame.
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const valid = (second & 0xe0) === 0xe0 && version !== 1 && layer !== 0 && (third >> 4) !== 0x0f && ((third >> 2) & 0x03) !== 0x03;
  return valid ? 'audio/mpeg' : null;
};

/** How far into a recording, as h:mm:ss. */
export const elapsed = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

/** One line of a transcript: how far into the recording, who spoke by voice, and what they said. */
export interface TranscriptLineText {
  at: number | null;
  speaker: string | null;
  text: string;
}

/** A transcript as plain text, one line per speaker's turn, as it is downloaded and as minutes are written from it. */
export const transcriptPlainText = (lines: readonly TranscriptLineText[]): string => lines
  .map((line) => `${line.at === null ? '' : `[${elapsed(line.at)}] `}${line.speaker ? `${line.speaker}: ` : ''}${line.text}`)
  .join('\n');
