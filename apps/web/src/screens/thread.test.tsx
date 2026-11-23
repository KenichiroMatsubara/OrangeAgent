import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSurfaceProps } from '@mail/t3chat';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, ready } from './fixtures';
import * as thread from './thread';
import { renderScreen } from './render';

fakeApi();

/** The chat itself, which says what its conversation is called and continues it as another when asked. */
const Surface = ({ threadId, onTitle, onOpenThread }: ChatSurfaceProps) => {
  useEffect(() => onTitle?.('週末の予定'), [onTitle]);
  return <button type="button" onClick={() => onOpenThread?.('thread-9')}>{`${threadId} をここから続ける`}</button>;
};

/** Shows the conversation in that chat. */
const Chat = ({ children }: { children: ReactNode }) => <thread.SurfaceContext value={Surface}>{children}</thread.SurfaceContext>;

describe('a conversation of AI に聞く', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('names the conversation in its bar as the chat says, and renames it there', async () => {
    vi.mocked(api.renameChatThread).mockResolvedValue({ id: 'thread-1', title: '請求の確認', createdAt: '', updatedAt: '' });
    const user = userEvent.setup();
    renderScreen('chat/:threadId', thread, '/chat/thread-1', ready, Chat);

    expect(await screen.findByText('週末の予定')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '会話の名前を変える' }));
    const field = screen.getByRole('textbox', { name: '名前' });
    await user.clear(field);
    await user.type(field, '請求の確認');
    await user.click(screen.getByRole('button', { name: '名前を変える' }));

    await waitFor(() => expect(api.renameChatThread).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-1', { title: '請求の確認' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('deletes the conversation once confirmed, and goes back to the list', async () => {
    vi.mocked(api.deleteChatThread).mockResolvedValue({ id: 'thread-1', deleted: true });
    const user = userEvent.setup();
    const { router } = renderScreen('chat/:threadId', thread, '/chat/thread-1', ready, Chat);

    await screen.findByText('週末の予定');
    await user.click(screen.getByRole('button', { name: '会話を削除' }));
    expect(screen.getByRole('dialog', { name: '「週末の予定」を削除しますか？' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '削除する' }));

    await waitFor(() => expect(api.deleteChatThread).toHaveBeenCalledWith(ACCOUNT_ID, 'thread-1'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
  });

  it('opens the conversation continued from this one', async () => {
    const user = userEvent.setup();
    const { router } = renderScreen('chat/:threadId', thread, '/chat/thread-1', ready, Chat);

    await user.click(await screen.findByRole('button', { name: 'thread-1 をここから続ける' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/chat/thread-9'));
  });
});
