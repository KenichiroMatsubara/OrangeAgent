/**
 * What a conversation's composer and the box a conversation starts from share: t3code's
 * ChatComposer with everything OrangeAgent fixes in it, and OrangeAgent's own controls beside it
 * (the model a message is answered by, how hard it thinks, attaching a Drive file). Both are the
 * same composer, so they type, send, attach, and treat the Enter key alike.
 */
import { replaceComposerContextReferences } from '@t3tools/shared/composerContextReferences.ts';
import { EnvironmentId, type ModelSelection } from '@t3tools/contracts';
import { DEFAULT_RESOLVED_KEYBINDINGS } from '@t3tools/shared/keybindings.ts';
import { EFFORT_LABELS, modelLabel, shortModelLabel, type ModelEffort } from '@mail/domain';
import { ChevronDownIcon, CpuIcon, HardDriveIcon, SlidersHorizontalIcon } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';

import type { ChatComposerProps } from '~/components/chat/ChatComposer';
import { ComposerControl, ComposerControlIcon } from '~/components/chat/ComposerControl';
import { useComposerMenuProps } from '~/components/chat/composerEventScope';
import { useComposerMenuState } from '~/components/chat/useComposerMenuState';
import { EffortGlyph } from '~/components/chat/EffortGlyph';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSeparator, MenuTrigger } from '~/components/ui/menu';
import { toastManager } from '~/components/ui/toast';
import type { ShortcutMatchContext } from '~/keybindings';

import type { ChatCapabilities, ChatTransport } from './api.ts';
import { ORANGEAGENT_SETTINGS } from './provider.ts';

/** Every conversation is OrangeAgent's own; t3code's environment is a single local one. */
export const ENVIRONMENT_ID = EnvironmentId.make('orangeagent');
export const NO_MODEL: ModelSelection | null = null;
export const noop = (): void => {};
/** Until the server says, the chat offers no choice of model and nothing of Drive. */
const NO_CAPABILITIES: ChatCapabilities = { models: [], efforts: {}, drivePicker: false };
const NO_EFFORTS: ReadonlyArray<ModelEffort> = [];

/** Says what the transport refused, in its own words; what happened otherwise arrives as the conversation's events. */
export const failed = (title: string, error: unknown): void => {
  toastManager.add({ type: 'error', title, description: error instanceof Error ? error.message : String(error) });
};

/** What a person wrote, with each picture or file named in it by its name; the files travel beside it. */
export const writtenText = (prompt: string): string => replaceComposerContextReferences(prompt, (reference) => reference.label).trim();

const shortcutContext = (): ShortcutMatchContext => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

/**
 * Everything of t3code's composer OrangeAgent fixes, the same wherever it is shown: no workspace,
 * terminal, pull request, provider picker or upload service, pictures and files sent with their
 * message, one OrangeAgent provider in a single local environment.
 */
export const COMPOSER_FIXED = {
  environmentId: ENVIRONMENT_ID,
  canOperateThread: true,
  // OrangeAgent keeps no upload service: pictures and files are sent with their message.
  attachmentUploadsCapabilityKnown: false,
  supportsAttachmentUploads: false,
  supportsQuestionAttachments: false,
  maxFileAttachmentBytes: null,
  routeKind: 'server',
  draftId: null,
  supportsMultipleModels: false,
  promptHistoryEntries: [],
  projectSelectionRequired: false,
  canResume: false,
  sendDisabledReason: null,
  isPreparingWorktree: false,
  bannerItems: [],
  resumeCompactionTokens: null,
  keepFullHistory: false,
  onToggleKeepFullHistory: noop,
  environmentUnavailable: null,
  onHeldRequestIdsChange: noop,
  pendingUserInputs: [],
  activePendingIsResponding: false,
  lockedProvider: null,
  providerCatalogKnown: true,
  activeProjectDefaultModelSelection: NO_MODEL,
  compactThreadUnavailable: true,
  compactDisabled: true,
  resolvedTheme: 'light',
  settings: ORANGEAGENT_SETTINGS,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  getShortcutContext: shortcutContext,
  terminalOpen: false,
  gitCwd: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  threadPullRequests: undefined,
  onPageScrollKeyDown: noop,
  onPageScrollKeyUp: noop,
  onPageScrollRelease: noop,
  onCompactContext: noop,
  onResume: noop,
  onSelectActivePendingUserInputOption: noop,
  onAdvanceActivePendingUserInput: noop,
  onDismissActivePendingUserInput: noop,
  onPreviousActivePendingUserInputQuestion: noop,
  onChangeActivePendingUserInputCustomAnswer: noop,
  onProviderModelSelect: noop,
  onOpenProviderSetup: noop,
  getModelDisabledReason: () => null,
  scheduleComposerFocus: noop,
  setThreadError: noop,
  onFileOpen: noop,
} satisfies Partial<ChatComposerProps>;

