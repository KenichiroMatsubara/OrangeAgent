/**
 * Operator Chat on t3code's timeline and composer. ChatSurface connects one conversation to its
 * transport, reads it back through t3code's own selectors, and routes what a person does (send,
 * stop, answer an approval, edit an earlier message, continue from an answer) to the transport
 * instead of t3code's Effect RPC commands. Beside t3code's controls it offers OrangeAgent's own:
 * the model a message is answered by, how hard it thinks, attaching a Drive file, and saving a
 * file to Drive.
 */
import { scopeThreadRef } from '@t3tools/client-runtime/environment/index.ts';
import { deriveThreadActivityRun } from '@t3tools/client-runtime/state/threadExecution.ts';
import { derivePendingThreadRequests } from '@t3tools/client-runtime/state/threadRequests.ts';
import {
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  RunId,
  type ProviderApprovalDecision,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from '@t3tools/contracts';
import { ArrowLeftIcon, PencilIcon, XIcon } from 'lucide-react';
import type { LegendListRef } from '@legendapp/list/react';
import { createRef, type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ChatComposer, type ChatComposerHandle } from '~/components/chat/ChatComposer';
import { ComposerSurface } from '~/components/chat/ComposerSurface';
import { Spinner } from '~/components/ui/spinner';
import { ExpandedImageDialog } from '~/components/chat/ExpandedImageDialog';
import type { ExpandedImagePreview } from '~/components/chat/ExpandedImagePreview';
import { QueuedRunsControl, type EditQueuedRunRequest } from '~/components/chat/QueuedRunsControl';
import { ThreadTimeline } from '~/components/chat/ThreadTimeline';
import { presentThreadShellFromProjection } from '~/components/ChatView.logic';
import { useComposerDraftStore } from '~/composerDraftStore';
import { derivePendingApprovals } from '~/session-logic';
import { useQuietThreadProjection, useThreadLastVisitedAt, useThreadUpdatedAt } from '~/state/entities';
import { useMediaQuery } from '~/hooks/useMediaQuery';
import type { ComposerFileAttachment, ComposerImageAttachment } from '~/composerDraftStore';
import { observeResize } from '~/lib/observeResize';
import type { TerminalContextDraft } from '~/lib/terminalContext';
import type { ChatFileAttachment, ChatMessage } from '~/types';

import type { ChatDecision, ChatMode, ChatQueueChange, ChatSurfaceProps, ChatTransport } from './api.ts';
import { COMPOSER_FIXED, ENVIRONMENT_ID, failed, NO_MODEL, noop, useModelChoices, writtenText } from './composer.tsx';
import { FileContext, type FileCommands } from './files.tsx';
import { ChatFrame } from './frame.tsx';
import { offerSuggestion } from './suggestion.ts';
import { chatModeOf, runtimeModeOf } from './modes.ts';
import { orangeagentProvider } from './provider.ts';
import { QueueContext, type QueueCommands } from './queue.ts';
import { connectThread } from './stream.ts';

/** An answer being written or waiting for approval; a queued message is not being answered yet. */
const ACTIVE_RUN = new Set(['preparing', 'starting', 'running', 'waiting']);
/** What the composer shows of the files of a queued message being rewritten: none, as only its words change. */
const NO_EDITED_ATTACHMENTS: ReadonlyArray<{ readonly attachment: ChatAttachment; readonly url: string | null }> = [];
const NO_ATTACHMENT_URLS: ReadonlyMap<string, string> = new Map();


/** Opens a person's or an answer's file where the transport serves it: a PDF in the browser, anything else saved, as the server says. */
const openFile = (url: string | undefined, file: ChatFileAttachment, download: boolean): void => {
  if (url === undefined) return;
  const link = document.createElement('a');
  link.href = url;
  if (download) link.download = file.name;
  else {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  link.click();
};

const decisionOf = (decision: ProviderApprovalDecision): ChatDecision => decision;

/** What a subagent's card says of it, in the panel that opens it. */
const SUBAGENT_STATUS: Readonly<Record<string, string>> = {
  pending: '待機中', running: '実行中', waiting: '待機中', idle: '待機中', completed: '完了', failed: '失敗', cancelled: '停止', interrupted: '停止',
};

/**
 * A subagent's own conversation, opened from its card: beside the conversation on a wide screen,
 * and over the whole screen on a phone. It is read only; the subagent is the parent answer's.
 */
function SubagentPanel({ threadId, title, status, fullScreen, onClose }: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: string;
  readonly fullScreen: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const threadRef = useMemo(() => scopeThreadRef(ENVIRONMENT_ID, threadId), [threadId]);
  const threadKey = `${ENVIRONMENT_ID}:${threadId}`;
  const [listRef] = useState(() => createRef<LegendListRef | null>());
  const structure = useQuietThreadProjection(threadRef);
  const projection = structure?.projection ?? null;
  const latestRun = projection === null ? null : deriveThreadActivityRun(projection);
  const isWorking = latestRun !== null && ACTIVE_RUN.has(latestRun.status);
  const tools = projection?.turnItems.filter((item) => item.type === 'dynamic_tool').length ?? null;
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <aside
      aria-label={`サブエージェント：${title}`}
      data-subagent-panel={fullScreen ? 'full' : 'side'}
      className={fullScreen
        ? 'fixed inset-0 z-50 flex flex-col bg-background text-foreground'
        : 'relative flex min-h-0 w-[min(30rem,42%)] shrink-0 flex-col border-l border-border bg-background text-foreground'}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {fullScreen ? (
          <button type="button" onClick={onClose} aria-label="会話に戻る" className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent">
            <ArrowLeftIcon aria-hidden className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            サブエージェント · {status}{tools === null ? '' : ` · ツール ${tools} 回`}
          </p>
        </div>
        {fullScreen ? null : (
          <button type="button" onClick={onClose} aria-label="閉じる" className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent">
            <XIcon aria-hidden className="size-4" />
          </button>
        )}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ThreadTimeline
          threadDetailRef={threadRef}
          entriesInput={{ optimisticMessages: [], attachmentUrlById: NO_ATTACHMENT_URLS, attempts: projection?.attempts ?? [], nodes: projection?.nodes ?? [], plans: projection?.plans ?? [] }}
          draftEntries={null}
          activeThreadKey={threadKey}
          syncing={projection === null}
          detailLoading={projection === null}
          // Until the conversation is read, it is shown loading, never as one with no message yet.
          hideEmptyPlaceholder={projection === null}
          isWorking={isWorking}
          listRef={listRef}
          pendingApprovals={[]}
          respondingRequestIds={[]}
          canOperateThread={false}
          awaitingUser={null}
          awaitingRequestId={null}
          activeTurnStartedAt={isWorking ? latestRun.startedAt : null}
          latestRun={latestRun}
          runningRunId={isWorking ? latestRun.runId : null}
          turnDiffSummaries={[]}
          runs={projection?.runs ?? []}
          routeThreadKey={threadKey}
          onOpenThread={noop}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={setExpanded}
          activeThreadEnvironmentId={ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="24-hour"
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          emptyPlaceholderInset={0}
          liveFollowEnabled
          onIsAtEndChange={noop}
        />
        {projection === null ? <Reading /> : null}
      </div>
      {expanded === null ? null : <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />}
    </aside>
  );
}

/**
 * An earlier message being rewritten, which the next send asks again in its place: the files it
 * was sent with, and those of them still kept, which go with it beside any file added.
 */
interface Rewinding {
  readonly messageId: string;
  readonly sent: ReadonlyArray<ChatAttachment>;
  readonly kept: ReadonlyArray<ChatAttachment>;
}

/** What stands where the timeline will be while the conversation is still being read. */
function Reading(): ReactElement {
  return (
    <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" aria-hidden="true" />
      会話を読み込んでいます
    </div>
  );
}

/** A message sent while nothing ran, and the latest run when it was sent, until a newer one shows. */
interface Sending {
  readonly from: string | null;
  readonly message: ChatMessage;
}

/** How long an accepted message waits for its answer to show before the composer stops waiting. */
const SENDING_LIMIT_MS = 15_000;

function Conversation({ threadId, transport, onOpenThread, onTitle, onManageModels }: {
  readonly threadId: ThreadId;
  readonly transport: ChatTransport;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  readonly onTitle?: ((title: string) => void) | undefined;
  readonly onManageModels?: (() => void) | undefined;
}): ReactElement {
  const threadRef = useMemo(() => scopeThreadRef(ENVIRONMENT_ID, threadId), [threadId]);
  const threadKey = `${ENVIRONMENT_ID}:${threadId}`;
  const [listRef] = useState(() => createRef<LegendListRef | null>());
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef('');
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const atEndRef = useRef(true);
  const [inset, setInset] = useState(0);
  const [responding, setResponding] = useState<ReadonlyArray<RuntimeRequestId>>([]);
  const [multipleModels, setMultipleModels] = useState<ReadonlyArray<ModelSelection> | null>(null);
  const [editing, setEditing] = useState<RunId | null>(null);
  // A picture opened full size, from a message or an answer.
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  // The subagent whose own conversation is open, by that conversation's id.
  const [openedThread, setOpenedThread] = useState<ThreadId | null>(null);
  const wide = useMediaQuery('(min-width: 768px)');

  // The modes the server offers, which it alone knows: 自動 only where it can ask a judge.
  const [offered, setOffered] = useState<ReadonlyArray<ChatMode> | null>(null);
  // The models a message may be answered by, and whether Drive is reachable through Google Picker.
  const { choice, drivePicker, extraControls, extraAttachActions } = useModelChoices(transport, onManageModels);
  // An earlier message being rewritten in the composer.
  const [rewinding, setRewinding] = useState<Rewinding | null>(null);
  // A message sent while nothing runs, shown at once until the answer it starts appears.
  const [sending, setSending] = useState<Sending | null>(null);

  useEffect(() => connectThread(ENVIRONMENT_ID, threadId, transport), [threadId, transport]);

  // The timeline ends with room for everything that floats over it — the queue, the composer, and
  // whatever the composer shows above its editor — so its last lines can always be scrolled into
  // view. t3code's composer reports its height only when it folds or unfolds; this follows the
  // overlay itself whenever its height changes.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const measure = (): void => setInset(Math.ceil(overlay.getBoundingClientRect().height));
    measure();
    return observeResize(overlay, measure);
  }, []);
  // A timeline read to its end stays at its end when the composer grows over it.
  useLayoutEffect(() => {
    const node = atEndRef.current ? listRef.current?.getScrollableNode() : null;
    if (!(node instanceof HTMLElement)) return;
    // Once the list has laid out its taller end; it does not follow its footer by itself.
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inset, listRef]);
  useEffect(() => {
    let current = true;
    setOffered(null);
    transport.modes().then((modes) => {
      if (current) setOffered(modes);
    }, (error: unknown) => failed('承認のしかたを読めませんでした', error));
    return () => {
      current = false;
    };
  }, [transport]);

  const structure = useQuietThreadProjection(threadRef);
  const updatedAt = useThreadUpdatedAt(threadRef);
  const lastVisitedAt = useThreadLastVisitedAt(threadRef);
  const projection = structure?.projection ?? null;
  const pending = projection === null ? null : derivePendingThreadRequests(projection);
  const subagents = (projection?.turnItems ?? []).flatMap((item) => item.type === 'subagent' && item.childThreadId !== null ? [item] : []);
  // Each subagent's own conversation is followed too, so its card counts its calls and it opens at once.
  const childThreads = [...new Set(subagents.map((item) => item.childThreadId))].join('\n');
  useEffect(() => {
    if (childThreads === '') return;
    const stops = childThreads.split('\n').map((child) => connectThread(ENVIRONMENT_ID, ThreadId.make(child), transport));
    return () => stops.forEach((stop) => stop());
  }, [childThreads, transport]);
  const openedSubagent = openedThread === null ? undefined : subagents.find((item) => item.childThreadId === openedThread);
  const approvals = pending === null ? [] : derivePendingApprovals(pending.approvals);
  const latestRun = projection === null ? null : deriveThreadActivityRun(projection);
  const isWorking = latestRun !== null && ACTIVE_RUN.has(latestRun.status);
  // Until the server shows the answer the sent message starts, the message stands in the timeline and the composer waits.
  const awaiting = sending !== null && (latestRun?.runId ?? null) === sending.from;
  const optimistic = useMemo<ReadonlyArray<ChatMessage>>(() => awaiting && sending !== null ? [sending.message] : [], [awaiting, sending]);
  useEffect(() => {
    if (sending !== null && !awaiting) setSending(null);
  }, [awaiting, sending]);
  // A message typed while the answer runs is handed to it at its next step; typed while a call waits for approval, it declines the call.
  const canSteer = isWorking;
  const respondingIds = responding.filter((id) => approvals.some((approval) => approval.requestId === id));
  const thread = projection === null || updatedAt === null
    ? undefined
    : presentThreadShellFromProjection(ENVIRONMENT_ID, threadId, projection, { updatedAt, lastVisitedAt });
  const attachmentUrls = transport.attachmentUrls ?? NO_ATTACHMENT_URLS;
  const title = projection?.thread.title;
  useEffect(() => {
    if (title !== undefined) onTitle?.(title);
  }, [title, onTitle]);
  // What the person is likely to write next, read once the latest answer completes; the composer
  // offers it only while that answer stays the latest completed one.
  const completedRunId = latestRun !== null && latestRun.status === 'completed' ? latestRun.runId : null;
  useEffect(() => {
    if (completedRunId === null || !transport.suggestion) return;
    let current = true;
    transport.suggestion().then((read) => {
      if (!current) return;
      offerSuggestion(threadId, read.runId !== null && read.text !== null ? { runId: RunId.make(read.runId), text: read.text } : null);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [completedRunId, threadId, transport]);
  const fileCommands = useMemo<FileCommands>(() => ({
    saveToDrive: transport.saveToDrive ? (fileId, choose) => transport.saveToDrive?.(fileId, choose) ?? Promise.resolve(null) : null,
    chooseFolder: drivePicker,
  }), [transport, drivePicker]);
  const runtimeMode = projection?.thread.runtimeMode ?? 'approval-required';
  // Until the server says which modes it offers, the composer offers only the one the conversation is in.
  const providers = useMemo(() => [orangeagentProvider(offered === null ? [runtimeMode] : offered.map(runtimeModeOf))], [offered, runtimeMode]);

  const respond = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision, feedback?: string): Promise<void> => {
    setResponding((ids) => [...ids, requestId]);
    try {
      await transport.respond(requestId, decisionOf(decision), feedback);
    } catch (error) {
      setResponding((ids) => ids.filter((id) => id !== requestId));
      failed('答えられませんでした', error);
    }
  };

  const changeQueue = async (change: ChatQueueChange): Promise<void> => {
    await transport.changeQueue(change).catch((error: unknown) => failed('待っているメッセージを変えられませんでした', error));
  };
  const queueCommands: QueueCommands = {
    change: changeQueue,
    attachmentUrl: (id) => attachmentUrls.get(id) ?? null,
  };

  const editQueued = (request: EditQueuedRunRequest): void => {
    setEditing(request.runId);
    useComposerDraftStore.getState().setPrompt(threadRef, request.text);
    promptRef.current = request.text;
    // Once the editor holds the words, so the caret lands after them.
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const stopEditing = (): void => {
    setEditing(null);
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    promptRef.current = '';
  };

  /** t3code's 「ここから編集し直す」 on an earlier message: its words go into the composer, and sending asks it again in its place. */
  const rewindFrom = (_turnCount: number, messageId: MessageId): void => {
    const item = projection?.turnItems.find((candidate) => candidate.type === 'user_message' && (candidate.messageId === messageId || String(candidate.id) === String(messageId)));
    if (item?.type !== 'user_message') return;
    setEditing(null);
    setRewinding({ messageId, sent: item.attachments, kept: item.attachments });
    useComposerDraftStore.getState().setPrompt(threadRef, item.text);
    promptRef.current = item.text;
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  /** A file the rewritten message was sent with, left out of it. */
  const dropRewoundFile = (attachmentId: string): void => {
    setRewinding((current) => current === null ? null : { ...current, kept: current.kept.filter((attachment) => attachment.id !== attachmentId) });
  };
  const stopRewinding = (): void => {
    setRewinding(null);
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    promptRef.current = '';
  };

  /** t3code's 「ここから新しい会話で続ける」 on an answer: a new conversation holding everything up to it, opened at once. */
  const forkFromRun = async ({ runId }: { readonly sourceThreadId: ThreadId; readonly runId: RunId }): Promise<void> => {
    try {
      const forked = await transport.fork(runId);
      onOpenThread?.(forked);
    } catch (error) {
      failed('新しい会話にできませんでした', error);
    }
  };

  /**
   * Sends what the person wrote with the pictures and files they attached. While an answer is
   * written it is handed to that answer (`steer`), or queued after it (`queue`, the modifier
   * key's choice); typed while a call waits for approval, it declines the call and the model is
   * told it, unless it is queued or carries files. While a queued message is rewritten, it
   * replaces that message's words; while an earlier message is, it is asked again in its place
   * with the files it kept and those attached now.
   */
  const send = (_event?: { preventDefault: () => void }, dispatchMode?: string): void => {
    const text = writtenText(promptRef.current);
    const files = [
      ...imagesRef.current.map((image) => image.file),
      ...filesRef.current.flatMap((file) => file.file === null ? [] : [file.file]),
    ];
    if (rewinding !== null) {
      if (text === '' && rewinding.kept.length === 0 && files.length === 0) return;
      const { messageId } = rewinding;
      const kept = new Set(rewinding.kept.map((attachment) => attachment.id));
      const drop = rewinding.sent.flatMap((attachment) => kept.has(attachment.id) ? [] : [attachment.id]);
      stopRewinding();
      void transport.rewind(messageId, text, { ...choice, drop, files }).catch((error: unknown) => failed('編集し直せませんでした', error));
      return;
    }
    if (text === '' && files.length === 0) return;
    if (editing !== null) {
      if (text === '') return;
      const runId = editing;
      stopEditing();
      void changeQueue({ action: 'edit', runId, text });
      return;
    }
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    promptRef.current = '';
    const delivery = dispatchMode === 'queue' ? 'queue' : 'steer';
    const waiting = approvals[0];
    if (waiting !== undefined && delivery === 'steer' && files.length === 0) {
      void respond(waiting.requestId, 'decline', text);
      return;
    }
    const sent = transport.send(text, { delivery, files, ...choice });
    if (isWorking) {
      void sent.catch((error: unknown) => failed('送れませんでした', error));
      return;
    }
    const at = new Date().toISOString();
    const message: ChatMessage = { id: `sending-${at}` as MessageId, role: 'user', text, runId: null, streaming: false, createdAt: at, updatedAt: at };
    const mine: Sending = { from: latestRun?.runId ?? null, message };
    setSending(mine);
    // Accepted but never shown, it stops waiting after a while rather than spinning forever.
    sent.then(
      () => window.setTimeout(() => setSending((current) => current === mine ? null : current), SENDING_LIMIT_MS),
      (error: unknown) => {
        setSending((current) => current === mine ? null : current);
        failed('送れませんでした', error);
      },
    );
  };

  const changeMode = (mode: RuntimeMode): void => {
    void transport.setMode(chatModeOf(mode)).catch((error: unknown) => failed('承認のしかたを変えられませんでした', error));
  };

  return (
    <FileContext value={fileCommands}>
    <div className="relative flex min-h-0 flex-1 flex-row bg-background text-foreground">
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ThreadTimeline
          threadDetailRef={threadRef}
          entriesInput={{
            optimisticMessages: optimistic,
            attachmentUrlById: attachmentUrls,
            attempts: projection?.attempts ?? [],
            nodes: projection?.nodes ?? [],
            plans: projection?.plans ?? [],
          }}
          draftEntries={null}
          activeThreadKey={threadKey}
          syncing={projection === null}
          detailLoading={projection === null}
          // Until the conversation is read, it is shown loading, never as one with no message yet.
          hideEmptyPlaceholder={projection === null}
          isWorking={isWorking || awaiting}
          listRef={listRef}
          pendingApprovals={approvals}
          respondingRequestIds={respondingIds}
          canOperateThread
          onRespondToApproval={respond}
          awaitingUser={approvals.length > 0 ? 'approval' : null}
          awaitingRequestId={approvals[0]?.requestId ?? null}
          activeTurnStartedAt={isWorking ? latestRun.startedAt : null}
          latestRun={latestRun}
          runningRunId={isWorking ? latestRun.runId : null}
          turnDiffSummaries={[]}
          runs={projection?.runs ?? []}
          routeThreadKey={threadKey}
          onOpenThread={(opened) => setOpenedThread(opened)}
          // Any earlier message can be rewritten: the conversation has no workspace whose checkpoints would limit where it rewinds to.
          supportsConversationRollback
          threadStartCheckpointAvailable
          onRevertToTurnCount={rewindFrom}
          onForkFromRun={forkFromRun}
          isRevertingCheckpoint={rewinding !== null}
          onImageExpand={setExpanded}
          onFileOpen={(file) => openFile(attachmentUrls.get(file.id), file, false)}
          onFileDownload={(file) => openFile(attachmentUrls.get(file.id), file, true)}
          activeThreadEnvironmentId={ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="24-hour"
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={inset}
          emptyPlaceholderInset={inset}
          liveFollowEnabled
          onIsAtEndChange={(atEnd) => {
            atEndRef.current = atEnd;
          }}
        />
        {projection === null ? <Reading /> : null}
      </div>
      <div ref={overlayRef} data-chat-composer-overlay="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2">
        <div className="chat-composer-lane w-full">
          <div
            data-chat-composer-stack="true"
            className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
          >
            <QueueContext value={queueCommands}>
              <QueuedRunsControl
                environmentId={ENVIRONMENT_ID}
                threadId={threadId}
                optimisticMessages={[]}
                editingRunId={editing}
                editBlockedReason={null}
                onEditQueuedRun={editQueued}
                onCancelEdit={stopEditing}
                timestampFormat="24-hour"
                onOpenThread={noop}
                onImageExpand={setExpanded}
              />
            </QueueContext>
            {rewinding !== null ? (
              <div
                data-chat-rewinding="true"
                role="status"
                className="mx-2 mb-1.5 flex items-start gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm sm:mx-0"
              >
                <PencilIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
                <span className="min-w-0 flex-1 leading-5">
                  <span className="font-medium text-foreground">以前のメッセージを編集しています。</span>
                  送ると、このメッセージから後のやり取りは取り消され、ここから答え直します。
                  {rewinding.sent.length > 0 ? '元の添付は下に残してあり、外すことも足すこともできます。' : ''}
                </span>
                <button type="button" onClick={stopRewinding} className="shrink-0 rounded-md px-1.5 py-0.5 text-foreground/80 hover:bg-accent hover:text-foreground">
                  やめる
                </button>
              </div>
            ) : null}
            <ComposerSurface.Shell>
              <ComposerSurface.Host>
                <div className="relative z-10">
                  <ChatComposer
                    {...COMPOSER_FIXED}
                    composerDraftTarget={threadRef}
                    routeThreadRef={threadRef}
                    multipleModelSelections={multipleModels}
                    onMultipleModelSelectionsChange={setMultipleModels}
                    activeThreadId={threadId}
                    activeThread={thread}
                    activeThreadRuns={projection?.runs ?? []}
                    forceExpandedOnMobile={false}
                    phase={isWorking ? 'running' : 'ready'}
                    canInterrupt={isWorking}
                    isSendBusy={awaiting}
                    canSteer={canSteer}
                    activePendingApproval={approvals[0] ?? null}
                    pendingApprovals={approvals}
                    respondingRequestIds={respondingIds}
                    runtimeMode={runtimeMode}
                    providerStatuses={providers}
                    activeThreadModelSelection={projection?.thread.modelSelection ?? NO_MODEL}
                    activeProjectId={projection?.thread.projectId ?? null}
                    onComposerOverlayHeightChange={(height) => setInset(Math.ceil(height))}
                    permissionsShownInStrip={false}
                    promptRef={promptRef}
                    composerImagesRef={imagesRef}
                    composerFilesRef={filesRef}
                    composerTerminalContextsRef={terminalContextsRef}
                    composerRef={composerRef}
                    // The files of the message being rewritten show in the composer, each removable, as a queued message's would.
                    editingQueuedAttachments={rewinding !== null
                      ? rewinding.kept.map((attachment) => ({ attachment, url: attachmentUrls.get(attachment.id) ?? null }))
                      : editing === null ? null : NO_EDITED_ATTACHMENTS}
                    onRemoveEditingQueuedAttachment={rewinding !== null ? dropRewoundFile : noop}
                    rewindingMessage={rewinding !== null}
                    onSend={send}
                    onInterrupt={() => void transport.interrupt().catch((error: unknown) => failed('止められませんでした', error))}
                    handleRuntimeModeChange={changeMode}
                    focusComposer={() => composerRef.current?.focusAtEnd()}
                    onExpandImage={setExpanded}
                    extraAttachActions={extraAttachActions}
                    extraControls={extraControls}
                  />
                </div>
              </ComposerSurface.Host>
            </ComposerSurface.Shell>
          </div>
        </div>
      </div>
    </div>
      {openedThread === null ? null : (
        <SubagentPanel
          key={openedThread}
          threadId={openedThread}
          title={openedSubagent?.title?.trim() || 'サブエージェント'}
          status={SUBAGENT_STATUS[openedSubagent?.status ?? ''] ?? ''}
          fullScreen={!wide}
          onClose={() => setOpenedThread(null)}
        />
      )}
      {expanded === null ? null : <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />}
    </div>
    </FileContext>
  );
}

/**
 * The chat for one conversation. It fills its parent, which gives it a height; everything it
 * draws is inside `.t3chat`, where the copied styles are scoped (chat.css).
 */
export default function ChatSurface({ threadId, transport, onOpenThread, onTitle, onManageModels }: ChatSurfaceProps): ReactElement {
  return (
    <ChatFrame className="flex h-full min-h-0 w-full flex-col">
      <Conversation threadId={ThreadId.make(threadId)} transport={transport} onOpenThread={onOpenThread} onTitle={onTitle} onManageModels={onManageModels} />
    </ChatFrame>
  );
}
