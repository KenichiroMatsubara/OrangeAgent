/**
 * The box a conversation starts from: a conversation's own composer (composer.tsx), with the same
 * editor, attachments, model choices and Enter key, shown before there is a conversation. What is
 * sent from it starts one; the screen that shows it opens that conversation.
 */
import { type ModelSelection, ThreadId } from '@t3tools/contracts';
import { scopeThreadRef } from '@t3tools/client-runtime/environment/index.ts';
import { type ReactElement, useImperativeHandle, useRef, useState } from 'react';

import { ChatComposer, type ChatComposerHandle } from '~/components/chat/ChatComposer';
import { ComposerSurface } from '~/components/chat/ComposerSurface';
import type { ExpandedImagePreview } from '~/components/chat/ExpandedImagePreview';
import { ExpandedImageDialog } from '~/components/chat/ExpandedImageDialog';
import { useComposerDraftStore } from '~/composerDraftStore';
import type { ComposerFileAttachment, ComposerImageAttachment } from '~/composerDraftStore';
import type { TerminalContextDraft } from '~/lib/terminalContext';

import type { ChatStarterProps } from './api.ts';
import { COMPOSER_FIXED, ENVIRONMENT_ID, noop, NO_MODEL, useModelChoices, writtenText } from './composer.tsx';
import { ChatFrame } from './frame.tsx';
import { orangeagentProvider } from './provider.ts';

/** The draft the box keeps, under an id no conversation has, so what is written stays until it is sent. */
const START_THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make('orangeagent-start'));
/** A new conversation starts in the mode the server chooses (CONTEXT.md), so the box offers none. */
const PROVIDERS = [orangeagentProvider(['full-access'])];

function Starter({ source, busy, onManageModels, ref }: ChatStarterProps): ReactElement {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef('');
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const [multipleModels, setMultipleModels] = useState<ReadonlyArray<ModelSelection> | null>(null);
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const { choice, extraControls, extraAttachActions } = useModelChoices(source, onManageModels);

  useImperativeHandle(ref, () => ({
    put: (text: string) => {
      useComposerDraftStore.getState().setPrompt(START_THREAD_REF, text);
      promptRef.current = text;
      // Once the editor holds the words, so the caret lands after them.
      window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
    },
  }), []);

  const send = (): void => {
    if (busy) return;
    const text = writtenText(promptRef.current);
    const files = [
      ...imagesRef.current.map((image) => image.file),
      ...filesRef.current.flatMap((file) => file.file === null ? [] : [file.file]),
    ];
    if (text === '' && files.length === 0) return;
    void source.start(text, { files, ...choice }).then((started) => {
      if (!started) return;
      useComposerDraftStore.getState().clearComposerContent(START_THREAD_REF);
      promptRef.current = '';
    });
  };

  return (
    <>
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <div className="relative z-10">
            <ChatComposer
              {...COMPOSER_FIXED}
              composerDraftTarget={START_THREAD_REF}
              routeThreadRef={START_THREAD_REF}
              multipleModelSelections={multipleModels}
              onMultipleModelSelectionsChange={setMultipleModels}
              activeThreadId={null}
              activeThread={undefined}
              activeThreadRuns={[]}
              // The box is the page's main thing; it never folds to a line as a conversation's does.
              forceExpandedOnMobile
              phase="ready"
              canInterrupt={false}
              isSendBusy={busy}
              canSteer={false}
              activePendingApproval={null}
              pendingApprovals={[]}
              respondingRequestIds={[]}
              runtimeMode="full-access"
              providerStatuses={PROVIDERS}
              activeThreadModelSelection={NO_MODEL}
              activeProjectId={null}
              onComposerOverlayHeightChange={noop}
              // The mode is not offered here; the strip would show it.
              permissionsShownInStrip
              promptRef={promptRef}
              composerImagesRef={imagesRef}
              composerFilesRef={filesRef}
              composerTerminalContextsRef={terminalContextsRef}
              composerRef={composerRef}
              editingQueuedAttachments={null}
              onRemoveEditingQueuedAttachment={noop}
              rewindingMessage={false}
              onSend={send}
              onInterrupt={noop}
              handleRuntimeModeChange={noop}
              focusComposer={() => composerRef.current?.focusAtEnd()}
              onExpandImage={setExpanded}
              extraAttachActions={extraAttachActions}
              extraControls={extraControls}
            />
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
      {expanded === null ? null : <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />}
    </>
  );
}

/** The box a conversation starts from, inside `.t3chat` as the chat is; it takes the width of its parent and the height of what it holds. */
export default function ChatStarter(props: ChatStarterProps): ReactElement {
  return (
    <ChatFrame className="w-full bg-transparent">
      <Starter {...props} />
    </ChatFrame>
  );
}