/**
 * The model a message is answered by, chosen beside the approval mode: OrangeAgent's control. It
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
 * How hard the model thinks, chosen beside the model: OrangeAgent's control. It shows the level as
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

/** Where the composer reads the models offered and remembers the one chosen: a conversation's transport, or the box a conversation starts from. */
type ChoiceSource = Pick<ChatTransport, 'capabilities' | 'chosenModel' | 'chooseModel' | 'chosenEffort' | 'chooseEffort' | 'pickDriveFiles'>;

/** The model and the level of effort a message is sent with, each left out when it is the default, and the composer's controls that choose them. */
export interface ModelChoices {
  readonly choice: { readonly model?: string; readonly effort?: ModelEffort };
  /** Whether Google Picker is configured, so a file can be saved in a Drive folder the person chooses. */
  readonly drivePicker: boolean;
  readonly extraControls: ReactNode;
  readonly extraAttachActions: ChatComposerProps['extraAttachActions'];
}

/**
 * The models the server offers, read once, and the one chosen: a model this browser chose that
 * the server no longer offers falls back to the default, and a level the model does not take to
 * the one it thinks at when none is named. The default of each goes unnamed, so the server
 * answers with whatever its default is when the message arrives.
 */
export const useModelChoices = (source: ChoiceSource, onManageModels: (() => void) | undefined): ModelChoices => {
  const [capabilities, setCapabilities] = useState<ChatCapabilities>(NO_CAPABILITIES);
  const [picked, setPicked] = useState<string | null>(() => source.chosenModel?.() ?? null);
  const [pickedEffort, setPickedEffort] = useState<ModelEffort | null>(() => source.chosenEffort?.() ?? null);
  useEffect(() => {
    let current = true;
    source.capabilities?.().then((read) => {
      if (current) setCapabilities(read);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [source]);
  const models = capabilities.models;
  const model = picked !== null && models.includes(picked) ? picked : models[0] ?? '';
  const chosenModel = model && model !== models[0] ? model : undefined;
  const efforts = capabilities.efforts[model]?.levels ?? NO_EFFORTS;
  const fallbackEffort = capabilities.efforts[model]?.default ?? null;
  const effort = pickedEffort !== null && efforts.includes(pickedEffort) ? pickedEffort : fallbackEffort;
  const chosenEffort = effort !== null && effort !== fallbackEffort ? effort : undefined;
  const chooseModel = (next: string): void => {
    setPicked(next);
    source.chooseModel?.(next);
  };
  const chooseEffort = (next: ModelEffort): void => {
    setPickedEffort(next);
    source.chooseEffort?.(next);
  };
  const pick = source.pickDriveFiles;
  return {
    drivePicker: capabilities.drivePicker,
    choice: { ...(chosenModel ? { model: chosenModel } : {}), ...(chosenEffort ? { effort: chosenEffort } : {}) },
    extraControls: models.length > 0 ? (
      <>
        <ModelChoice models={models} model={model} onChange={chooseModel} onManage={onManageModels} />
        {efforts.length > 1 ? <EffortChoice efforts={efforts} fallback={fallbackEffort} effort={effort} onChange={chooseEffort} /> : null}
      </>
    ) : undefined,
    extraAttachActions: capabilities.drivePicker && pick
      ? (attach) => <DriveAttachButton pick={() => pick()} attach={attach} />
      : undefined,
  };
};
