import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// t3code's i18n runs in the browser build only; Node would resolve its server entry.

import ChatSurface from './surface.tsx';
import type { ModelEffort } from '@mail/domain';
import type { ChatCapabilities, ChatMode, ChatTransport } from './api.ts';
import { forgetThreads } from './stream.ts';
import { forgetSuggestions } from './suggestion.ts';
import { startI18n, whenLocaleReady } from '~/i18n/runtime';
import { encodeFrame, ids, utc, type DomainEvent, type Projection, type Run, type RuntimeRequest, type TurnItem } from './wire.ts';

const THREAD_ID = 'thread-new';
const AT = Date.parse('2026-11-21T01:00:00.000Z');

/** A conversation with no message yet, as the Worker's object sends it to a screen that opens it. */
const emptyConversation = (): Projection => ({
  thread: {
    id: ids.thread(THREAD_ID),
    projectId: ids.project('orangeagent'),
    title: '新しい会話',
    providerInstanceId: ids.provider('orangeagent'),
    modelSelection: { instanceId: ids.provider('orangeagent'), model: 'orangeagent' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ids.thread(THREAD_ID), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: 'user',
    creationSource: 'web',
    createdAt: utc(AT),
    updatedAt: utc(AT),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [], attempts: [], nodes: [], subagents: [], providerSessions: [], providerThreads: [], providerTurns: [],
  runtimeRequests: [], messages: [], plans: [], turnItems: [], checkpointScopes: [], checkpoints: [],
  contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: utc(AT),
});

const event = (type: 'run.created' | 'run.updated' | 'turn-item.updated' | 'runtime-request.updated' | 'message.updated', payload: Run | TurnItem | RuntimeRequest | Projection['messages'][number]): DomainEvent =>
  ({ id: ids.event(crypto.randomUUID()), threadId: ids.thread(THREAD_ID), occurredAt: utc(AT), type, payload } as DomainEvent);

const item = { threadId: ids.thread(THREAD_ID), runId: ids.run('run-1'), nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, title: null, startedAt: utc(AT), completedAt: utc(AT + 2_000), updatedAt: utc(AT + 2_000) };
const run = (status: 'running' | 'interrupted' | 'waiting' | 'completed'): Run => ({
  id: ids.run('run-1'), threadId: ids.thread(THREAD_ID), ordinal: 1, providerInstanceId: ids.provider('orangeagent'),
  modelSelection: { instanceId: ids.provider('orangeagent'), model: 'orangeagent' }, providerThreadId: null, userMessageId: ids.message('message-1'),
  rootNodeId: null, activeAttemptId: null, status, requestedAt: utc(AT), startedAt: utc(AT), completedAt: status === 'interrupted' || status === 'completed' ? utc(AT + 2_000) : null,
  checkpointId: null, contextHandoffId: null,
});

/** An answer a person stopped while it was written, as the Worker records it. */
const stoppedAnswer = (): DomainEvent[] => [
  event('run.created', run('running')),
  event('turn-item.updated', { ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: 'もう一度教えてください', attachments: [] } as TurnItem),
  event('turn-item.updated', { ...item, id: ids.item('message-2'), ordinal: 1, status: 'interrupted', type: 'assistant_message', messageId: ids.message('message-2'), text: 'こんにちは。まず確認し', streaming: false } as TurnItem),
  event('run.updated', run('interrupted')),
];

/** An answer that ended, with a file it wrote, as the Worker records one. */
const completedAnswer = (): DomainEvent[] => [
  event('run.created', run('running')),
  event('turn-item.updated', { ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: '請求を表にして', attachments: [] } as TurnItem),
  event('turn-item.updated', {
    ...item, id: ids.item('message-2'), ordinal: 1, status: 'completed', type: 'assistant_message', messageId: ids.message('message-2'), text: '表にしました。', streaming: false,
    attachments: [{ type: 'file', id: ids.attachment('pdf-1'), name: '請求一覧.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }],
  } as TurnItem),
  event('run.updated', run('completed')),
];

/** An answer waiting for the person to approve a mail, as the Worker shows one. */
const waitingAnswer = (): DomainEvent[] => [
  event('run.created', run('running')),
  event('turn-item.updated', { ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: 'a@example.com に送って', attachments: [] } as TurnItem),
  event('turn-item.updated', { ...item, id: ids.item('tool-1'), ordinal: 1, status: 'waiting', completedAt: null, type: 'dynamic_tool', toolName: 'mail.send', input: { to: 'a@example.com' } } as TurnItem),
  event('turn-item.updated', {
    ...item, id: ids.item('approval-1'), ordinal: 2, status: 'waiting', completedAt: null, parentItemId: ids.item('tool-1'), type: 'approval_request',
    requestId: ids.request('request-1'), requestKind: 'permission', prompt: 'メールを送る\n宛先：a@example.com\n件名：定例\n本文：\n皆さま\n\nよろしく', reason: '要承認の会話なので、実行する前に確認します。',
    options: [{ decision: 'accept', label: '今回だけ許可' }, { decision: 'acceptAlways', label: '今後も許可' }, { decision: 'decline', label: '拒否' }],
  } as TurnItem),
  event('runtime-request.updated', {
    id: ids.request('request-1'), nodeId: ids.node('run-1'), providerTurnId: null, nativeRequestRef: null, kind: 'permission', status: 'pending',
    responseCapability: { type: 'live', providerSessionId: ids.session('orangeagent'), supportsFeedback: true }, createdAt: utc(AT), resolvedAt: null,
  }),
  event('run.updated', run('waiting')),
];

/** The modes a Worker without an OpenRouter key offers. */
const WITHOUT_DECIDER: ReadonlyArray<ChatMode> = ['read_only', 'ask', 'unrestricted'];

const transportOf = (events: readonly DomainEvent[] = [], modes: ReadonlyArray<ChatMode> = WITHOUT_DECIDER, others: Readonly<Record<string, Projection>> = {}): ChatTransport & { send: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn>; setMode: ReturnType<typeof vi.fn>; changeQueue: ReturnType<typeof vi.fn>; rewind: ReturnType<typeof vi.fn>; fork: ReturnType<typeof vi.fn> } => ({
  subscribe: (threadId, _after, onFrame) => {
    queueMicrotask(() => {
      const other = others[threadId];
      if (other !== undefined) {
        onFrame(encodeFrame({ kind: 'snapshot', snapshotSequence: 1, projection: other }));
        onFrame(encodeFrame({ kind: 'synchronized' }));
        return;
      }
      onFrame(encodeFrame({ kind: 'snapshot', snapshotSequence: 1, projection: emptyConversation(), idTable: true }));
      events.forEach((domainEvent, index) => onFrame(encodeFrame({ kind: 'event', sequence: index + 2, event: domainEvent })));
      onFrame(encodeFrame({ kind: 'synchronized' }));
    });
    return () => undefined;
  },
  respond: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined),
  modes: async () => modes,
  setMode: vi.fn(async () => undefined),
  interrupt: vi.fn(async () => undefined),
  changeQueue: vi.fn(async () => undefined),
  rewind: vi.fn(async () => undefined),
  fork: vi.fn(async () => 'thread-forked'),
  attachmentUrls: new Map([['photo-1', 'data:image/png;base64,iVBORw0KGgo='], ['chart-1', 'https://orangeagent.test/files/chart-1'], ['pdf-1', 'https://orangeagent.test/files/pdf-1'], ['csv-1', 'https://orangeagent.test/files/csv-1']]),
});

// jsdom has no media queries, font loading, or layout; the chat and its editor read them as a desktop browser answers.
beforeAll(async () => {
  // The chat is Japanese once its catalog has loaded; a test asks for its controls by their Japanese names.
  startI18n();
  await whenLocaleReady();
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  });
  const noRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.getClientRects = noRects;
  document.elementFromPoint = () => null;
  // The timeline lays out only the rows its viewport has room for.
  for (const name of ['clientHeight', 'offsetHeight', 'clientWidth', 'offsetWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 800 });
  }
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, ready: Promise.resolve() } });
});

