/**
 * How Operator Chat (ADR 0201) reaches a conversation's Durable
 * Object: its frames arrive over a WebSocket, and what the person does — a
 * message, a stop — is sent over HTTP. A socket that closes is opened again
 * after the last sequence this page saw, sooner when the page comes back into
 * view or online, so the object sends only what the page missed, or a
 * snapshot when it cannot.
 *
 * The page tells the object over the socket whether the conversation is in
 * view, as the socket opens and whenever that changes, so the member is not
 * notified of what its answers do while they are looking at it (the Worker's
 * notices.ts). A socket the object closes because the conversation was
 * deleted is not opened again.
 *
 * The model chosen to answer, and the level of effort, are remembered in this
 * browser for the Account, as the chat before ADR 0201 remembered the model; Google Picker chooses the Drive
 * files attached and the folder a file is saved in (picker.ts).
 */

import { CHAT_THREAD_GONE, isModelEffort, type ChatApproval, type ChatDrivePicker, type ModelEffort } from '@mail/domain';
import type { ChatDecision, ChatStarterSource, ChatTransport } from '@mail/t3chat';

import { api } from './api';
import { chooseDriveFiles, chooseDriveFolder, type PickedDocument } from './picker';
import { prepareFiles } from './photos';

/** How long a closed socket waits before it is opened again: doubling from the first to the last. */
export const RECONNECT_MS = { first: 1_000, last: 15_000 } as const;

/** The sequence a frame brings the conversation to, read without decoding the rest of it. */
export const sequenceOf = (frame: string): number | null => {
  try {
    const item = JSON.parse(frame) as { kind?: unknown; sequence?: unknown; snapshotSequence?: unknown };
    if (item.kind === 'event' && typeof item.sequence === 'number') return item.sequence;
    if (item.kind === 'snapshot' && typeof item.snapshotSequence === 'number') return item.snapshotSequence;
    return null;
  } catch {
    return null;
  }
};

/** The answer the Worker takes for each of t3code's decisions: once, always for the Account, or not. */
export const approvalOf = (decision: ChatDecision): ChatApproval =>
  decision === 'acceptAlways' ? 'acceptAlways' : decision === 'accept' || decision === 'acceptForSession' ? 'accept' : 'decline';

/** What the transport needs of the browser, so a test can stand in for it. */
export interface Surroundings {
  open: (url: string) => WebSocket;
  later: (ms: number, act: () => void) => () => void;
  /** Calls `act` when the page comes back into view or online; returns what stops it. */
  onReturn: (act: () => void) => () => void;
  /** Whether the page is in view now. */
  visible?: () => boolean;
  /** Calls `act` whenever the page comes into view or leaves it; returns what stops it. */
  onVisibility?: (act: (visible: boolean) => void) => () => void;
  /** Asks the person, in Google Picker, for the Drive folder a file is saved in; null when they chose none. */
  chooseDriveFolder: (picker: ChatDrivePicker) => Promise<PickedDocument | null>;
  /** Asks the person, in Google Picker, for the Drive files they attach. */
  chooseDriveFiles: (picker: ChatDrivePicker) => Promise<PickedDocument[]>;
}

/** What the page says over a conversation's socket: whether the conversation is in view. */
export const visibilityFrame = (visible: boolean): string => JSON.stringify({ kind: 'visibility', visible });

const browser = (): Surroundings => ({
  open: (url) => new WebSocket(url),
  chooseDriveFolder,
  chooseDriveFiles,
  later: (ms, act) => {
    const timer = window.setTimeout(act, ms);
    return () => window.clearTimeout(timer);
  },
  onReturn: (act) => {
    const visible = (): void => {
      if (document.visibilityState === 'visible') act();
    };
    window.addEventListener('online', act);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', act);
      document.removeEventListener('visibilitychange', visible);
    };
  },
  visible: () => document.visibilityState === 'visible',
  onVisibility: (act) => {
    const changed = (): void => act(document.visibilityState === 'visible');
    // A page being left says so before its socket closes.
    const left = (): void => act(false);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('pagehide', left);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('pagehide', left);
    };
  },
});

