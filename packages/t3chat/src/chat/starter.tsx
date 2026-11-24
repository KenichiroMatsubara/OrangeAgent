/**
 * The box a conversation starts from: a conversation's own composer (composer.tsx), with the same
 * editor, attachments, model choices and Enter key, shown before there is a conversation. What is
 * sent from it starts one, in the approval mode chosen in it; the screen that shows it opens that
 * conversation.
 */
import { type ModelSelection, ThreadId } from '@t3tools/contracts';
import { scopeThreadRef } from '@t3tools/client-runtime/environment/index.ts';
import { type ReactElement, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { ChatComposer, type ChatComposerHandle } from '~/components/chat/ChatComposer';
import { ComposerSurface } from '~/components/chat/ComposerSurface';
import type { ExpandedImagePreview } from '~/components/chat/ExpandedImagePreview';
import { ExpandedImageDialog } from '~/components/chat/ExpandedImageDialog';
import { useComposerDraftStore } from '~/composerDraftStore';
import type { ComposerFileAttachment, ComposerImageAttachment } from '~/composerDraftStore';
import type { TerminalContextDraft } from '~/lib/terminalContext';

import type { ChatMode, ChatStarterProps, ChatStartModes } from './api.ts';
import { COMPOSER_FIXED, ENVIRONMENT_ID, noop, NO_MODEL, useModelChoices, writtenText } from './composer.tsx';
import { ChatFrame } from './frame.tsx';
import { chatModeOf, runtimeModeOf } from './modes.ts';
import { orangeagentProvider } from './provider.ts';

/** The draft the box keeps, under an id no conversation has, so what is written stays until it is sent. */
const START_THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make('orangeagent-start'));

function Starter({ source, busy, onManageModels, ref }: ChatStarterProps): ReactElement {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef('');
  const imagesRef = useRef<ComposerImageAttachment[]>([]);
  const filesRef = useRef<ComposerFileAttachment[]>([]);
  const terminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const [multipleModels, setMultipleModels] = useState<ReadonlyArray<ModelSelection> | null>(null);
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const { choice, extraControls, extraAttachActions } = useModelChoices(source, onManageModels);
  // The modes offered and the one a new conversation starts in, as the server says; the mode chosen here, once one is.
  const [offered, setOffered] = useState<ChatStartModes | null>(null);
  const [picked, setPicked] = useState<ChatMode | null>(null);
  useEffect(() => {
    let current = true;
    // Unread, no mode is offered and the conversation starts in the one the server gives it.
    source.modes().then((read) => {
      if (current) setOffered(read);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [source]);
  const mode = picked ?? offered?.mode ?? null;
  const providers = useMemo(() => [orangeagentProvider((offered?.modes ?? []).map(runtimeModeOf))], [offered]);

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
    // Only a mode chosen here is named; one left as it is, the server gives the new conversation itself.
    void source.start(text, { files, ...choice, ...(picked !== null ? { mode: picked } : {}) }).then((started) => {
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
              runtimeMode={mode === null ? 'full-access' : runtimeModeOf(mode)}
              providerStatuses={providers}
              activeThreadModelSelection={NO_MODEL}
              activeProjectId={null}
              onComposerOverlayHeightChange={noop}
              // Until the server says which modes it offers and which a new conversation starts in, none is shown.
              permissionsShownInStrip={mode === null}
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
              handleRuntimeModeChange={(next) => setPicked(chatModeOf(next))}
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