afterEach(() => {
  cleanup();
  forgetThreads();
  forgetSuggestions();
});

describe('the chat surface', () => {
  // A conversation no other test opened: the thread state another one read stays in its atom.
  it('shows a conversation not yet read as loading, never as one with no message, and its messages once they arrive', async () => {
    let deliver: (() => void) | null = null;
    const base = transportOf();
    const transport: ChatTransport = { ...base, subscribe: (threadId, after, onFrame, ...rest) => {
      deliver = () => base.subscribe(threadId, after, onFrame, ...rest);
      return () => undefined;
    } };
    render(<ChatSurface threadId="thread-unread" transport={transport} />);

    await screen.findByText('会話を読み込んでいます', {}, { timeout: 10_000 });
    expect(document.body.textContent).not.toContain('メッセージを送信して会話を始めましょう。');

    await act(async () => {
      deliver?.();
      await new Promise((done) => setTimeout(done, 0));
    });
    await screen.findByText('メッセージを送信して会話を始めましょう。', {}, { timeout: 10_000 });
    expect(document.body.textContent).not.toContain('会話を読み込んでいます');
  }, 30_000);

  it('sends what a person writes in a new conversation to the transport', async () => {
    const transport = transportOf();
    const user = userEvent.setup();
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    await user.click(editor);
    await user.keyboard('明日の予定を教えてください');
    const submit = await screen.findByRole('button', { name: 'メッセージを送信' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      await user.click(submit);
    });

    await waitFor(() => expect(transport.send).toHaveBeenCalledWith('明日の予定を教えてください', { delivery: 'steer', files: [] }));
  }, 30_000);

  it('names the author of an answer AI and its stopped state in words, not t3code\'s name or a status identifier', async () => {
    render(<ChatSurface threadId={THREAD_ID} transport={transportOf(stoppedAnswer())} />);

    await screen.findByText('こんにちは。まず確認し', {}, { timeout: 10_000 });
    expect(screen.getAllByRole('heading', { name: 'AI' }).length).toBeGreaterThan(0);
    expect(screen.getByText('中断')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/T3 Code|interrupted/u);
  }, 30_000);

  it('asks inline about a call waiting for approval, in words, and takes the answer or a typed message as a decline', async () => {
    const transport = transportOf(waitingAnswer());
    // The responding row is held while the composer settles; jsdom has no layout to wait for.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    // What the call will do, in words: the mail's recipient, subject, and body, each line by itself.
    const detail = await waitFor(() => {
      const found = document.querySelector('[data-approval-detail="complete"]');
      if (found === null) throw new Error('no approval yet');
      return found;
    }, { timeout: 10_000 });
    expect([...detail.children].map((child) => child.textContent)).toEqual(['メールを送る', '宛先：a@example.com件名：定例本文：皆さまよろしく']);
    expect(detail.closest('code')).toBeNull();
    expect(screen.getByRole('group', { name: 'メールを送る' })).toBeTruthy();
    expect(screen.getByText('要承認の会話なので、実行する前に確認します。')).toBeTruthy();
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: '今回だけ許可' })[0] as HTMLElement);
    });
    await waitFor(() => expect(transport.respond).toHaveBeenCalledWith('request-1', 'accept', undefined));

    const editor = await screen.findByTestId('composer-editor');
    await user.click(editor);
    await user.keyboard('宛先は b@example.com にして');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(transport.respond).toHaveBeenCalledWith('request-1', 'decline', '宛先は b@example.com にして'));
    expect(transport.send).not.toHaveBeenCalled();
  }, 30_000);

  it('offers OrangeAgent\'s composer: its own placeholder, a way to attach files, and none of t3code\'s menus, microphone, or model picker', async () => {
    const transport = transportOf();
    const user = userEvent.setup();
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    expect(document.body.textContent).toContain('AI に頼みたいことを書いてください');
    expect(document.body.textContent).not.toMatch(/@ で|\$ で|\/ で|フルアクセス|ブランチ|ワークツリー/u);
    expect(screen.queryByRole('button', { name: /音声入力/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /OrangeAgent/u })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'ファイルを添付' }).length).toBeGreaterThan(0);
    // The permission control stays: the approval modes are chosen here.
    expect(screen.getAllByRole('button', { name: /権限/u }).length).toBeGreaterThan(0);

    await user.click(editor);
    await user.keyboard('/@$');
    expect(screen.queryByRole('listbox')).toBeNull();
  }, 30_000);

  it('offers the approval modes the server offers, and 自動 only when it offers it', async () => {
    const modesIn = async (transport: ChatTransport): Promise<string[]> => {
      const user = userEvent.setup();
      const view = render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
      await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
      const chip = await screen.findByRole('button', { name: '権限: 無制限' });
      await waitFor(async () => {
        await user.click(chip);
        expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(1);
      });
      const names = screen.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-label') ?? '');
      view.unmount();
      return names;
    };

    expect(await modesIn(transportOf())).toEqual(['読み取りのみ', '要承認', '無制限']);
    expect(await modesIn(transportOf([], ['read_only', 'ask', 'auto', 'unrestricted']))).toEqual(['読み取りのみ', '要承認', '自動', '無制限']);
  }, 30_000);

  it('sends the files a person attaches with their message', async () => {
    const transport = transportOf();
    const user = userEvent.setup();
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('image/*');
    const memo = new File(['19:00 開始'], 'memo.txt', { type: 'text/plain' });

    await act(async () => {
      await user.upload(input, memo);
    });
    await waitFor(() => expect(document.body.textContent).toContain('memo.txt'));
    await user.click(editor);
    await user.keyboard('このメモの予定を入れて');
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    await waitFor(() => expect(transport.send).toHaveBeenCalled());
    const [text, options] = transport.send.mock.calls[0] as [string, { delivery: string; files: File[] }];
    expect(text).toContain('このメモの予定を入れて');
    expect(text).not.toContain('t3-context:');
    expect(options.delivery).toBe('steer');
    expect(options.files.map((file) => file.name)).toEqual(['memo.txt']);
  }, 30_000);

  it('starts a new line on Enter on a touch screen, where the send button sends, and labels the key so', async () => {
    window.matchMedia = (query: string) => ({
      matches: query.includes('pointer: coarse'), media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    });
    try {
      const transport = transportOf();
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
      const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
      expect(editor.getAttribute('enterkeyhint')).toBe('enter');

      await user.click(editor);
      await user.keyboard('一行目{Enter}二行目');
      expect(transport.send).not.toHaveBeenCalled();
      await act(async () => {
        await user.click(screen.getByRole('button', { name: 'メッセージを送信' }));
      });

      await waitFor(() => expect(transport.send).toHaveBeenCalled());
      expect(transport.send.mock.calls[0]?.[0]).toBe('一行目\n二行目');
    } finally {
      window.matchMedia = (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      });
    }
  }, 30_000);

  it('offers what the person is likely to write next once an answer completes, greyed until they type, and Tab puts it in the composer to send', async () => {
    const suggestion = vi.fn(async () => ({ runId: 'run-1', text: '送って' }));
    const transport = { ...transportOf(completedAnswer()), suggestion };
    const user = userEvent.setup();
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    await waitFor(() => expect(document.body.textContent).toContain('送って'));
    expect(document.body.textContent).not.toContain('AI に頼みたいことを書いてください');
    expect(suggestion).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();

    await user.click(editor);
    await user.keyboard('{Tab}');
    await waitFor(() => expect(editor.textContent).toBe('送って'));
    await user.keyboard('{Enter}');

    await waitFor(() => expect(transport.send).toHaveBeenCalled());
    expect(transport.send.mock.calls[0]?.[0]).toBe('送って');
  }, 30_000);

  it('shows a message sent while nothing runs at once, with the send button waiting and the suggestion gone, until its answer appears', async () => {
    const transport = { ...transportOf(completedAnswer()), suggestion: async () => ({ runId: 'run-1', text: '送って' }), send: vi.fn(() => new Promise<void>(() => undefined)) };
    const user = userEvent.setup();
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
    const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    await waitFor(() => expect(document.body.textContent).toContain('送って'));

    await user.click(editor);
    await user.keyboard('午後の予定は？');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(transport.send).toHaveBeenCalled());
    await screen.findByText('午後の予定は？', {}, { timeout: 10_000 });
    expect(await screen.findByRole('button', { name: 'メッセージを送信しています' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('送って');
  }, 30_000);

  it('puts the suggestion in the composer when its hint is tapped on a touch screen, which has no Tab key', async () => {
    window.matchMedia = (query: string) => ({
      matches: query.includes('pointer: coarse'), media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    });
    try {
      const transport = { ...transportOf(completedAnswer()), suggestion: async () => ({ runId: 'run-1', text: '送って' }) };
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
      const editor = await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });

      const hint = await screen.findByRole('button', { name: '提案されたプロンプトを使用' }, { timeout: 10_000 });
      expect(hint.textContent).toBe('入れる');
      await user.click(hint);
      await waitFor(() => expect(editor.textContent).toBe('送って'));
      expect(transport.send).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      });
    }
  }, 30_000);

  it('offers no suggestion after an answer that was stopped, even one the server named, and shows its own placeholder', async () => {
    render(<ChatSurface threadId={THREAD_ID} transport={{ ...transportOf(stoppedAnswer()), suggestion: async () => ({ runId: 'run-1', text: '送って' }) }} />);

    await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    await screen.findByText('こんにちは。まず確認し', {}, { timeout: 10_000 });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(document.body.textContent).toContain('AI に頼みたいことを書いてください');
    expect(document.body.textContent).not.toContain('送って');
  }, 30_000);

  it('hands a message typed while an answer runs to it, or queues it with the modifier key, and marks a handed message waiting to be read', async () => {
    const steering: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', { ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: '予定を調べて', attachments: [] } as TurnItem),
      event('turn-item.updated', { ...item, id: ids.item('tool-1'), ordinal: 1, status: 'running', completedAt: null, type: 'dynamic_tool', toolName: 'calendar.search', input: {} } as TurnItem),
      event('turn-item.updated', {
        ...item, id: ids.item('steer-1'), ordinal: 2, status: 'pending', completedAt: null, createdBy: 'user', creationSource: 'web', type: 'user_message',
        messageId: ids.message('steer-1'), inputIntent: 'steer', text: '来週の分も', attachments: [{ type: 'image', id: ids.attachment('photo-1'), name: 'photo.png', mimeType: 'image/png', sizeBytes: 8 }],
      } as TurnItem),
    ];
    const transport = transportOf(steering);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    await screen.findByText('来週の分も', {}, { timeout: 10_000 });
    expect(container.querySelector('[data-user-message-intent="steer"]')?.textContent).toBe('軌道修正 · 読み取り待ち');
    expect(container.querySelector('img[alt="photo.png"]')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');

    const editor = await screen.findByTestId('composer-editor');
    await user.click(editor);
    await user.keyboard('午後だけで');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith('午後だけで', { delivery: 'steer', files: [] }));

    await user.click(editor);
    await user.keyboard('終わったら一覧に');
    await act(async () => {
      await user.keyboard('{Control>}{Enter}{/Control}');
    });
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith('終わったら一覧に', { delivery: 'queue', files: [] }));
  }, 30_000);

  it('shows the queued messages above the composer and moves, removes, sends, and rewrites them through the transport', async () => {
    const queuedRun = (id: string, position: number): Run => ({ ...run('running'), id: ids.run(id), ordinal: position + 1, status: 'queued', queuePosition: position, userMessageId: ids.message(`${id}:user`), startedAt: null });
    const message = (id: string, text: string) => ({
      id: ids.message(`${id}:user`), threadId: ids.thread(THREAD_ID), runId: ids.run(id), nodeId: null, role: 'user' as const, text, attachments: [], streaming: false,
      createdAt: utc(AT), updatedAt: utc(AT), createdBy: 'user' as const, creationSource: 'web' as const,
    });
    const queue: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', { ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: '予定を調べて', attachments: [] } as TurnItem),
      event('message.updated', message('run-2', '次に請求書を')),
      event('run.created', queuedRun('run-2', 1)),
      event('message.updated', message('run-3', '最後に一覧を')),
      event('run.created', queuedRun('run-3', 2)),
    ];
    const transport = transportOf(queue);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    await screen.findByText('次に請求書を', {}, { timeout: 10_000 });
    expect(screen.getByText('最後に一覧を')).toBeTruthy();
    // A queued message is not among the conversation's messages yet.
    expect(screen.getAllByText(/次に請求書を/u)).toHaveLength(1);

    const [firstDown] = screen.getAllByRole('button', { name: 'ひとつ後へ' });
    await act(async () => {
      await user.click(firstDown as HTMLElement);
    });
    await waitFor(() => expect(transport.changeQueue).toHaveBeenCalledWith({ action: 'move', runId: 'run-2', beforeRunId: null }));
    const [, secondUp] = screen.getAllByRole('button', { name: 'ひとつ前へ' });
    await act(async () => {
      await user.click(secondUp as HTMLElement);
    });
    await waitFor(() => expect(transport.changeQueue).toHaveBeenCalledWith({ action: 'move', runId: 'run-3', beforeRunId: 'run-2' }));
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'キュー内のメッセージを削除' })[1] as HTMLElement);
    });
    await waitFor(() => expect(transport.changeQueue).toHaveBeenCalledWith({ action: 'remove', runId: 'run-3' }));
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: '今すぐ送信' })[0] as HTMLElement);
    });
    await waitFor(() => expect(transport.changeQueue).toHaveBeenCalledWith({ action: 'send', runId: 'run-2' }));

    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'キュー内のメッセージを編集' })[0] as HTMLElement);
    });
    const editor = await screen.findByTestId('composer-editor');
    await waitFor(() => expect(editor.textContent).toContain('次に請求書を'));
    // The composer took the words with its caret after them.
    await user.keyboard('（急ぎ）');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(transport.changeQueue).toHaveBeenCalledWith({ action: 'edit', runId: 'run-2', text: '次に請求書を（急ぎ）' }));
    expect(transport.send).not.toHaveBeenCalled();
  }, 30_000);
});

