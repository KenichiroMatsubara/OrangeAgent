import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID } from './fixtures';
import { renderScreen } from './render';
import * as settings from './settings';

fakeApi();

describe('Settings screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.driveFolders).mockResolvedValue({ folders: [] });
  });

  it('sets no reminder cadence of its own: reminders are an Automation\'s', async () => {
    renderScreen('settings', settings);

    expect(await screen.findByText(/AI は Drive 全体に触れます/u)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /リマインド/u })).toBeNull();
  });

  it('asks for no attachment folder: the AI chooses where a mail\'s files go, as the Skills say', async () => {
    renderScreen('settings', settings);

    expect(await screen.findByText(/置き場所はこの中から AI が選びます/u)).toBeTruthy();
    expect(screen.queryByLabelText('添付ファイルの保存先')).toBeNull();
    expect(screen.getByText(/置き場所はこの中から/u).querySelector('a')?.getAttribute('href')).toMatch(/\/skills$/u);
    expect(screen.queryByText(/返信を予定に結び付ける範囲/u)).toBeNull();
  });

  it('says AI reaches the whole Drive until a folder is added by its link, and lets one be taken off', async () => {
    const reikai = { id: 'folder-reikai', name: '2026-27 例会', url: 'https://drive.google.com/drive/folders/folder-reikai' };
    vi.mocked(api.addDriveFolder).mockResolvedValue({ folders: [reikai] });
    vi.mocked(api.removeDriveFolder).mockResolvedValue({ folders: [] });
    const user = userEvent.setup();
    renderScreen('settings', settings);

    expect(await screen.findByText(/AI は Drive 全体に触れます/u)).toBeTruthy();
    await user.type(screen.getByLabelText('フォルダのリンク'), reikai.url);
    vi.mocked(api.driveFolders).mockResolvedValue({ folders: [reikai] });
    await user.click(screen.getByRole('button', { name: 'フォルダを足す' }));

    await waitFor(() => expect(api.addDriveFolder).toHaveBeenCalledWith(ACCOUNT_ID, reikai.url));
    await user.click(await screen.findByRole('button', { name: '2026-27 例会 を外す' }));
    await waitFor(() => expect(api.removeDriveFolder).toHaveBeenCalledWith(ACCOUNT_ID, 'folder-reikai'));
  });

  it('stops the whole Account from its own control', async () => {
    vi.mocked(api.setSuspension).mockResolvedValue({ accountId: ACCOUNT_ID, status: 'suspended' });
    const user = userEvent.setup();
    renderScreen('settings', settings);

    await user.click(await screen.findByRole('button', { name: '一時停止する' }));

    await waitFor(() => expect(api.setSuspension).toHaveBeenCalledWith(ACCOUNT_ID, true));
  });
});
