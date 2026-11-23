import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { fakeApi } from './fake';
import { createThreadTransport, RECONNECT_MS, sequenceOf, type Surroundings } from './threads';

fakeApi();

/** What the person picks in Google Picker, which each test says. */
const chooseDriveFolder = vi.fn<Surroundings['chooseDriveFolder']>();
const chooseDriveFiles = vi.fn<Surroundings['chooseDriveFiles']>();

/** The sockets a transport opens and the timers it sets, driven by the test. */
const surroundings = () => {
  const sockets: Array<{ url: string; socket: WebSocket; closed: boolean; sent: string[] }> = [];
  let inView = true;
  let seen: ((visible: boolean) => void) | null = null;
  const timers: Array<{ ms: number; act: () => void; cancelled: boolean }> = [];
  let returned: (() => void) | null = null;
  const value: Surroundings = {
    chooseDriveFolder,
    chooseDriveFiles,
    open: (url) => {
      const entry = { url, socket: {} as WebSocket, closed: false, sent: [] as string[] };
      const socket = {
        onmessage: null, onclose: null, onerror: null, onopen: null, readyState: 0,
        send: (frame: string) => {
          entry.sent.push(frame);
        },
        close: () => {
          if (entry.closed) return;
          entry.closed = true;
          (socket.onclose as (() => void) | null)?.();
        },
      };
      entry.socket = socket as unknown as WebSocket;
      sockets.push(entry);
      return entry.socket;
    },
    later: (ms, act) => {
      const timer = { ms, act, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    onReturn: (act) => {
      returned = act;
      return () => { returned = null; };
    },
    visible: () => inView,
    onVisibility: (act) => {
      seen = act;
      return () => { seen = null; };
    },
  };
  /** The socket at `index` opens, as the browser opens it. */
  const open = (index: number): void => {
    const socket = sockets[index]?.socket as unknown as { readyState: number; onopen: (() => void) | null } | undefined;
    if (!socket) return;
    socket.readyState = 1;
    socket.onopen?.();
  };
  const look = (visible: boolean): void => {
    inView = visible;
    seen?.(visible);
  };
  const receive = (index: number, frame: unknown): void => {
    sockets[index]?.socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  };
  const runTimers = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.act();
  };
  return { value, sockets, timers, receive, runTimers, open, look, comeBack: () => returned?.() };
};

describe('the Operator Chat transport', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.chatThreadStreamUrl).mockImplementation((accountId, threadId, after) => `wss://gui.test/${accountId}/${threadId}?afterSequence=${after}`);
    vi.mocked(api.chatThreadFileUrl).mockImplementation((accountId, threadId, fileId) => `/files/${accountId}/${threadId}/${fileId}`);
  });

  it('reads the sequence a frame brings the conversation to', () => {
    expect(sequenceOf(JSON.stringify({ kind: 'snapshot', snapshotSequence: 7, projection: {} }))).toBe(7);
    expect(sequenceOf(JSON.stringify({ kind: 'event', sequence: 8, event: {} }))).toBe(8);
    expect(sequenceOf(JSON.stringify({ kind: 'synchronized' }))).toBeNull();
    expect(sequenceOf('not json')).toBeNull();
  });

  it('hands every frame on and opens the socket again after the last sequence it saw, waiting longer each time', () => {
    const world = surroundings();
    const frames: string[] = [];
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: world.value });

    transport.subscribe('thread-1', 0, (frame) => frames.push(frame));
    world.receive(0, { kind: 'snapshot', snapshotSequence: 3 });
    world.receive(0, { kind: 'synchronized' });
    world.receive(0, { kind: 'event', sequence: 4 });
    world.sockets[0]?.socket.close();

    expect(frames).toHaveLength(3);
    expect(world.timers.map((timer) => timer.ms)).toEqual([RECONNECT_MS.first]);
    world.runTimers();
    expect(world.sockets.map((entry) => entry.url)).toEqual(['wss://gui.test/org-1/thread-1?afterSequence=0', 'wss://gui.test/org-1/thread-1?afterSequence=4']);

    world.sockets[1]?.socket.close();
    world.runTimers();
    world.sockets[2]?.socket.close();
    expect(world.timers.map((timer) => timer.ms)).toEqual([RECONNECT_MS.first * 4]);
  });

  it('tells the conversation\'s object whether it is in view, as the socket opens and whenever that changes', () => {
    const world = surroundings();
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: world.value });
    const stop = transport.subscribe('thread-1', 0, () => undefined);

    // Nothing is said before the socket is open.
    world.look(false);
    expect(world.sockets[0]?.sent).toEqual([]);
    world.open(0);
    world.look(true);
    world.look(false);
    expect(world.sockets[0]?.sent.map((frame) => JSON.parse(frame) as unknown)).toEqual([
      { kind: 'visibility', visible: false }, { kind: 'visibility', visible: true }, { kind: 'visibility', visible: false },
    ]);

    // A socket opened again says where the page stands then.
    world.sockets[0]?.socket.close();
    world.runTimers();
    world.open(1);
    expect(world.sockets[1]?.sent).toEqual([JSON.stringify({ kind: 'visibility', visible: false })]);

    stop();
    world.look(true);
    expect(world.sockets[1]?.sent).toHaveLength(1);
  });

  it('opens the socket at once when the page comes back, and never once it is stopped', () => {
    const world = surroundings();
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: world.value });
    const stop = transport.subscribe('thread-1', 5, () => undefined);
    world.sockets[0]?.socket.close();

    world.comeBack();
    expect(world.sockets.map((entry) => entry.url)).toEqual(['wss://gui.test/org-1/thread-1?afterSequence=5', 'wss://gui.test/org-1/thread-1?afterSequence=5']);
    // The wait it had set is cancelled, so the socket is not opened twice.
    world.runTimers();
    expect(world.sockets).toHaveLength(2);

    stop();
    expect(world.sockets[1]?.closed).toBe(true);
    world.runTimers();
    world.comeBack();
    expect(world.sockets).toHaveLength(2);
  });

  it('sends a message and a stop over HTTP, and says so when a message was not taken', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValueOnce({ threadId: 'thread-1', accepted: true }).mockResolvedValueOnce({ threadId: 'thread-1', accepted: false });
    vi.mocked(api.interruptChatThread).mockResolvedValue({ threadId: 'thread-1', accepted: true });

    const photo = new File(['PNG'], '写真.png', { type: 'image/png' });

    await transport.send('今日の予定は？', { delivery: 'queue', files: [photo] });
    await expect(transport.send('もう一つ')).rejects.toThrow('送れませんでした');
    await transport.interrupt();

    expect(api.sendChatThreadMessage).toHaveBeenNthCalledWith(1, 'org-1', 'thread-1', { text: '今日の予定は？', delivery: 'queue' }, [photo]);
    expect(api.sendChatThreadMessage).toHaveBeenNthCalledWith(2, 'org-1', 'thread-1', { text: 'もう一つ' }, []);
    expect(api.interruptChatThread).toHaveBeenCalledWith('org-1', 'thread-1');
  });

  it('changes a queued message over HTTP, and says so when it is no longer queued', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.changeChatThreadQueue).mockResolvedValueOnce({ threadId: 'thread-1', accepted: true }).mockResolvedValueOnce({ threadId: 'thread-1', accepted: false });

    await transport.changeQueue({ action: 'move', runId: 'run-2', beforeRunId: 'run-1' });
    await expect(transport.changeQueue({ action: 'remove', runId: 'run-2' })).rejects.toThrow('もう待っていません');

    expect(api.changeChatThreadQueue).toHaveBeenCalledWith('org-1', 'thread-1', { action: 'move', runId: 'run-2', beforeRunId: 'run-1' });
  });

  it('reads the approval modes the Worker offers the conversation', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.chatThreadModes).mockResolvedValue({ modes: ['read_only', 'ask', 'unrestricted'] });

    expect(await transport.modes()).toEqual(['read_only', 'ask', 'unrestricted']);
    expect(api.chatThreadModes).toHaveBeenCalledWith('org-1', 'thread-1');
  });

  it('reads every file an answer names at the address that serves it', () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });

    expect(transport.attachmentUrls?.get('file-1')).toBe('/files/org-1/thread-1/file-1');
  });

  it('opens no socket again once the object says the conversation was deleted', () => {
    const world = surroundings();
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: world.value });
    transport.subscribe('thread-1', 0, () => undefined);

    (world.sockets[0]?.socket.onclose as ((closed: { code: number }) => void) | null)?.({ code: 4404 });
    world.runTimers();
    world.comeBack();

    expect(world.sockets).toHaveLength(1);
    expect(world.timers).toEqual([]);
  });

  it('sends the model chosen with a message and a rewritten one, and remembers it in this browser for the Account', async () => {
    window.localStorage.clear();
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-1', accepted: true });
    vi.mocked(api.rewindChatThread).mockResolvedValueOnce({ threadId: 'thread-1', accepted: true }).mockResolvedValueOnce({ threadId: 'thread-1', accepted: false });

    expect(transport.chosenModel?.()).toBeNull();
    transport.chooseModel?.('model-b');
    await transport.send('急ぎで', { model: 'model-b' });
    await transport.rewind('message-1', '直した', { model: 'model-b' });
    await expect(transport.rewind('message-1', '直した')).rejects.toThrow('編集し直せません');

    expect(createThreadTransport({ accountId: 'org-1', threadId: 'thread-2', surroundings: surroundings().value }).chosenModel?.()).toBe('model-b');
    expect(createThreadTransport({ accountId: 'org-2', threadId: 'thread-3', surroundings: surroundings().value }).chosenModel?.()).toBeNull();
    expect(api.sendChatThreadMessage).toHaveBeenCalledWith('org-1', 'thread-1', { text: '急ぎで', model: 'model-b' }, []);
    expect(api.rewindChatThread).toHaveBeenNthCalledWith(1, 'org-1', 'thread-1', { messageId: 'message-1', text: '直した', model: 'model-b' }, []);
    expect(api.rewindChatThread).toHaveBeenNthCalledWith(2, 'org-1', 'thread-1', { messageId: 'message-1', text: '直した' }, []);
  });

  it('sends the level of effort chosen with a message and a rewritten one, and remembers it in this browser for the Account', async () => {
    window.localStorage.clear();
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.sendChatThreadMessage).mockResolvedValue({ threadId: 'thread-1', accepted: true });
    vi.mocked(api.rewindChatThread).mockResolvedValue({ threadId: 'thread-1', accepted: true });

    expect(transport.chosenEffort?.()).toBeNull();
    transport.chooseEffort?.('max');
    await transport.send('よく考えて', { effort: 'max' });
    await transport.rewind('message-1', '直した', { effort: 'low' });

    expect(createThreadTransport({ accountId: 'org-1', threadId: 'thread-2', surroundings: surroundings().value }).chosenEffort?.()).toBe('max');
    expect(createThreadTransport({ accountId: 'org-2', threadId: 'thread-3', surroundings: surroundings().value }).chosenEffort?.()).toBeNull();
    // A value this browser kept that names no level is remembered as none.
    window.localStorage.setItem('flarechat:chat-effort:org-1', 'ultra');
    expect(transport.chosenEffort?.()).toBeNull();
    expect(api.sendChatThreadMessage).toHaveBeenCalledWith('org-1', 'thread-1', { text: 'よく考えて', effort: 'max' }, []);
    expect(api.rewindChatThread).toHaveBeenCalledWith('org-1', 'thread-1', { messageId: 'message-1', text: '直した', effort: 'low' }, []);
  });

  it('continues a conversation as a new one and reads what the chat offers', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.forkChatThread).mockResolvedValue({ id: 'thread-2', title: '予定（続き）', createdAt: '', updatedAt: '' });
    vi.mocked(api.chatCapabilities).mockResolvedValue({ models: ['model-a'], efforts: { 'model-a': { levels: ['low', 'high'], default: null } }, drivePicker: true });

    expect(await transport.fork('run-1')).toBe('thread-2');
    expect(await transport.capabilities?.()).toEqual({ models: ['model-a'], efforts: { 'model-a': { levels: ['low', 'high'], default: null } }, drivePicker: true });
    expect(api.forkChatThread).toHaveBeenCalledWith('org-1', 'thread-1', 'run-1');
  });

  it('saves a file to Drive in the folder chosen with Google Picker, or in AI に聞く, and nothing when the person chose no folder', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    const picker = { apiKey: 'key', appId: '1', accessToken: 'token' };
    vi.mocked(api.chatDrivePicker).mockResolvedValue(picker);
    vi.mocked(chooseDriveFolder).mockResolvedValueOnce({ id: 'folder-1', name: '請求' }).mockResolvedValueOnce(null);
    vi.mocked(api.saveChatFileToDrive).mockResolvedValue({ fileId: 'drive-1', url: 'https://drive.google.com/file/d/drive-1' });

    expect(await transport.saveToDrive?.('file-1', true)).toEqual({ url: 'https://drive.google.com/file/d/drive-1' });
    expect(await transport.saveToDrive?.('file-1', false)).toEqual({ url: 'https://drive.google.com/file/d/drive-1' });
    expect(await transport.saveToDrive?.('file-1', true)).toBeNull();

    expect(chooseDriveFolder).toHaveBeenCalledWith(picker);
    expect(api.saveChatFileToDrive).toHaveBeenNthCalledWith(1, 'org-1', 'thread-1', 'file-1', { folderId: 'folder-1' });
    expect(api.saveChatFileToDrive).toHaveBeenNthCalledWith(2, 'org-1', 'thread-1', 'file-1', {});
    expect(api.saveChatFileToDrive).toHaveBeenCalledTimes(2);
  });

  it('attaches the Drive files picked with Google Picker as the files the Worker reads them as', async () => {
    const transport = createThreadTransport({ accountId: 'org-1', threadId: 'thread-1', surroundings: surroundings().value });
    vi.mocked(api.chatDrivePicker).mockResolvedValueOnce({ apiKey: 'key', appId: '1', accessToken: 'token' }).mockResolvedValueOnce(null);
    vi.mocked(chooseDriveFiles).mockResolvedValue([{ id: 'drive-file-1', name: '議事録' }]);
    const minutes = new File(['%PDF-1.4'], '議事録.pdf', { type: 'application/pdf' });
    vi.mocked(api.chatDriveFile).mockResolvedValue(minutes);

    expect(await transport.pickDriveFiles?.()).toEqual([minutes]);
    await expect(transport.pickDriveFiles?.()).rejects.toThrow('設定されていません');
    expect(api.chatDriveFile).toHaveBeenCalledWith('org-1', 'drive-file-1');
  });
});