/** A conversation of its own, such as a subagent's, holding `items` answered by one finished run. */
const conversationOf = (id: string, items: readonly TurnItem[]): Projection => {
  const empty = emptyConversation();
  return {
    ...empty,
    thread: { ...empty.thread, id: ids.thread(id), title: '先月の請求を調べる' },
    runs: [{ ...run('running'), id: ids.run('run-child'), threadId: ids.thread(id), status: 'completed', completedAt: utc(AT + 2_000) }],
    turnItems: [...items],
    visibleTurnItems: items.map((entry, position) => ({ position, visibility: 'local', sourceThreadId: ids.thread(id), sourceItemId: entry.id, item: entry })),
  };
};

const userItem = (text: string): TurnItem => ({ ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text, attachments: [] } as TurnItem);
const toolItem = (id: string, ordinal: number, fields: Record<string, unknown>): TurnItem => ({ ...item, id: ids.item(id), ordinal, status: 'completed', type: 'dynamic_tool', toolName: 'mail.search', input: {}, ...fields } as TurnItem);

/** Lays every row out short, so the timeline, as tall as before, shows each row of a short answer. */
const shortRows = (): (() => void) => {
  const viewport = (element: Element): boolean => element.closest('.messages-timeline-scroll') === null || element.classList.contains('messages-timeline-scroll');
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return viewport(this) ? new DOMRect(0, 0, 800, 800) : new DOMRect(0, 0, 800, 40);
  };
  for (const name of ['offsetHeight', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return viewport(this) ? 800 : 40; } });
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    for (const name of ['offsetHeight', 'clientHeight'] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 800 });
    }
  };
};

