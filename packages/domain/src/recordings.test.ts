import { describe, expect, it } from 'vitest';

import { RECORDING_BYTES, elapsed, isRecordingType, oversizedRecordingText, recordingType, transcriptPlainText } from './recordings';

const bytes = (...values: Array<number | string>): Uint8Array =>
  new Uint8Array(values.flatMap((value) => typeof value === 'string' ? [...value].map((character) => character.charCodeAt(0)) : [value]));

describe('recordings', () => {
  it('names the recording a file holds by its first bytes, whatever it is called', () => {
    expect(recordingType(bytes('ID3', 4, 0, 0, 0, 0, 0, 0))).toBe('audio/mpeg');
    expect(recordingType(bytes(0xff, 0xfb, 0x90, 0x64))).toBe('audio/mpeg');
    expect(recordingType(bytes(0xff, 0xf1, 0x50, 0x80))).toBe('audio/aac');
    expect(recordingType(bytes(0, 0, 0, 0x20, 'ftypM4A '))).toBe('audio/mp4');
    expect(recordingType(bytes(0, 0, 0, 0x1c, 'ftypisom'))).toBe('audio/mp4');
    expect(recordingType(bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt '))).toBe('audio/wav');
    expect(recordingType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f))).toBe('audio/webm');
    expect(recordingType(bytes('OggS', 0))).toBe('audio/ogg');
    expect(recordingType(bytes('fLaC', 0))).toBe('audio/flac');
    expect(isRecordingType('audio/mp4')).toBe(true);
    expect(isRecordingType('audio/x-m4a')).toBe(false);
  });

  it('takes no photo kept in an MP4 container, no image, and no stray run of set bits, for a recording', () => {
    expect(recordingType(bytes(0, 0, 0, 0x18, 'ftypheic'))).toBeNull();
    expect(recordingType(bytes(0, 0, 0, 0x1c, 'ftypavif'))).toBeNull();
    expect(recordingType(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBeNull();
    expect(recordingType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(recordingType(bytes(0xff, 0xfe, 0xfd))).toBeNull();
    expect(recordingType(bytes(0xff, 0xfb, 0xf0, 0x00))).toBeNull();
    expect(recordingType(new Uint8Array())).toBeNull();
  });

  it('says how large a recording may be', () => {
    expect(oversizedRecordingText('総会.m4a')).toBe(`総会.m4a は大きすぎます。録音は ${RECORDING_BYTES / 1024 / 1024} MB までです。モノラル・64 kbps 程度の MP3 か M4A に書き出し直すか、分けてアップロードしてください。`);
  });

  it('writes a transcript as lines led by how far into the recording, h:mm:ss', () => {
    expect(elapsed(0)).toBe('0:00:00');
    expect(elapsed(59.9)).toBe('0:00:59');
    expect(elapsed(3600 + 61)).toBe('1:01:01');
    expect(transcriptPlainText([
      { at: 3725, speaker: '話者1', text: '開会します。' },
      { at: null, speaker: null, text: '（全文）' },
    ])).toBe('[1:02:05] 話者1: 開会します。\n（全文）');
  });
});
