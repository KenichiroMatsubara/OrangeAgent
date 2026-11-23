import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, contact } from './fixtures';
import * as contactScreen from './contact';
import { renderScreen } from './render';

fakeApi();

const path = 'contacts/:contactId';
const url = (contactId: string): string => `/contacts/${contactId}`;

describe('Contact screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.contacts).mockResolvedValue([
      contact({ lineDestinations: [{ id: 'handle-9', destinationId: 'Uyam…', displayName: '山田', kind: 'user', status: 'discovered', source: 'webhook' }] }),
      contact({ id: 'contact-2', name: '届かない人', email: '' }),
    ]);
    vi.mocked(api.channelTestTargets).mockResolvedValue([{ id: 'contact-1', name: '山田 太郎', email: 'taro@example.com', state: 'active', channels: ['line'] }]);
  });

  it('shows how the Contact is reached', async () => {
    renderScreen(path, contactScreen, url('contact-1'));

    const reach = await screen.findByRole('region', { name: '届け先' });
    expect(within(reach).getByText('山田')).toBeTruthy();
    expect(within(reach).getByText('taro@example.com')).toBeTruthy();
  });

  it('says a Contact with no address and no handle receives nothing', async () => {
    renderScreen(path, contactScreen, url('contact-2'));

    expect(await screen.findByText('メールアドレスも LINE もありません。要約もリマインドも届きません。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'テスト送信' })).toBeNull();
  });

  it('sends a test to the Contact on the Channel it holds', async () => {
    vi.mocked(api.sendChannelTest).mockResolvedValue({
      delivered: true, channel: 'line', contactId: 'contact-1', destination: 'Uyam…', messages: 1, requests: 1, externalId: 'req-1', sentAt: '2026-08-01T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderScreen(path, contactScreen, url('contact-1'));

    await user.click(await screen.findByRole('button', { name: 'テスト送信' }));
    const sheet = await screen.findByRole('dialog', { name: 'テスト送信' });
    await user.click(within(sheet).getByRole('button', { name: '送信する' }));

    await waitFor(() => expect(api.sendChannelTest).toHaveBeenCalledWith(ACCOUNT_ID, { contactId: 'contact-1', channel: 'line', texts: ['FlareChat からのテスト送信です。'] }));
    expect(await within(sheet).findByText(/LINE が受け付けました/u)).toBeTruthy();
  });

  it('saves an edited Contact', async () => {
    vi.mocked(api.updateContact).mockResolvedValue({ id: 'contact-1' });
    const user = userEvent.setup();
    renderScreen(path, contactScreen, url('contact-1'));

    await user.click(await screen.findByRole('button', { name: '編集' }));
    const sheet = await screen.findByRole('dialog', { name: '連絡先を編集' });
    await user.clear(within(sheet).getByRole('textbox', { name: '説明' }));
    await user.type(within(sheet).getByRole('textbox', { name: '説明' }), '副会長');
    await user.click(within(sheet).getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledWith(ACCOUNT_ID, 'contact-1', {
      name: '山田 太郎', email: 'taro@example.com', description: '副会長', tags: ['2026'], state: 'active',
    }));
  });

  it('removes a Contact only after the Account confirms', async () => {
    vi.mocked(api.deleteContact).mockResolvedValue({ id: 'contact-1', removed: true });
    const user = userEvent.setup();
    renderScreen(path, contactScreen, url('contact-1'));

    await user.click(await screen.findByRole('button', { name: 'この連絡先を削除' }));
    expect(api.deleteContact).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: '「山田 太郎」を削除しますか？' });
    await user.click(within(confirm).getByRole('button', { name: '削除する' }));

    await waitFor(() => expect(api.deleteContact).toHaveBeenCalledWith(ACCOUNT_ID, 'contact-1'));
    expect(await screen.findByText('別の画面')).toBeTruthy();
  });

  it('says so inside the shell when the Contact does not exist', async () => {
    renderScreen(path, contactScreen, url('missing'));

    expect(await screen.findByText('この画面の対象が見つかりません。')).toBeTruthy();
  });
});