/** Opens the call `itemId`, unfolding what a running answer is doing when the timeline folds it under 思考中. */
const openCall = async (user: ReturnType<typeof userEvent.setup>, container: HTMLElement, itemId: string): Promise<HTMLElement> => {
  const row = await waitFor(() => {
    const found = container.querySelector<HTMLElement>(`[data-work-entry-id="${itemId}"]`);
    if (found !== null) return found;
    container.querySelector<HTMLElement>('[data-timeline-row-kind="thinking"] button[aria-expanded="false"]')?.click();
    throw new Error(`${itemId} is not shown yet`);
  }, { timeout: 10_000 });
  const toggle = row.querySelector<HTMLElement>('[role="button"]') ?? row;
  // The timeline remembers which calls were open, across conversations.
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      await user.click(toggle);
    });
  }
  return row;
};

/** The ResizeObserver jsdom lacks, whose observers a test calls itself. */
class TestResizeObserver {
  static readonly observers: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.observers.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  static resize(target: Element, height: number): void {
    for (const observer of TestResizeObserver.observers) {
      if (!observer.targets.has(target)) continue;
      observer.callback([{ target, contentRect: new DOMRect(0, 0, 800, height) } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  }
}

describe('what the chat shows', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    vi.unstubAllGlobals();
    restore?.();
    restore = null;
  });

  it('ends the timeline with room for the composer as tall as it is now, however it grew', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(stoppedAnswer())} />);
    await screen.findByText('こんにちは。まず確認し', {}, { timeout: 10_000 });
    const overlay = container.querySelector('[data-chat-composer-overlay="true"]') as HTMLElement;
    const spacer = (): string | undefined => [...container.querySelectorAll<HTMLElement>('.messages-timeline-scroll div[aria-hidden="true"]')]
      .map((element) => element.style.height).find((height) => height !== '');

