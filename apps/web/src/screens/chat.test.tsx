import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { mockDevice, type Device } from '../push';
import { ACCOUNT_ID, ready } from './fixtures';
import * as chat from './chat';
import { renderScreen } from './render';

fakeApi();

/** The browser the screen sees, which each test sets. */
const browser: { device: Device | null } = { device: null };

/** The browser the test set, or one that cannot be notified. */
const device = (): Device => browser.device ?? mockDevice('unsupported');

/** Hands the screen that browser. */
const Browser = ({ children }: { children: ReactNode }) => <chat.DeviceContext value={device}>{children}</chat.DeviceContext>;

describe('AI に聞く screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.chatThreads).mockResolvedValue([
      { id: 'thread-1', title: '来週の定例', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-21T01:00:00.000Z' },
      { id: 'thread-2', title: '', createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' },
    ]);
    vi.mocked(api.pushSettings).mockResolvedValue({ publicKey: 'BKey' });
    vi.mocked(api.chatCapabilities).mockResolvedValue({
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      efforts: { 'claude-opus-5-5': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }, 'claude-sonnet-5-5': { levels: ['low', 'medium', 'high'], default: 'medium' } },
      drivePicker: false,
    });
    window.localStorage.clear();
    browser.device = null;
  });

  it('lists the conversations, one with no message yet as a new one, at Tokyo times and with no id shown', async () => {
    renderScreen('chat', chat, '/chat', ready, Browser);

    expect(await screen.findByRole('link', { name: '来週の定例を開く' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '新しい会話を開く' })).toBeTruthy();
    expect(screen.getByText(/11月21日.*10:00/u)).toBeTruthy();
    expect(screen.queryByText(/thread-/u)).toBeNull();
  });

  it('starts a new conversation and opens it', async () => {
    vi.mocked(api.createChatThread).mockResolvedValue({ id: 'thread-9', title: '', createdAt: '2026-11-21T02:00:00.000Z', updatedAt: '2026-11-21T02:00:00.000Z' });
    const user = userEvent.setup();
    const { router } = renderScreen('chat', chat, '/chat', ready, Browser);
    await screen.findByRole('link', { name: '来週の定例を開く' });

    await user.click(screen.getByRole('button', { name: '新しい会話' }));

    await waitFor(() => expect(api.createChatThread).toHaveBeenCalledWith(ACCOUNT_ID));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat/thread-9'));
  });

  it('starts a conversation from what is written in the box, sending it as the first message, and opens it', async () => {
    vi.mocked(api.createChatThread).mockResolvedValue({ id: 'thread-9', title: '', createdAt: '2026-11-21T02:00:00.000Z', updatedAt: '2026-11-21T02:00:00.000Z' });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-9', accepted: true });
    const user = userEvent.setup();
    const { router } = renderScreen('chat', chat, '/chat', ready, Browser);
    const box = await screen.findByRole('textbox', { name: 'AI に聞くこと' });
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '今日の予定' }));
    expect((box as HTMLTextAreaElement).value).toBe('今日の予定を教えて');
    await user.type(box, '{Shift>}{Enter}{/Shift}午後だけ');
    await user.type(box, '{Enter}');

    await waitFor(() => expect(api.sendChatThreadMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-9', { text: '今日の予定を教えて\n午後だけ' }, []));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat/thread-9'));
  });

  it('starts a conversation with the model and level of effort chosen in the box, and remembers them for the conversation it opens', async () => {
    vi.mocked(api.createChatThread).mockResolvedValue({ id: 'thread-9', title: '', createdAt: '2026-11-21T02:00:00.000Z', updatedAt: '2026-11-21T02:00:00.000Z' });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-9', accepted: true });
    const user = userEvent.setup();
    const { router } = renderScreen('chat', chat, '/chat', ready, Browser);
    const model = await screen.findByRole('combobox', { name: '答えるモデル' });
    expect((model as HTMLSelectElement).value).toBe('claude-opus-5-5');
    expect(screen.getByRole('option', { name: 'Sonnet 5.5' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '考える深さ' }) as HTMLSelectElement).value).toBe('high');

    await user.selectOptions(model, 'claude-sonnet-5-5');
    // The level falls back to the one the model thinks at when none is named.
    expect((screen.getByRole('combobox', { name: '考える深さ' }) as HTMLSelectElement).value).toBe('medium');
    await user.selectOptions(screen.getByRole('combobox', { name: '考える深さ' }), 'high');
    await user.type(screen.getByRole('textbox', { name: 'AI に聞くこと' }), '熱田の招待行事を調べて{Enter}');

    await waitFor(() => expect(api.sendChatThreadMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-9', { text: '熱田の招待行事を調べて', model: 'claude-sonnet-5-5', effort: 'high' }, []));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat/thread-9'));
    expect(window.localStorage.getItem(`orangeagent:chat-model:${ACCOUNT_ID}`)).toBe('claude-sonnet-5-5');
    expect(window.localStorage.getItem(`orangeagent:chat-effort:${ACCOUNT_ID}`)).toBe('high');
  });

  it('starts a conversation from files attached in the box, each removable before it is sent', async () => {
    vi.mocked(api.createChatThread).mockResolvedValue({ id: 'thread-9', title: '', createdAt: '2026-11-21T02:00:00.000Z', updatedAt: '2026-11-21T02:00:00.000Z' });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-9', accepted: true });
    const user = userEvent.setup();
    const { container } = renderScreen('chat', chat, '/chat', ready, Browser);
    await screen.findByRole('combobox', { name: '答えるモデル' });
    const memo = new File(['会計'], 'memo.txt', { type: 'text/plain' });
    const list = new File(['名簿'], 'list.csv', { type: 'text/csv' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, [memo, list]);
    await user.click(screen.getByRole('button', { name: 'list.csvを外す' }));
    expect(screen.queryByText('list.csv')).toBeNull();
    await user.click(screen.getByRole('button', { name: '送る' }));

    await waitFor(() => expect(api.sendChatThreadMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-9', { text: '' }, [memo]));
  });

  it('sends with the default model where the models cannot be read', async () => {
    vi.mocked(api.chatCapabilities).mockRejectedValue(new Error('AI 接続がありません'));
    vi.mocked(api.createChatThread).mockResolvedValue({ id: 'thread-9', title: '', createdAt: '2026-11-21T02:00:00.000Z', updatedAt: '2026-11-21T02:00:00.000Z' });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-9', accepted: true });
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);
    await screen.findByRole('link', { name: '来週の定例を開く' });
    expect(screen.queryByRole('combobox', { name: '答えるモデル' })).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'AI に聞くこと' }), '今日の予定{Enter}');

    await waitFor(() => expect(api.sendChatThreadMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-9', { text: '今日の予定' }, []));
  });

  it('greets the person for the hour it is in Tokyo', () => {
    expect(chat.greeting('山田', new Date('2026-11-21T23:00:00.000Z'))).toBe('おはようございます、山田さん');
    expect(chat.greeting('', new Date('2026-11-21T03:00:00.000Z'))).toBe('こんにちは');
    expect(chat.greeting('山田', new Date('2026-11-21T12:00:00.000Z'))).toBe('こんばんは、山田さん');
  });

  it('shows the latest five conversations until all of them are asked for', async () => {
    vi.mocked(api.chatThreads).mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({ id: `thread-${index}`, title: `会話${index}`, createdAt: '', updatedAt: '2026-11-21T01:00:00.000Z' })));
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);

    expect(await screen.findByRole('link', { name: '会話4を開く' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '会話5を開く' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'すべての会話を表示（7 件）' }));
    expect(screen.getByRole('link', { name: '会話6を開く' })).toBeTruthy();
  });

  it('finds the conversations whose name holds every word searched for', async () => {
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);
    await screen.findByRole('link', { name: '来週の定例を開く' });

    await user.type(screen.getByRole('searchbox', { name: '会話を探す' }), '定例');
    expect(screen.getByRole('link', { name: '来週の定例を開く' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '新しい会話を開く' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: '会話を探す' }), ' 請求');
    expect(screen.getByText('「定例 請求」を名前に含む会話はありません。')).toBeTruthy();
    expect(chat.matching([{ id: 'a', title: '', createdAt: '', updatedAt: '' }], '新しい')).toHaveLength(1);
  });

  it('renames a conversation from its row, and refuses a name of nothing', async () => {
    vi.mocked(api.renameChatThread).mockResolvedValue({ id: 'thread-1', title: '請求の確認', createdAt: '', updatedAt: '' });
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);

    await user.click(await screen.findByRole('button', { name: '来週の定例の名前を変える' }));
    const field = screen.getByRole('textbox', { name: '名前' });
    expect((field as HTMLInputElement).value).toBe('来週の定例');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: '名前を変える' }));
    expect(screen.getByText('名前を入力してください。')).toBeTruthy();
    expect(api.renameChatThread).not.toHaveBeenCalled();
    await user.type(field, '  請求の   確認 ');
    await user.click(screen.getByRole('button', { name: '名前を変える' }));

    await waitFor(() => expect(api.renameChatThread).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-1', { title: '請求の 確認' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.chatThreads).toHaveBeenCalledTimes(2);
  });

  it('deletes a conversation only once the member confirms it, saying what goes and what stays', async () => {
    vi.mocked(api.deleteChatThread).mockResolvedValue({ id: 'thread-2', deleted: true });
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);

    await user.click(await screen.findByRole('button', { name: '新しい会話を削除' }));
    const dialog = screen.getByRole('dialog', { name: '「新しい会話」を削除しますか？' });
    expect(dialog.textContent).toContain('元に戻せません');
    expect(dialog.textContent).toContain('実行の記録は残ります');
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(api.deleteChatThread).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '新しい会話を削除' }));
    await user.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(api.deleteChatThread).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says there is no conversation yet', async () => {
    vi.mocked(api.chatThreads).mockResolvedValue([]);
    renderScreen('chat', chat, '/chat', ready, Browser);

    expect(await screen.findByText('会話はまだありません')).toBeTruthy();
  });
});