/** Every file id a conversation's answers name, read as the address that serves it. */
class FileUrls extends Map<string, string> {
  constructor(private readonly url: (fileId: string) => string) {
    super();
  }

  override get(fileId: string): string {
    return this.url(fileId);
  }

  override has(): boolean {
    return true;
  }
}

/** Where this browser remembers the model last chosen for an Account's messages. */
const modelKey = (accountId: string): string => `orangeagent:chat-model:${accountId}`;

/** The model this browser last chose for the Account; a browser that keeps nothing remembers none. */
export const rememberedModel = (accountId: string): string | null => {
  try {
    return window.localStorage.getItem(modelKey(accountId));
  } catch {
    return null;
  }
};

export const rememberModel = (accountId: string, model: string): void => {
  try {
    window.localStorage.setItem(modelKey(accountId), model);
  } catch {
    // A browser that keeps nothing still sends with the model chosen until the screen is left.
  }
};

/** Where this browser remembers the level of effort last chosen for an Account's messages. */
const effortKey = (accountId: string): string => `orangeagent:chat-effort:${accountId}`;

/** The level of effort this browser last chose for the Account; a browser that keeps nothing, or keeps no level, remembers none. */
export const rememberedEffort = (accountId: string): ModelEffort | null => {
  try {
    const kept = window.localStorage.getItem(effortKey(accountId));
    return isModelEffort(kept) ? kept : null;
  } catch {
    return null;
  }
};

export const rememberEffort = (accountId: string, effort: ModelEffort): void => {
  try {
    window.localStorage.setItem(effortKey(accountId), effort);
  } catch {
    // A browser that keeps nothing still sends with the level chosen until the screen is left.
  }
};

/** What a conversation and the box a conversation starts from offer alike: the models a message may be answered by, the one this browser chose, and Drive files to attach. */
const choicesOf = (accountId: string, surroundings: Surroundings): Omit<ChatStarterSource, 'start'> => ({
  capabilities: () => api.chatCapabilities(accountId),
  chosenModel: () => rememberedModel(accountId),
  chooseModel: (model) => rememberModel(accountId, model),
  chosenEffort: () => rememberedEffort(accountId),
  chooseEffort: (effort) => rememberEffort(accountId, effort),
  pickDriveFiles: async () => {
    const picker = await api.chatDrivePicker(accountId);
    if (!picker) throw new Error('Drive からの添付は設定されていません。');
    const picked = await surroundings.chooseDriveFiles(picker);
    return Promise.all(picked.map((document) => api.chatDriveFile(accountId, document.id)));
  },
});

/** What the box a conversation starts from reads and remembers for one Account, starting a conversation with `start`. */
export const createStarterSource = (input: { accountId: string; start: ChatStarterSource['start']; surroundings?: Surroundings }): ChatStarterSource => ({
  ...choicesOf(input.accountId, input.surroundings ?? browser()),
  start: input.start,
});