    await waitFor(() => expect(spacer()).toBe('800px'));
    // The composer grows without folding or unfolding: a queued message, a banner, a longer placeholder.
    overlay.getBoundingClientRect = () => new DOMRect(0, 0, 800, 236.4);
    act(() => TestResizeObserver.resize(overlay, 236.4));

    await waitFor(() => expect(spacer()).toBe('237px'));
  }, 30_000);

  it('shows the pictures an answer wrote inline, opening full size, and its other files as links by name', async () => {
    const answered: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', userItem('請求をまとめて')),
      event('turn-item.updated', {
        ...item, id: ids.item('answer-1'), ordinal: 1, status: 'completed', type: 'assistant_message', messageId: ids.message('answer-1'), text: 'まとめました。', streaming: false,
        attachments: [
          { type: 'image', id: ids.attachment('chart-1'), name: '内訳.png', mimeType: 'image/png', sizeBytes: 2_048 },
          { type: 'file', id: ids.attachment('pdf-1'), name: '請求一覧.pdf', mimeType: 'application/pdf', sizeBytes: 61_877 },
          { type: 'file', id: ids.attachment('csv-1'), name: '請求.csv', mimeType: 'text/csv', sizeBytes: 300 },
        ],
      } as TurnItem),
      event('run.updated', { ...run('running'), status: 'completed', completedAt: utc(AT + 2_000) }),
    ];
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(answered)} />);

    await screen.findByText('まとめました。', {}, { timeout: 10_000 });
    const files = container.querySelector('[data-answer-files="true"]') as HTMLElement;
    expect(files.querySelector('img')?.getAttribute('src')).toBe('https://orangeagent.test/files/chart-1');
    const pdf = screen.getByRole('link', { name: /請求一覧\.pdf/u });
    expect(pdf.getAttribute('href')).toBe('https://orangeagent.test/files/pdf-1');
    expect(pdf.getAttribute('target')).toBe('_blank');
    expect(pdf.textContent).toContain('PDF · 60.4 KB');
    const csv = screen.getByRole('link', { name: /請求\.csv/u });
    expect(csv.getAttribute('download')).toBe('請求.csv');
    expect(document.body.textContent).not.toContain('(empty response)');

    await act(async () => {
      await user.click(screen.getByRole('button', { name: '内訳.png を大きく表示' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://orangeagent.test/files/chart-1');
  }, 30_000);

  it('names each call in words and opens it to its arguments, its own name, and, when it failed, why, as an error', async () => {
    // The call alone: jsdom lays every row out as tall as the timeline, which shows the first.
    const failing: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', toolItem('tool-1', 1, { status: 'failed', input: { query: 'from:billing@example.co.jp' }, output: 'Gmail の読み取り権限が失効しています（401）。' })),
    ];
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    restore = shortRows();
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(failing)} />);

    await waitFor(() => expect(container.querySelector('[data-work-entry-id="tool-1"]') ?? container.querySelector('[data-timeline-row-kind="thinking"]')).not.toBeNull(), { timeout: 10_000 });
    // The tool's own name is the detail's alone; the row names it in words.
    expect(document.body.textContent).not.toContain('mail.search');
    const row = await openCall(user, container, 'tool-1');
    expect(row.textContent).toContain('メールを検索する');

    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toBe('エラーGmail の読み取り権限が失効しています（401）。');
    expect(failure.className).toContain('text-destructive');
    expect(container.textContent).toContain('from:billing@example.co.jp');
    expect(container.querySelector('[data-tool-name="true"]')?.textContent).toBe('ツール名 mail.search');
  }, 30_000);

  it('opens a failed call whose arguments were never kept, as a copied conversation holds it, to why it failed', async () => {
    const copied: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', toolItem('tool-1', 1, { status: 'failed', toolName: 'update_scheduled_event', title: 'カレンダーの予定を変える', output: 'Scheduled Event event-1 is not in this Account.' })),
    ];
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    restore = shortRows();
    const { container } = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(copied)} />);

    const opened = await openCall(user, container, 'tool-1');
    expect(opened.textContent).toContain('カレンダーの予定を変える');
    expect((await screen.findByRole('alert')).textContent).toContain('Scheduled Event event-1 is not in this Account.');
  }, 30_000);

  it('shows a subagent as its card, with its status and the calls it made, and opens its own conversation full screen on a phone and beside the conversation on a wide screen', async () => {
    const child = conversationOf('thread-child', [
      { ...userItem('先月の請求を調べて'), threadId: ids.thread('thread-child'), runId: ids.run('run-child') } as TurnItem,
      { ...toolItem('child-tool-1', 1, { toolName: 'drive.search', input: { query: '請求書' } }), threadId: ids.thread('thread-child'), runId: ids.run('run-child') } as TurnItem,
      { ...toolItem('child-tool-2', 2, { toolName: 'drive.read', input: { fileId: 'f-1' } }), threadId: ids.thread('thread-child'), runId: ids.run('run-child') } as TurnItem,
      { ...item, threadId: ids.thread('thread-child'), runId: ids.run('run-child'), id: ids.item('child-answer'), ordinal: 3, status: 'completed', type: 'assistant_message', messageId: ids.message('child-answer'), text: '請求は3件です。', streaming: false } as TurnItem,
    ]);
    const delegating: DomainEvent[] = [
      event('run.created', run('running')),
      event('turn-item.updated', userItem('先月の請求をまとめて')),
      event('turn-item.updated', {
        ...item, id: ids.item('subagent-1'), ordinal: 1, status: 'completed', title: '先月の請求を調べる', type: 'subagent', subagentId: ids.node('node-1'),
        origin: 'provider_native', driver: 'orangeagent', providerInstanceId: ids.provider('orangeagent'), childThreadId: ids.thread('thread-child'),
        prompt: '先月の請求を調べて', result: '請求は3件です。',
      } as TurnItem),
    ];
    const open = async (wide: boolean): Promise<HTMLElement> => {
      window.matchMedia = (query: string) => ({
        matches: wide && query.includes('min-width: 768px'), media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      });
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const view = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(delegating, WITHOUT_DECIDER, { 'thread-child': child })} />);
      const status = await waitFor(() => {
        const found = view.container.querySelector('[data-subagent-status="true"]');
        if (found?.textContent !== '完了 · ツール 2 回') throw new Error(`status reads ${found?.textContent ?? 'nothing'}`);
        return found;
      }, { timeout: 10_000 });
      await act(async () => {
        await user.click(status.closest('button') as HTMLElement);
      });
      const panel = await screen.findByRole('complementary', { name: 'サブエージェント：先月の請求を調べる' });
      expect(panel.textContent).toContain('サブエージェント · 完了 · ツール 2 回');
      await waitFor(() => expect(panel.textContent).toContain('請求は3件です。'));
      return panel;
    };

    try {
      expect((await open(false)).getAttribute('data-subagent-panel')).toBe('full');
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      await act(async () => {
        await user.click(screen.getByRole('button', { name: '会話に戻る' }));
      });
      expect(screen.queryByRole('complementary')).toBeNull();
      cleanup();
      expect((await open(true)).getAttribute('data-subagent-panel')).toBe('side');
    } finally {
      window.matchMedia = (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      });
    }
  }, 60_000);

  it('rewrites an earlier message in the composer and asks it again in its place, saying what follows', async () => {
    const transport = transportOf(completedAnswer());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    await screen.findByText('表にしました。', {}, { timeout: 10_000 });
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'ここから編集し直す' })[0] as HTMLElement);
    });
    const notice = await waitFor(() => {
      const found = document.querySelector('[data-chat-rewinding]');
      if (found === null) throw new Error('not rewriting yet');
      return found;
    });
    expect(notice.textContent).toContain('このメッセージから後のやり取りは取り消され');
    const editor = await screen.findByTestId('composer-editor');
    await waitFor(() => expect(editor.textContent).toContain('請求を表にして'));
    // The caret is put after the words, so what is typed follows them.
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
    await user.keyboard('（先月分）');
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    await waitFor(() => expect(transport.rewind).toHaveBeenCalledWith('message-1', '請求を表にして（先月分）', { drop: [], files: [] }));
    expect(transport.send).not.toHaveBeenCalled();
    expect(document.querySelector('[data-chat-rewinding]')).toBeNull();
  }, 30_000);

  it('shows the files of a message being rewritten in the composer, each removable, and sends those kept with any added', async () => {
    const [created, , ...rest] = completedAnswer();
    const withPhoto = event('turn-item.updated', {
      ...item, id: ids.item('message-1'), ordinal: 0, status: 'completed', createdBy: 'user', creationSource: 'web', type: 'user_message', messageId: ids.message('message-1'), inputIntent: 'turn_start', text: 'この写真を表にして',
      attachments: [
        { type: 'image', id: ids.attachment('photo-1'), name: 'photo.png', mimeType: 'image/png', sizeBytes: 8 },
        { type: 'file', id: ids.attachment('csv-1'), name: '明細.csv', mimeType: 'text/csv', sizeBytes: 16 },
      ],
    } as TurnItem);
    const transport = transportOf([created as DomainEvent, withPhoto, ...rest]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    await screen.findByText('表にしました。', {}, { timeout: 10_000 });
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'ここから編集し直す' })[0] as HTMLElement);
    });
    // The files it was sent with are in the composer, as files about to be sent are.
    const remove = await screen.findByRole('button', { name: 'photo.png を削除' });
    expect(screen.getByRole('button', { name: '明細.csv を削除' })).toBeTruthy();
    expect(document.querySelector('[data-chat-rewinding]')?.textContent).toContain('外すことも足すこともできます');
    await act(async () => {
      await user.click(remove);
    });
    expect(screen.queryByRole('button', { name: 'photo.png を削除' })).toBeNull();
    const added = new File(['19:00 開始'], 'memo.txt', { type: 'text/plain' });
    await act(async () => {
      await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, added);
    });
    await waitFor(() => expect(document.body.textContent).toContain('memo.txt'));
    await user.click(await screen.findByTestId('composer-editor'));
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    await waitFor(() => expect(transport.rewind).toHaveBeenCalled());
    const [messageId, text, options] = transport.rewind.mock.calls[0] as [string, string, { drop: string[]; files: File[] }];
    expect([messageId, options.drop, options.files.map((file) => file.name)]).toEqual(['message-1', ['photo-1'], ['memo.txt']]);
    expect(text).toContain('この写真を表にして');
    expect(transport.send).not.toHaveBeenCalled();
  }, 30_000);

  it('continues the conversation from an answer as a new one, and opens it', async () => {
    const transport = transportOf(completedAnswer());
    const opened = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} onOpenThread={opened} />);

    await screen.findByText('表にしました。', {}, { timeout: 10_000 });
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'ここから新しい会話で続ける' })[0] as HTMLElement);
    });

    await waitFor(() => expect(opened).toHaveBeenCalledWith('thread-forked'));
    expect(transport.fork).toHaveBeenCalledWith('run-1');
  }, 30_000);

  it('offers the models the server names beside the approval mode by name, and sends the one chosen unless it is the default', async () => {
    const chosen: string[] = [];
    const manage = vi.fn();
    const transport = { ...transportOf(), capabilities: async () => ({ models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-4.1'], efforts: {}, drivePicker: false }), chosenModel: () => null, chooseModel: (model: string) => chosen.push(model) };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} onManageModels={manage} />);

    const choice = await screen.findByRole('button', { name: '答えるモデル: Claude Sonnet 5.5' }, { timeout: 10_000 });
    expect(choice.textContent).toContain('Sonnet 5.5');
    await act(async () => {
      await user.click(choice);
    });
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['Claude Sonnet 5.5既定claude-sonnet-5-5', 'Claude Opus 5.5claude-opus-5-5', 'gpt-4.1']);
    await act(async () => {
      await user.click(options[1] as HTMLElement);
    });
    expect(chosen).toEqual(['claude-opus-5-5']);
    await screen.findByRole('button', { name: '答えるモデル: Claude Opus 5.5' });
    const editor = await screen.findByTestId('composer-editor');
    await user.click(editor);
    await user.keyboard('急ぎで');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith('急ぎで', { delivery: 'steer', files: [], model: 'claude-opus-5-5' }));
    // With one model the control still says which answers, and leads to where more are added.
    cleanup();
    forgetThreads();
    render(<ChatSurface threadId={THREAD_ID} transport={{ ...transportOf(), capabilities: async () => ({ models: ['claude-haiku-5-5'], efforts: {}, drivePicker: false }) }} onManageModels={manage} />);
    const only = await screen.findByRole('button', { name: '答えるモデル: Claude Haiku 5.5' }, { timeout: 10_000 });
    await act(async () => {
      await user.click(only);
    });
    await act(async () => {
      await user.click(await screen.findByRole('menuitem', { name: 'ほかのモデルを追加' }));
    });
    expect(manage).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('offers the levels of effort the chosen model takes, and sends the one chosen unless it is the model\'s default', async () => {
    const chosen: string[] = [];
    const transport = {
      ...transportOf(),
      capabilities: async () => ({
        models: ['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-5.5', 'gpt-4.1'],
        efforts: {
          'claude-opus-5-5': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
          'claude-haiku-5-5': { levels: ['low', 'medium', 'high'], default: 'high' },
          'gpt-5.5': { levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: null },
        },
        drivePicker: false,
      } satisfies ChatCapabilities),
      chosenModel: () => null,
      chooseModel: () => undefined,
      chosenEffort: () => null,
      chooseEffort: (effort: ModelEffort) => {
        chosen.push(effort);
      },
    };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);
    const send = async (text: string): Promise<void> => {
      await user.click(await screen.findByTestId('composer-editor'));
      await user.keyboard(text);
      await act(async () => {
        await user.keyboard('{Enter}');
      });
    };

    // Until a level is chosen, the model thinks at its own default, which is named as chosen.
    const choice = await screen.findByRole('button', { name: '考える深さ: 高い' }, { timeout: 10_000 });
    await act(async () => {
      await user.click(choice);
    });
    const levels = await screen.findAllByRole('menuitemradio');
    expect(levels.map((level) => level.textContent)).toEqual(['低い', 'ふつう', '高い既定', 'とても高い', '最大']);
    await act(async () => {
      await user.click(levels[4] as HTMLElement);
    });
    expect(chosen).toEqual(['max']);
    await screen.findByRole('button', { name: '考える深さ: 最大' });
    await send('よく考えて');
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith('よく考えて', { delivery: 'steer', files: [], effort: 'max' }));

    // A model that does not take the level chosen thinks at its default.
    await act(async () => {
      await user.click(screen.getByRole('button', { name: '答えるモデル: Claude Opus 5.5' }));
    });
    await act(async () => {
      await user.click(await screen.findByRole('menuitemradio', { name: /Haiku/u }));
    });
    await screen.findByRole('button', { name: '考える深さ: 高い' });
    // A model whose default is not known reads 既定 until a level is chosen, and marks none in its menu.
    await act(async () => {
      await user.click(await screen.findByRole('menuitemradio', { name: /gpt-5\.5/u }));
    });
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    await act(async () => {
      await user.click(await screen.findByRole('button', { name: '考える深さ: 既定' }));
    });
    const gpt = await screen.findAllByRole('menuitemradio');
    expect(gpt.map((level) => level.textContent)).toEqual(['考えない', '低い', 'ふつう', '高い', 'とても高い']);
    await act(async () => {
      await user.click(gpt[0] as HTMLElement);
    });
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    await send('すぐに');
    await waitFor(() => expect(transport.send).toHaveBeenLastCalledWith('すぐに', { delivery: 'steer', files: [], model: 'gpt-5.5', effort: 'none' }));

    // A model that takes no level offers no choice.
    await act(async () => {
      await user.click(screen.getByRole('button', { name: '答えるモデル: gpt-5.5' }));
    });
    await act(async () => {
      await user.click(await screen.findByRole('menuitemradio', { name: /gpt-4\.1/u }));
    });
    await screen.findByRole('button', { name: '答えるモデル: gpt-4.1' });
    expect(screen.queryByRole('button', { name: /考える深さ/u })).toBeNull();
  }, 30_000);

  it('attaches a file picked in Drive beside the clip, where Google Picker is configured', async () => {
    const picked = new File(['%PDF-1.4'], '議事録.pdf', { type: 'application/pdf' });
    const transport = { ...transportOf(), capabilities: async () => ({ models: [], efforts: {}, drivePicker: true }), pickDriveFiles: vi.fn(async () => [picked]) };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    const drive = await screen.findByRole('button', { name: 'Drive から添付' }, { timeout: 10_000 });
    await act(async () => {
      await user.click(drive);
    });
    await waitFor(() => expect(document.body.textContent).toContain('議事録.pdf'));
    const editor = await screen.findByTestId('composer-editor');
    await user.click(editor);
    await user.keyboard('読んで');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(transport.send).toHaveBeenCalled());
    const [, options] = transport.send.mock.calls[0] as [string, { files: File[] }];
    expect(options.files.map((file) => file.name)).toEqual(['議事録.pdf']);

    cleanup();
    forgetThreads();
    render(<ChatSurface threadId={THREAD_ID} transport={{ ...transportOf(), capabilities: async () => ({ models: [], efforts: {}, drivePicker: false }), pickDriveFiles: async () => [picked] }} />);
    await screen.findByTestId('composer-editor', {}, { timeout: 10_000 });
    expect(screen.queryByRole('button', { name: 'Drive から添付' })).toBeNull();
  }, 30_000);

  it('saves an answer\'s file to Drive, in a folder chosen where Picker is configured, and links to it once saved', async () => {
    const saveToDrive = vi.fn(async () => ({ url: 'https://drive.google.com/file/d/saved' }));
    const transport = { ...transportOf(completedAnswer()), capabilities: async () => ({ models: [], efforts: {}, drivePicker: true }), saveToDrive };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ChatSurface threadId={THREAD_ID} transport={transport} />);

    const choose = await screen.findByRole('button', { name: '請求一覧.pdf の保存先を選ぶ' }, { timeout: 10_000 });
    await act(async () => {
      await user.click(choose);
    });

    await waitFor(() => expect(saveToDrive).toHaveBeenCalledWith('pdf-1', true));
    const link = await screen.findByRole('link', { name: 'Drive で開く' });
    expect(link.getAttribute('href')).toBe('https://drive.google.com/file/d/saved');
  }, 30_000);
  it('says under an answer what it read and wrote, and in the composer how much context the conversation holds, only where the answer recorded it', async () => {
    const usage: NonNullable<Run['usage']> = {
      requests: 4, inputTokens: 12_300, cachedInputTokens: 10_455, cacheWriteTokens: 900, outputTokens: 1_200,
      firstInputTokens: 9_000, firstCachedInputTokens: 6_300, contextTokens: 14_000, maxContextTokens: 200_000,
    };
    const recorded = completedAnswer().map((domainEvent) => domainEvent.type === 'run.updated' ? event('run.updated', { ...run('completed'), usage }) : domainEvent);
    const view = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(recorded)} />);

    await waitFor(() => expect(document.querySelector('[data-run-usage="true"]')?.textContent).toBe('入力 12k・キャッシュ 85%（前の会話 70%）・出力 1.2k・リクエスト 4回'), { timeout: 10_000 });
    const meter = document.querySelector('[data-chat-composer-context-meter="true"]');
    expect(meter?.textContent).toContain('7%');
    expect(meter?.getAttribute('aria-label')).toBe('コンテキスト: 200,000 トークン中 14,000（7%）');
    view.unmount();
    forgetThreads();

    // A priced answer adds its cost to its line, and the composer the chat's.
    const priced = completedAnswer().map((domainEvent) => domainEvent.type === 'run.updated' ? event('run.updated', { ...run('completed'), usage: { ...usage, costUsd: 0.0123, costBilled: false } }) : domainEvent);
    const pricedView = render(<ChatSurface threadId={THREAD_ID} transport={transportOf(priced)} />);
    await waitFor(() => expect(document.querySelector('[data-run-usage="true"]')?.textContent).toBe('入力 12k・キャッシュ 85%（前の会話 70%）・出力 1.2k・リクエスト 4回・費用 $0.012'), { timeout: 10_000 });
    expect(document.querySelector('[data-chat-cost="true"]')?.textContent).toBe('$0.012');
    expect(document.querySelector('[data-chat-composer-context-meter="true"]')?.getAttribute('aria-label')).toContain('このチャット: $0.012（定価からの推計）');
    pricedView.unmount();
    forgetThreads();

    // An answer written before usage was recorded shows neither.
    render(<ChatSurface threadId={THREAD_ID} transport={transportOf(completedAnswer())} />);
    await screen.findByText('表にしました。', {}, { timeout: 10_000 });
    expect(document.querySelector('[data-run-usage="true"]')).toBeNull();
    expect(document.querySelector('[data-chat-composer-context-meter="true"]')).toBeNull();
  }, 45_000);
});
