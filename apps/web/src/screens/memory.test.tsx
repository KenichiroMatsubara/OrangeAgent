import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Memory } from '@mail/domain';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID } from './fixtures';
import * as memoryScreen from './memory';
import { renderScreen } from './render';

fakeApi();

const memory = (overrides: Partial<Memory> = {}): Memory => ({
  id: 'memory-1',
  content: '田中さんへの連絡は LINE で送る',
  author: { kind: 'chat', name: '', conversationId: 'conversation-1' },
  editedBy: null,
  status: 'active',
  kind: 'fact',
  provenance: 'proposed',
  createdAt: '2026-10-28T01:10:00.000Z',
  updatedAt: '2026-10-28T01:10:00.000Z',
  ...overrides,
});

describe('記憶 screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.memories).mockResolvedValue({
      memories: [memory(), memory({ id: 'memory-2', content: '資料は A4 縦で作る', author: { kind: 'person', name: 'Owner', conversationId: null } })],
    });
  });

  it('lists every memory with who wrote it, and opens the conversation Operator Chat kept it in', async () => {
    renderScreen('memory', memoryScreen);

    const list = await screen.findByRole('list', { name: '覚えていること' });
    expect(within(list).getByText('田中さんへの連絡は LINE で送る')).toBeTruthy();
    expect(within(list).getByText('AI（チャット）')).toBeTruthy();
    expect(within(list).getByText('Owner')).toBeTruthy();
    expect(within(list).getByRole('link', { name: '覚えた会話を開く' }).getAttribute('href')).toBe(`/chat/conversation-1`);
  });

  it('searches the way the AI does and shows how each memory matched', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue({ query: '田中さんに連絡するには', hits: [{ memory: memory(), similarity: 0.82, keywords: 0.64 }] });
    renderScreen('memory', memoryScreen);

    await userEvent.type(await screen.findByRole('searchbox', { name: '記憶を探す' }), '田中さんに連絡するには');
    await userEvent.click(screen.getByRole('button', { name: '探す' }));

    const found = await screen.findByRole('list', { name: '見つかった記憶' });
    expect(api.searchMemories).toHaveBeenCalledWith(ACCOUNT_ID, '田中さんに連絡するには');
    expect(within(found).getByText('意味の近さ 82%')).toBeTruthy();
    expect(within(found).getByText('ことばの重なり 64%')).toBeTruthy();
  });

  it('says it holds no certain memory when nothing matched, as the AI is told', async () => {
    vi.mocked(api.searchMemories).mockResolvedValue({ query: '会費はいくら', hits: [] });
    renderScreen('memory', memoryScreen);

    await userEvent.type(await screen.findByRole('searchbox', { name: '記憶を探す' }), '会費はいくら');
    await userEvent.click(screen.getByRole('button', { name: '探す' }));

    expect(await screen.findByText('「会費はいくら」について確かな記憶はありません。AI にもそう返ります。')).toBeTruthy();
  });

  it('shows the words a memory rests on, marked where they are, and every change to it', async () => {
    vi.mocked(api.memory).mockResolvedValue({
      memory: memory(),
      episode: {
        source: 'chat', memberName: '', content: '会員: 連絡は？\nAI: 田中さんへの連絡は LINE で送る', evidence: { start: 13, end: 31 },
        conversationId: 'conversation-1', receivedAt: '2026-10-28T01:10:00.000Z',
      },
      changes: [
        { at: '2026-10-28T01:10:00.000Z', actor: { kind: 'chat', name: '' }, action: 'add' },
        { at: '2026-10-29T01:10:00.000Z', actor: { kind: 'member', name: 'Owner' }, action: 'correct' },
      ],
    });
    renderScreen('memory', memoryScreen);
    const first = within(await screen.findByRole('list', { name: '覚えていること' })).getAllByRole('listitem')[0] as HTMLElement;

    await userEvent.click(within(first).getByRole('button', { name: '根拠' }));

    const sheet = await screen.findByRole('dialog', { name: 'この記憶の根拠' });
    expect(api.memory).toHaveBeenCalledWith(ACCOUNT_ID, 'memory-1');
    expect((await within(sheet).findByText('田中さんへの連絡は LINE で送る', { selector: 'mark' })).tagName).toBe('MARK');
    expect(within(sheet).getByText(/チャットのやり取り/u)).toBeTruthy();
    const history = within(sheet).getByRole('list', { name: '変更の記録' });
    expect(within(history).getByText('AI（チャット） が覚えた')).toBeTruthy();
    expect(within(history).getByText('Owner が直した')).toBeTruthy();
  });

  it('adds, corrects, and deletes a memory', async () => {
    vi.mocked(api.saveMemory).mockResolvedValue(memory({ id: 'memory-3' }));
    vi.mocked(api.updateMemory).mockResolvedValue(memory({ content: '田中さんへの連絡はメールで送る' }));
    vi.mocked(api.eraseMemory).mockResolvedValue({ id: 'memory-1', removed: true });
    renderScreen('memory', memoryScreen);
    await screen.findByRole('list', { name: '覚えていること' });

    await userEvent.click(screen.getByRole('button', { name: '足す' }));
    await userEvent.type(screen.getByRole('textbox', { name: '覚えること' }), '会議は月曜');
    await userEvent.click(screen.getByRole('button', { name: '覚える' }));
    await waitFor(() => expect(api.saveMemory).toHaveBeenCalledWith(ACCOUNT_ID, '会議は月曜'));

    const first = within(screen.getByRole('list', { name: '覚えていること' })).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: '直す' }));
    const editor = screen.getByRole('textbox', { name: '覚えること' });
    await userEvent.clear(editor);
    await userEvent.type(editor, '田中さんへの連絡はメールで送る');
    await userEvent.click(within(screen.getByRole('dialog', { name: '記憶を直す' })).getByRole('button', { name: '直す' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith(ACCOUNT_ID, 'memory-1', '田中さんへの連絡はメールで送る'));

    const again = within(screen.getByRole('list', { name: '覚えていること' })).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(again).getByRole('button', { name: '削除' }));
    await userEvent.click(within(again).getByRole('button', { name: '本当に削除する' }));
    await waitFor(() => expect(api.eraseMemory).toHaveBeenCalledWith(ACCOUNT_ID, 'memory-1'));
  });
});