describe('AI に聞く screen\'s 通知', () => {
  const section = async (): Promise<HTMLElement> => {
    const heading = await screen.findByRole('heading', { name: '通知' });
    const found = heading.closest('section');
    if (!found) throw new Error('No 通知 section.');
    return found;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.chatThreads).mockResolvedValue([]);
    vi.mocked(api.pushSettings).mockResolvedValue({ publicKey: 'BKey' });
    vi.mocked(api.chatCapabilities).mockResolvedValue({ models: [], efforts: {}, drivePicker: false });
    vi.mocked(api.savePushDevice).mockResolvedValue({ subscribed: true });
    vi.mocked(api.removePushDevice).mockResolvedValue({ subscribed: false });
  });

  it('says notifications cannot be sent where the Worker holds no keys, and what to do meanwhile', async () => {
    vi.mocked(api.pushSettings).mockResolvedValue({ publicKey: null });
    browser.device = mockDevice(null);
    renderScreen('chat', chat, '/chat', ready, Browser);

    const part = await section();
    expect(await screen.findByText('使えません')).toBeTruthy();
    expect(part.textContent).toMatch(/鍵がまだ設定されていません.*会話を開いて確かめてください/u);
    expect(part.querySelector('button')).toBeNull();
  });

  it('tells an iPhone opened in Safari to add OrangeAgent to the home screen first', async () => {
    browser.device = mockDevice('install');
    renderScreen('chat', chat, '/chat', ready, Browser);

    const part = await section();
    expect(await screen.findByText('ホーム画面に追加すると使えます')).toBeTruthy();
    expect(part.textContent).toContain('「ホーム画面に追加」を選ぶ');
    expect(part.querySelector('button')).toBeNull();
  });

  it('says a browser that cannot be notified, or one that blocked it, cannot be turned on here, and what follows', async () => {
    browser.device = mockDevice('unsupported');
    const first = renderScreen('chat', chat, '/chat', ready, Browser);
    expect(await screen.findByText('このブラウザでは使えません')).toBeTruthy();
    first.unmount();

    browser.device = mockDevice('denied');
    renderScreen('chat', chat, '/chat', ready, Browser);
    const part = await section();
    expect(await screen.findByText('ブロックされています')).toBeTruthy();
    expect(part.textContent).toContain('通知を許可してから');
    expect(part.querySelector('button')).toBeNull();
  });

  it('turns this browser on, handing its subscription and its name to the Worker, and off again', async () => {
    browser.device = mockDevice(null);
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);

    await user.click(await screen.findByRole('button', { name: 'この端末で受け取る' }));

    expect(await screen.findByText('オン')).toBeTruthy();
    expect(api.savePushDevice).toHaveBeenCalledWith(ACCOUNT_ID, { endpoint: 'https://push.example.com/mock', keys: { p256dh: 'mock', auth: 'mock' }, label: 'iPhone の Safari' });
    expect((await section()).textContent).toContain('この端末（iPhone の Safari）に届きます');

    await user.click(screen.getByRole('button', { name: 'この端末では受け取らない' }));
    expect(await screen.findByText('オフ')).toBeTruthy();
    expect(api.removePushDevice).toHaveBeenCalledWith(ACCOUNT_ID, 'https://push.example.com/mock');
  });

  it('hands over again a subscription this browser still holds, so the Worker notifies it', async () => {
    browser.device = mockDevice('on');
    renderScreen('chat', chat, '/chat', ready, Browser);

    expect(await screen.findByText('オン')).toBeTruthy();
    await waitFor(() => expect(api.savePushDevice).toHaveBeenCalledWith(ACCOUNT_ID, expect.objectContaining({ endpoint: 'https://push.example.com/mock' })));
  });

  it('leaves this browser off, and says so, when the Worker does not take it', async () => {
    browser.device = mockDevice(null);
    vi.mocked(api.savePushDevice).mockRejectedValue(new Error('この OrangeAgent には通知の鍵（VAPID）が設定されていないため、通知を送れません。'));
    const user = userEvent.setup();
    renderScreen('chat', chat, '/chat', ready, Browser);

    await user.click(await screen.findByRole('button', { name: 'この端末で受け取る' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('オフ')).toBeTruthy();
    expect(await browser.device.subscription('BKey')).toBeNull();
  });
});
