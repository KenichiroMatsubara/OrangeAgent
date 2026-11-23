import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, recording } from './fixtures';
import { renderScreen } from './render';
import * as transcript from './transcript';
import * as transcripts from './transcripts';

fakeApi();

const summaryOf = ({ lines: _lines, minutes: _minutes, minutesError: _error, minutesModel: _model, minutesInstructions: _instructions, ...summary }: ReturnType<typeof recording>) => summary;

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]);

describe('文字起こし screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.transcripts).mockResolvedValue({ transcripts: [summaryOf(recording())], transcription: true, minutes: true });
  });

  it('lists every recording with where it is, and opens one', async () => {
    renderScreen('transcripts', transcripts);

    const row = await screen.findByRole('link', { name: '10月の役員会.m4aを開く' });
    expect(within(row).getByText('文字起こし済み')).toBeTruthy();
    expect(within(row).getByText(/0:45:45 ・ 話者3人 ・ 山田 太郎/u)).toBeTruthy();
  });

  it('uploads a recording, whatever type the browser gave it, and opens its page', async () => {
    vi.mocked(api.uploadRecording).mockResolvedValue({ ...summaryOf(recording({ id: 'transcript-9' })), state: 'transcribing' });
    const user = userEvent.setup({ applyAccept: false });
    const { router } = renderScreen('transcripts', transcripts);
    await screen.findByRole('link', { name: '10月の役員会.m4aを開く' });

    await user.upload(screen.getByLabelText('文字起こしする録音'), new File([MP3], '総会.m4a', { type: 'audio/x-m4a' }));

    await waitFor(() => expect(api.uploadRecording).toHaveBeenCalledWith(ACCOUNT_ID, expect.any(File)));
    await waitFor(() => expect(router.state.location.pathname).toBe('/transcripts/transcript-9'));
  });

  it('refuses a file that is no recording before sending it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderScreen('transcripts', transcripts);
    await screen.findByRole('link', { name: '10月の役員会.m4aを開く' });

    await user.upload(screen.getByLabelText('文字起こしする録音'), new File(['PK'], '名簿.zip', { type: 'application/zip' }));

    expect(await screen.findByText(/名簿.zip は音声として読み取れませんでした/u)).toBeTruthy();
    expect(api.uploadRecording).not.toHaveBeenCalled();
  });

  it('says where to save the Transcription Connection, and uploads nothing until it is', async () => {
    vi.mocked(api.transcripts).mockResolvedValue({ transcripts: [], transcription: false, minutes: false });
    renderScreen('transcripts', transcripts);

    expect(await screen.findByText(/「接続」の「AI」で、文字起こし用の OpenRouter の API キーを登録してください/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: '接続を開く' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '録音をアップロード' })).toHaveProperty('disabled', true);
    expect(screen.getByText('録音はまだありません')).toBeTruthy();
  });
});

describe('one recording', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.transcripts).mockResolvedValue({ transcripts: [], transcription: true, minutes: true });
    vi.mocked(api.recordingUrl).mockReturnValue('/recording');
  });

  it('shows the transcript speaker by speaker, and writes minutes with what was asked', async () => {
    vi.mocked(api.transcript).mockResolvedValue(recording());
    vi.mocked(api.writeMinutes).mockResolvedValue(recording({ minutesState: 'writing', minutesModel: 'claude-sonnet-5-5', minutesInstructions: '箇条書きで' }));
    const user = userEvent.setup();
    renderScreen('transcripts/:transcriptId', transcript, '/transcripts/transcript-1');

    const lines = await screen.findByRole('list', { name: '文字起こし' });
    expect(within(lines).getAllByRole('listitem')).toHaveLength(5);
    expect(within(lines).getByRole('button', { name: '0:00:14 から再生' })).toBeTruthy();
    expect(within(lines).getAllByText('話者1')).toHaveLength(2);

    await user.type(await screen.findByLabelText('書き方の指示（任意）'), '箇条書きで');
    await user.click(screen.getByRole('button', { name: '議事録にする' }));

    await waitFor(() => expect(api.writeMinutes).toHaveBeenCalledWith(ACCOUNT_ID, 'transcript-1', { instructions: '箇条書きで' }));
    expect(await screen.findByText(/claude-sonnet-5-5 で議事録を作っています/u)).toBeTruthy();
  });

  it('shows the minutes written, offering them to copy, download, and write again', async () => {
    vi.mocked(api.transcript).mockResolvedValue(recording({ minutesState: 'completed', minutes: '## 決定事項\n- 各班2人ずつ出す', minutesModel: 'claude-sonnet-5-5' }));
    renderScreen('transcripts/:transcriptId', transcript, '/transcripts/transcript-1');

    expect(await screen.findByRole('heading', { name: '決定事項' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ダウンロード（.md）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ダウンロード（.txt）' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '議事録にする' })).toBeNull();
    expect(screen.getByRole('button', { name: '作り直す' })).toBeTruthy();
  });

  it('says where to save the AI Connection before minutes can be written', async () => {
    vi.mocked(api.transcript).mockResolvedValue(recording());
    vi.mocked(api.transcripts).mockResolvedValue({ transcripts: [], transcription: true, minutes: false });
    renderScreen('transcripts/:transcriptId', transcript, '/transcripts/transcript-1');

    expect(await screen.findByText(/「接続」の「AI」で AI 接続を登録してください/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '議事録にする' })).toBeNull();
  });

  it('says why a transcription failed, and starts it again', async () => {
    vi.mocked(api.transcript).mockResolvedValue(recording({ state: 'failed', error: 'OpenRouter が文字起こしできませんでした（m/x）: Insufficient credits', lines: [] }));
    vi.mocked(api.transcribeAgain).mockResolvedValue({ ...summaryOf(recording()), state: 'transcribing' });
    const user = userEvent.setup();
    renderScreen('transcripts/:transcriptId', transcript, '/transcripts/transcript-1');

    expect(await screen.findByText(/Insufficient credits/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'もう一度文字起こし' }));

    await waitFor(() => expect(api.transcribeAgain).toHaveBeenCalledWith(ACCOUNT_ID, 'transcript-1'));
    expect(await screen.findByText(/話者ごとに文字起こししています/u)).toBeTruthy();
  });

  it('asks once more before removing the recording, its transcript, and its minutes', async () => {
    vi.mocked(api.transcript).mockResolvedValue(recording());
    vi.mocked(api.removeTranscript).mockResolvedValue({ id: 'transcript-1', deleted: true });
    const user = userEvent.setup();
    const { router } = renderScreen('transcripts/:transcriptId', transcript, '/transcripts/transcript-1');

    await user.click(await screen.findByRole('button', { name: '削除' }));
    await user.click(screen.getByRole('button', { name: '録音・文字起こし・議事録を削除する' }));

    await waitFor(() => expect(api.removeTranscript).toHaveBeenCalledWith(ACCOUNT_ID, 'transcript-1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/transcripts'));
  });
});
