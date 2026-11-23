/**
 * Operator Chat on t3code's timeline and composer. ChatSurface connects one conversation to its
 * transport, reads it back through t3code's own selectors, and routes what a person does (send,
 * stop, answer an approval, edit an earlier message, continue from an answer) to the transport
 * instead of t3code's Effect RPC commands. Beside t3code's controls it offers FlareChat's own:
 * the model a message is answered by, how hard it thinks, attaching a Drive file, and saving a
 * file to Drive.
 */
import './chat.css';

import { scopeThreadRef } from '@t3tools/client-runtime/environment/index.ts';
import { deriveThreadActivityRun } from '@t3tools/client-runtime/state/threadExecution.ts';
import { derivePendingThreadRequests } from '@t3tools/client-runtime/state/threadRequests.ts';
import { replaceComposerContextReferences } from '@t3tools/shared/composerContextReferences.ts';
import {
  type ChatAttachment,
  EnvironmentId,
  type MessageId,
  type ModelSelection,
  RunId,
  type ProviderApprovalDecision,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from '@t3tools/contracts';
import { DEFAULT_RESOLVED_KEYBINDINGS } from '@t3tools/shared/keybindings.ts';
import { EFFORT_LABELS, modelLabel, shortModelLabel, type ModelEffort } from '@mail/domain';
import { ArrowLeftIcon, ChevronDownIcon, CpuIcon, HardDriveIcon, PencilIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react';
import type { LegendListRef } from '@legendapp/list/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createContext, createRef, type ReactElement, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ChatComposer, type ChatComposerHandle } from '~/components/chat/ChatComposer';
import { ComposerControl, ComposerControlIcon } from '~/components/chat/ComposerControl';
import { useComposerMenuProps } from '~/components/chat/composerEventScope';
import { useComposerMenuState } from '~/components/chat/useComposerMenuState';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSeparator, MenuTrigger } from '~/components/ui/menu';
import { ComposerSurface } from '~/components/chat/ComposerSurface';
import { Spinner } from '~/components/ui/spinner';
import { EffortGlyph } from '~/components/chat/EffortGlyph';
import { ExpandedImageDialog } from '~/components/chat/ExpandedImageDialog';
import type { ExpandedImagePreview } from '~/components/chat/ExpandedImagePreview';
import { QueuedRunsControl, type EditQueuedRunRequest } from '~/components/chat/QueuedRunsControl';
import { ThreadTimeline } from '~/components/chat/ThreadTimeline';
import { presentThreadShellFromProjection } from '~/components/ChatView.logic';
import { useComposerDraftStore } from '~/composerDraftStore';
import { I18nProvider } from '~/i18n/I18nProvider';
import { startI18n } from '~/i18n/runtime';
import type { ShortcutMatchContext } from '~/keybindings';
import { chatPortalContainer } from '~/components/ui/portalContainer';
import { AnchoredToastProvider, ToastProvider, toastManager } from '~/components/ui/toast';
import { AppAtomRegistryProvider } from '~/rpc/atomRegistry';
import { derivePendingApprovals } from '~/session-logic';
import { useQuietThreadProjection, useThreadLastVisitedAt, useThreadUpdatedAt } from '~/state/entities';
import { useMediaQuery } from '~/hooks/useMediaQuery';
import type { ComposerFileAttachment, ComposerImageAttachment } from '~/composerDraftStore';
import { observeResize } from '~/lib/observeResize';
import type { TerminalContextDraft } from '~/lib/terminalContext';
import type { ChatFileAttachment, ChatMessage } from '~/types';

import type { ChatCapabilities, ChatDecision, ChatMode, ChatQueueChange, ChatSurfaceProps, ChatTransport } from './api.ts';
import { FileContext, type FileCommands } from './files.tsx';
import { offerSuggestion } from './suggestion.ts';
import { chatModeOf, runtimeModeOf } from './modes.ts';
import { FLARECHAT_SETTINGS, flarechatProvider } from './provider.ts';
import { QueueContext, type QueueCommands } from './queue.ts';
import { connectThread } from './stream.ts';

/** Every conversation is FlareChat's own; t3code's environment is a single local one. */
const ENVIRONMENT_ID = EnvironmentId.make('flarechat');
/** An answer being written or waiting for approval; a queued message is not being answered yet. */
const ACTIVE_RUN = new Set(['preparing', 'starting', 'running', 'waiting']);
/** What the composer shows of the files of a queued message being rewritten: none, as only its words change. */
const NO_EDITED_ATTACHMENTS: ReadonlyArray<{ readonly attachment: ChatAttachment; readonly url: string | null }> = [];
const NO_MODEL: ModelSelection | null = null;
const NO_ATTACHMENT_URLS: ReadonlyMap<string, string> = new Map();
const noop = (): void => {};
/** Until the server says, the chat offers no choice of model and nothing of Drive. */
const NO_CAPABILITIES: ChatCapabilities = { models: [], efforts: {}, drivePicker: false };
const NO_EFFORTS: ReadonlyArray<ModelEffort> = [];

/**
 * The model a message is answered by, chosen beside the approval mode: FlareChat's control. It
 * names the model that will answer in words (Opus 5.5) and opens a menu of every model the AI
 * Connection names, the default first, with a way to the screen that adds more.
 */
function ModelChoice({ models, model, onChange, onManage }: {
  readonly models: ReadonlyArray<string>;
  readonly model: string;
  readonly onChange: (model: string) => void;
  readonly onManage: (() => void) | undefined;
}): ReactElement {
  const floating = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState();
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            data-chat-model-choice="true"
            aria-label={`答えるモデル: ${modelLabel(model)}`}
            title={`答えるモデル: ${modelLabel(model)}`}
            className="ps-1.5 pe-1"
          />
        }
      >
        <ComposerControlIcon icon={CpuIcon} />
        <span data-composer-control-label className="max-w-28 truncate sm:max-w-48">{shortModelLabel(model)}</span>
        <ChevronDownIcon aria-hidden data-composer-control-chevron className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64" {...floating}>
        <MenuGroup>
          <MenuGroupLabel>答えるモデル</MenuGroupLabel>
          <MenuRadioGroup value={model} onValueChange={(next: string) => onChange(next)}>
            {models.map((entry, index) => (
              <MenuRadioItem key={entry} value={entry} className="min-h-11 sm:min-h-9">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-4 shrink-0 items-center justify-center"><MenuRadioItemIndicator /></span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {modelLabel(entry)}
                      {index === 0 ? <span className="ms-1.5 text-muted-foreground text-xs">既定</span> : null}
                    </span>
                    {modelLabel(entry) === entry ? null : <span className="truncate text-muted-foreground text-xs">{entry}</span>}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {onManage === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem className="min-h-11 sm:min-h-9" onClick={onManage}>
              <SlidersHorizontalIcon />
              {models.length > 1 ? 'モデルを追加・並べ替え' : 'ほかのモデルを追加'}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/**
 * How hard the model thinks, chosen beside the model: FlareChat's control. It shows the level as
 * rising bars and in words, and opens a menu of the levels the model takes, the lightest first,
 * the one it thinks at when none is named marked 既定 where that is known. Shown only for a model
 * that takes two or more; until one is chosen for a model whose default is not known, it reads 既定.
 */
function EffortChoice({ efforts, fallback, effort, onChange }: {
  readonly efforts: ReadonlyArray<ModelEffort>;
  readonly fallback: ModelEffort | null;
  readonly effort: ModelEffort | null;
  readonly onChange: (effort: ModelEffort) => void;
}): ReactElement {
  const floating = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState();
  const label = effort === null ? '既定' : EFFORT_LABELS[effort];
  const filled = effort === null ? 0 : efforts.indexOf(effort) + 1;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            data-chat-effort-choice="true"
            aria-label={`考える深さ: ${label}`}
            title={`考える深さ: ${label}`}
            className="ps-1.5 pe-1"
          />
        }
      >
        <EffortGlyph count={efforts.length} filled={filled} />
        <span data-composer-control-label className="max-w-24 truncate">{label}</span>
        <ChevronDownIcon aria-hidden data-composer-control-chevron className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-48" {...floating}>
        <MenuGroup>
          <MenuGroupLabel>考える深さ</MenuGroupLabel>
          <MenuRadioGroup value={effort ?? ''} onValueChange={(next: ModelEffort) => onChange(next)}>
            {efforts.map((entry, index) => (
              <MenuRadioItem key={entry} value={entry} className="min-h-11 sm:min-h-9">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-4 shrink-0 items-center justify-center"><MenuRadioItemIndicator /></span>
                  <EffortGlyph count={efforts.length} filled={index + 1} />
                  <span className="truncate">
                    {EFFORT_LABELS[entry]}
                    {entry === fallback ? <span className="ms-1.5 text-muted-foreground text-xs">既定</span> : null}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Attaches files the person picks in Drive, as if chosen from their computer: beside the clip, only where Google Picker is configured. */
function DriveAttachButton({ pick, attach }: {
  readonly pick: () => Promise<ReadonlyArray<File>>;
  readonly attach: (files: File[]) => Promise<boolean>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label="Drive から添付"
      title="Drive から添付"
      disabled={busy}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        setBusy(true);
        pick().then(
          (files) => (files.length ? attach([...files]) : false),
          (error: unknown) => failed('Drive のファイルを添付できませんでした', error),
        ).finally(() => setBusy(false));
      }}
      className="inline-flex size-8 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-foreground disabled:opacity-60 sm:size-7"
    >
      <HardDriveIcon aria-hidden className={busy ? 'size-4 animate-pulse' : 'size-4'} />
    </button>
  );
}

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

let i18nStarted = false;
const startI18nOnce = (): void => {
  if (i18nStarted) return;
  i18nStarted = true;
  startI18n();
};

const shortcutContext = (): ShortcutMatchContext => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

const decisionOf = (decision: ProviderApprovalDecision): ChatDecision => decision;

/** What a person wrote, with each picture or file named in it by its name; the files travel beside it. */
const writtenText = (prompt: string): string => replaceComposerContextReferences(prompt, (reference) => reference.label).trim();

/** Says what the transport refused, in its own words; what happened otherwise arrives as the conversation's events. */
const failed = (title: string, error: unknown): void => {
  toastManager.add({ type: 'error', title, description: error instanceof Error ? error.message : String(error) });
};

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
  const [capabilities, setCapabilities] = useState<ChatCapabilities>(NO_CAPABILITIES);
  const [picked, setPicked] = useState<string | null>(() => transport.chosenModel?.() ?? null);
  const [pickedEffort, setPickedEffort] = useState<ModelEffort | null>(() => transport.chosenEffort?.() ?? null);
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
  useEffect(() => {
    let current = true;
    transport.capabilities?.().then((read) => {
      if (current) setCapabilities(read);
    }, () => undefined);
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
  const models = capabilities.models;
  // A model this browser chose that the server no longer offers falls back to the default.
  const model = picked !== null && models.includes(picked) ? picked : models[0] ?? '';
  // The default goes unnamed, so the server answers with whatever its default is when the message arrives.
  const chosenModel = model && model !== models[0] ? model : undefined;
  // A level the model does not take falls back to the one it thinks at when none is named, or to none named.
  const efforts = capabilities.efforts[model]?.levels ?? NO_EFFORTS;
  const fallbackEffort = capabilities.efforts[model]?.default ?? null;
  const effort = pickedEffort !== null && efforts.includes(pickedEffort) ? pickedEffort : fallbackEffort;
  // The default goes unnamed, as the model does, so the server sends the model none.
  const chosenEffort = effort !== null && effort !== fallbackEffort ? effort : undefined;
  const choice = { ...(chosenModel ? { model: chosenModel } : {}), ...(chosenEffort ? { effort: chosenEffort } : {}) };
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
    chooseFolder: capabilities.drivePicker,
  }), [transport, capabilities.drivePicker]);
  const runtimeMode = projection?.thread.runtimeMode ?? 'approval-required';
  // Until the server says which modes it offers, the composer offers only the one the conversation is in.
  const providers = useMemo(() => [flarechatProvider(offered === null ? [runtimeMode] : offered.map(runtimeModeOf))], [offered, runtimeMode]);

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

  const chooseModel = (next: string): void => {
    setPicked(next);
    transport.chooseModel?.(next);
  };
  const chooseEffort = (next: ModelEffort): void => {
    setPickedEffort(next);
    transport.chooseEffort?.(next);
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
                    composerDraftTarget={threadRef}
                    environmentId={ENVIRONMENT_ID}
                    canOperateThread
                    // FlareChat keeps no upload service: pictures and files are sent with their message.
                    attachmentUploadsCapabilityKnown={false}
                    supportsAttachmentUploads={false}
                    supportsQuestionAttachments={false}
                    maxFileAttachmentBytes={null}
                    routeKind="server"
                    routeThreadRef={threadRef}
                    draftId={null}
                    multipleModelSelections={multipleModels}
                    supportsMultipleModels={false}
                    onMultipleModelSelectionsChange={setMultipleModels}
                    activeThreadId={threadId}
                    activeThread={thread}
                    activeThreadRuns={projection?.runs ?? []}
                    promptHistoryEntries={[]}
                    forceExpandedOnMobile={false}
                    projectSelectionRequired={false}
                    phase={isWorking ? 'running' : 'ready'}
                    canInterrupt={isWorking}
                    isSendBusy={awaiting}
                    canResume={false}
                    sendDisabledReason={null}
                    isPreparingWorktree={false}
                    canSteer={canSteer}
                    bannerItems={[]}
                    resumeCompactionTokens={null}
                    keepFullHistory={false}
                    onToggleKeepFullHistory={noop}
                    environmentUnavailable={null}
                    activePendingApproval={approvals[0] ?? null}
                    pendingApprovals={approvals}
                    onHeldRequestIdsChange={noop}
                    pendingUserInputs={[]}
                    activePendingIsResponding={false}
                    respondingRequestIds={respondingIds}
                    runtimeMode={runtimeMode}
                    lockedProvider={null}
                    providerStatuses={providers}
                    providerCatalogKnown
                    activeProjectDefaultModelSelection={NO_MODEL}
                    activeThreadModelSelection={projection?.thread.modelSelection ?? NO_MODEL}
                    activeProjectId={projection?.thread.projectId ?? null}
                    compactThreadUnavailable
                    compactDisabled
                    resolvedTheme="light"
                    settings={FLARECHAT_SETTINGS}
                    keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
                    getShortcutContext={shortcutContext}
                    terminalOpen={false}
                    gitCwd={null}
                    pullRequestProjectId={null}
                    pullRequestRepository={null}
                    threadPullRequests={undefined}
                    onComposerOverlayHeightChange={(height) => setInset(Math.ceil(height))}
                    permissionsShownInStrip={false}
                    promptRef={promptRef}
                    composerImagesRef={imagesRef}
                    composerFilesRef={filesRef}
                    composerTerminalContextsRef={terminalContextsRef}
                    composerRef={composerRef}
                    onPageScrollKeyDown={noop}
                    onPageScrollKeyUp={noop}
                    onPageScrollRelease={noop}
                    // The files of the message being rewritten show in the composer, each removable, as a queued message's would.
                    editingQueuedAttachments={rewinding !== null
                      ? rewinding.kept.map((attachment) => ({ attachment, url: attachmentUrls.get(attachment.id) ?? null }))
                      : editing === null ? null : NO_EDITED_ATTACHMENTS}
                    onRemoveEditingQueuedAttachment={rewinding !== null ? dropRewoundFile : noop}
                    rewindingMessage={rewinding !== null}
                    onCompactContext={noop}
                    onSend={send}
                    onResume={noop}
                    onInterrupt={() => void transport.interrupt().catch((error: unknown) => failed('止められませんでした', error))}
                    onSelectActivePendingUserInputOption={noop}
                    onAdvanceActivePendingUserInput={noop}
                    onDismissActivePendingUserInput={noop}
                    onPreviousActivePendingUserInputQuestion={noop}
                    onChangeActivePendingUserInputCustomAnswer={noop}
                    onProviderModelSelect={noop}
                    onOpenProviderSetup={noop}
                    getModelDisabledReason={() => null}
                    handleRuntimeModeChange={changeMode}
                    focusComposer={() => composerRef.current?.focusAtEnd()}
                    scheduleComposerFocus={noop}
                    setThreadError={noop}
                    onExpandImage={setExpanded}
                    onFileOpen={noop}
                    extraAttachActions={capabilities.drivePicker && transport.pickDriveFiles
                      ? (attach) => <DriveAttachButton pick={() => transport.pickDriveFiles?.() ?? Promise.resolve([])} attach={attach} />
                      : undefined}
                    extraControls={models.length > 0 ? (
                      <>
                        <ModelChoice models={models} model={model} onChange={chooseModel} onManage={onManageModels} />
                        {efforts.length > 1 ? <EffortChoice efforts={efforts} fallback={fallbackEffort} effort={effort} onChange={chooseEffort} /> : null}
                      </>
                    ) : undefined}
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

const keepPortalContainer = (element: HTMLDivElement | null): void => {
  chatPortalContainer.current = element;
};

const SurfaceContext = createContext<ChatSurfaceProps | null>(null);

function RoutedConversation(): ReactElement | null {
  const props = use(SurfaceContext);
  if (props === null) return null;
  // Inside the router, as in t3code's root route: toasts read router state too.
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <Conversation threadId={ThreadId.make(props.threadId)} transport={props.transport} onOpenThread={props.onOpenThread} onTitle={props.onTitle} onManageModels={props.onManageModels} />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

/**
 * The chat for one conversation. It fills its parent, which gives it a height; everything it
 * draws is inside `.t3chat`, where the copied styles are scoped (chat.css).
 */
export default function ChatSurface(props: ChatSurfaceProps): ReactElement {
  startI18nOnce();
  // t3code's components read router state; the chat keeps its own in memory, apart from FlareChat's.
  const [router] = useState(() => createRouter({
    routeTree: createRootRoute({ component: RoutedConversation }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  }));
  return (
    <div className="t3chat flex h-full min-h-0 w-full flex-col" lang="ja">
      <AppAtomRegistryProvider>
        <I18nProvider>
          <SurfaceContext value={props}>
            <RouterProvider router={router} />
          </SurfaceContext>
        </I18nProvider>
      </AppAtomRegistryProvider>
      <div ref={keepPortalContainer} />
    </div>
  );
}
