import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeThreadRef } from '@t3tools/client-runtime/environment/index.ts';
import { EnvironmentId, ThreadId } from '@t3tools/contracts';

import ChatStarter from './starter.tsx';
import type { ChatStarterHandle, ChatStarterSource } from './api.ts';
import { startI18n, whenLocaleReady } from '~/i18n/runtime';
import { useComposerDraftStore } from '~/composerDraftStore';

/** A browser that answers every media query as `matches` says. */
const media = (matches: (query: string) => boolean): void => {
  window.matchMedia = (query: string) => ({
    matches: matches(query), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  });
};

const sourceOf = (started = true): ChatStarterSource & { start: ReturnType<typeof vi.fn> } => ({
  start: vi.fn(async () => started),
  capabilities: async () => ({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'], efforts: {}, drivePicker: false }),
  chosenModel: () => null,
  chooseModel: () => undefined,
});

beforeAll(async () => {
  startI18n();
  await whenLocaleReady();
  media(() => false);
  const noRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.getClientRects = noRects;
  document.elementFromPoint = () => null;
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, ready: Promise.resolve() } });
});

afterEach(() => {
  cleanup();
  useComposerDraftStore.getState().clearComposerContent(DRAFT);
  media(() => false);
  window.localStorage.clear();
});

/** The draft the box keeps until it is sent. */
const DRAFT = scopeThreadRef(EnvironmentId.make('orangeagent'), ThreadId.make('orangeagent-start'));
const written = (): string => useComposerDraftStore.getState().getComposerDraft(DRAFT)?.prompt ?? '';

describe('the box a conversation starts from', () => {
  it('starts a new line on Enter on a touch screen, as a conversation does, and starts the conversation from the send button', async () => {
    media((query) => query.includes('pointer: coarse'));
    const source = sourceOf();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatStarter source={source} busy={false} />);
    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    expect(editor.getAttribute('enterkeyhint')).toBe('enter');

    await user.click(editor);
    await user.keyboard('一行目{Enter}二行目');
    expect(source.start).not.toHaveBeenCalled();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    });

    await waitFor(() => expect(source.start).toHaveBeenCalledWith('一行目\n二行目', { files: [] }));
    await waitFor(() => expect(written()).toBe(''));
  }, 30_000);

  it('starts the conversation on Enter at a keyboard, with the model chosen in the box', async () => {
    const source = sourceOf();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatStarter source={source} busy={false} />);

    const choice = await screen.findByRole('button', { name: '答えるモデル: Claude Sonnet 5.5' }, { timeout: 10_000 });
    await act(async () => {
      await user.click(choice);
    });
    const options = await screen.findAllByRole('menuitemradio');
    await act(async () => {
      await user.click(options[1] as HTMLElement);
    });
    await user.click(await screen.findByTestId('composer-editor'));
    await user.keyboard('急ぎで');
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    await waitFor(() => expect(source.start).toHaveBeenCalledWith('急ぎで', { files: [], model: 'claude-opus-5-5' }));
  }, 30_000);

  it('keeps what was written when the conversation did not start', async () => {
    const source = sourceOf(false);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatStarter source={source} busy={false} />);
    await user.click(await screen.findByTestId('composer-editor', {}, { timeout: 10_000 }));
    await user.keyboard('残して');
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    await waitFor(() => expect(source.start).toHaveBeenCalled());
    expect(written()).toBe('残して');
  }, 30_000);

  it('takes what the screen puts in it, to send or rewrite', async () => {
    const source = sourceOf();
    const box = createRef<ChatStarterHandle>();
    render(<ChatStarter ref={box} source={source} busy={false} />);
    await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });

    act(() => box.current?.put('今日の予定を教えて'));

    await waitFor(() => expect(screen.getByTestId('composer-editor').textContent).toBe('今日の予定を教えて'));
  }, 30_000);
});