/** The transport of one conversation of one Account. */
export const createThreadTransport = (input: { accountId: string; threadId: string; surroundings?: Surroundings }): ChatTransport => {
  const { accountId, threadId } = input;
  const surroundings = input.surroundings ?? browser();

  /** Tells the object whether the conversation is in view, once the socket is open; a closed socket says nothing. */
  const tell = (socket: WebSocket, visible: boolean): void => {
    if (socket.readyState !== 1) return;
    try {
      socket.send(visibilityFrame(visible));
    } catch {
      // A socket closing as it is told is opened again, and says so then.
    }
  };

  const subscribe = (subscribed: string, afterSequence: number, onFrame: (frame: string) => void): (() => void) => {
    let last = afterSequence;
    let socket: WebSocket | null = null;
    let wait: number = RECONNECT_MS.first;
    let cancelRetry: (() => void) | null = null;
    let stopped = false;

    const connect = (): void => {
      cancelRetry?.();
      cancelRetry = null;
      if (stopped || socket) return;
      const opened = surroundings.open(api.chatThreadStreamUrl(accountId, subscribed, last));
      socket = opened;
      opened.onopen = () => tell(opened, surroundings.visible?.() ?? true);
      opened.onmessage = (message: MessageEvent) => {
        if (typeof message.data !== 'string') return;
        const sequence = sequenceOf(message.data);
        if (sequence !== null) last = sequence;
        wait = RECONNECT_MS.first;
        onFrame(message.data);
      };
      opened.onclose = (closed?: CloseEvent) => {
        if (socket === opened) socket = null;
        // A deleted conversation has nothing more to send.
        if (closed?.code === CHAT_THREAD_GONE) stopped = true;
        if (stopped) return;
        cancelRetry = surroundings.later(wait, connect);
        wait = Math.min(wait * 2, RECONNECT_MS.last);
      };
      opened.onerror = () => opened.close();
    };

    const stopReturn = surroundings.onReturn(() => {
      if (!socket) connect();
    });
    const stopVisibility = surroundings.onVisibility?.((visible) => {
      if (socket) tell(socket, visible);
    }) ?? (() => undefined);
    connect();
    return () => {
      stopped = true;
      cancelRetry?.();
      stopReturn();
      stopVisibility();
      socket?.close(1000, 'closed');
      socket = null;
    };
  };

  return {
    subscribe,
    respond: async (requestId, decision, feedback) => {
      const answered = await api.answerChatThreadApproval(accountId, threadId, { requestId, decision: approvalOf(decision), ...(feedback ? { feedback } : {}) });
      if (!answered.accepted) throw new Error('この確認にはもう答えられません。画面を開き直してください。');
    },
    modes: async () => (await api.chatThreadModes(accountId, threadId)).modes,
    setMode: async (mode) => {
      await api.setChatThreadMode(accountId, threadId, { mode });
    },
    send: async (text, options = {}) => {
      const files = await prepareFiles(options.files ?? []);
      const sent = await api.sendChatThreadMessage(accountId, threadId, { text, ...(options.delivery ? { delivery: options.delivery } : {}), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) }, files);
      if (!sent.accepted) throw new Error('メッセージを送れませんでした。もう一度送ってください。');
    },
    rewind: async (messageId, text, options = {}) => {
      const files = await prepareFiles(options.files ?? []);
      const rewound = await api.rewindChatThread(accountId, threadId, {
        messageId, text, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), ...(options.drop?.length ? { drop: [...options.drop] } : {}),
      }, files);
      if (!rewound.accepted) throw new Error('答えを書いている間や、確認を待っている間は編集し直せません。止めてからもう一度どうぞ。');
    },
    fork: async (runId) => (await api.forkChatThread(accountId, threadId, runId)).id,
    suggestion: () => api.chatThreadSuggestion(accountId, threadId),
    ...choicesOf(accountId, surroundings),
    saveToDrive: async (fileId, choose) => {
      let folderId: string | undefined;
      if (choose) {
        const picker = await api.chatDrivePicker(accountId);
        if (!picker) throw new Error('保存先を選ぶ機能は設定されていません。「Drive に保存」で AI に聞く フォルダに保存してください。');
        const folder = await surroundings.chooseDriveFolder(picker);
        if (!folder) return null;
        folderId = folder.id;
      }
      const saved = await api.saveChatFileToDrive(accountId, threadId, fileId, folderId ? { folderId } : {});
      return { url: saved.url };
    },
    changeQueue: async (change) => {
      const changed = await api.changeChatThreadQueue(accountId, threadId, change);
      if (!changed.accepted) throw new Error('このメッセージはもう待っていません。');
    },
    interrupt: async () => {
      await api.interruptChatThread(accountId, threadId);
    },
    attachmentUrls: new FileUrls((fileId) => api.chatThreadFileUrl(accountId, threadId, fileId)),
  };
};
