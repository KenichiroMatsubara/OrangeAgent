import type { AccountMembership } from './views';

export type ProvisioningPhase =
  | 'allocating_database'
  | 'applying_schema'
  | 'storing_credentials'
  | 'verifying_binding'
  | 'activating_organization';

export interface AppIdentity {
  email: string;
  displayName: string;
}

/** One Google account this browser is signed in to. */
export interface SignedInPerson {
  /** Names the person to switch to or sign out; it is never shown. */
  identityId: string;
  email: string;
  displayName: string;
  /** The person's own Account, or null while they have none. */
  account: AccountMembership | null;
}

/** What every signed-in state carries: who the browser is now, and everyone it is signed in as, that person first. */
export interface SignedInState {
  identity: AppIdentity;
  people: SignedInPerson[];
}

export type AppState =
  | { kind: 'signed_out' }
  | ({ kind: 'unassigned' } & SignedInState)
  | ({
    kind: 'provisioning';
    account: { id: string; name: string };
    phase: ProvisioningPhase | null;
  } & SignedInState)
  | ({
    kind: 'provisioning_failed';
    account: { id: string; name: string };
    phase: ProvisioningPhase | null;
    error: string | null;
    retryUntil: string;
  } & SignedInState)
  | ({ kind: 'ready'; account: AccountMembership } & SignedInState)
  | ({ kind: 'member'; account: { accountId: string; name: string } } & SignedInState);

export type * from './views';

export { batchLineMessages, discoveredLineDestinations, verifyLineWebhookSignature } from './line';
export type { LineBatch, LineDestination, LineMessage } from './line';
export { canUpdateAttendance } from './attendance';
export type { AttendanceLinkCheck } from './attendance';
export { MAX_DELIVERY_ATTEMPTS, MAX_RETRY_WINDOW_MS, nextRetry } from './retry';
export type { RetryDecision } from './retry';
export { CAPACITY_CRITICAL_THRESHOLD, CAPACITY_WARNING_THRESHOLD, capacityWarning } from './capacity';
export type { CapacityWarning } from './capacity';
export { canConsumeContactLink } from './member-links';
export type { ContactLinkCheck } from './member-links';
export { shouldWriteRecoveryReceipt } from './recovery';
export { displayLineDestinationId } from './privacy';
export { tokyoDay, tokyoDaysBetween } from './days';
export { CONTACT_CSV_COLUMNS, CONTACT_CSV_INSTRUCTIONS, CONTACT_CSV_SAMPLE, ContactCsvRefusal, contactCsvTags, readContactCsv, writeContactCsv } from './roster';
export type { ContactCsv, ContactCsvColumn, ContactCsvField, ContactCsvProblem, ContactCsvRow } from './roster';
export {
  CHAT_ATTACHMENT_TYPES,
  CHAT_THREAD_FORM,
  CHAT_THREAD_GONE,
  isChatDelivery,
  CHAT_STOPPED_NOTE,
  CONVERSATION_TITLE_LENGTH,
  LOOKABLE_IMAGE_BYTES,
  chatContentType,
  chatGeneratedFileType,
  isChatAttachmentType,
  isChatShownType,
  unreadableChatAttachmentText,
  unsupportedChatAttachmentText,
} from './chat';
export type { ChatAttachmentType } from './chat';
export {
  SKILL_DESCRIPTION_LIMIT,
  SKILL_INSTRUCTIONS_FILE,
  SKILL_NAME_LIMIT,
  SKILL_TITLE_KEY,
  checkSkillDocument,
  isSkillName,
  checkSkillFolder,
  isSkillInstructionsPath,
  readSkillDocument,
  readSkillFilePath,
  sizeLabel,
  skillDocumentRefusalText,
  skillFileText,
  skillFileType,
  skillFolderRefusalText,
  writeSkillDocument,
} from './skills';
export type { ReadSkillDocument, SkillDocument, SkillDocumentRefusal, SkillDocumentResult, SkillFolderRefusal, SkillFolderResult } from './skills';
export { ACCESS_TOKEN_RUN, ACCESS_TOKEN_TOOLS, AUTOMATION_TOOLS, OPERATOR_CHAT_RUN, OPERATOR_TOKEN_RUN, RESERVED_TOOL_NAMESPACES, TOOLS, automationRun, selectTools, toolNamed, withCode, withoutBrowser, withoutMailbox, BROWSER_TOOLS, APPROVAL_TOOLS, TOOL_LABELS, asksApproval, toolLabel } from './tools';
export { callPreview, eventTimeText, EVENT_TOOLS, PREVIEWED_TOOLS, PREVIEW_BODY_CHARACTERS } from './preview';
export type { PreviewEvent } from './preview';
export type { Tool, ToolName, ToolNeed, ToolRun, ToolWrites } from './tools';
export { CHAT_APPROVAL_LABELS, CHAT_MODE_LABELS, CHAT_MODES, DEFAULT_CHAT_MODE, isChatApproval, isChatMode } from './approvals';
export type { ChatApproval, ChatMode } from './approvals';
export {
  DEFAULT_TRANSCRIPTION_MODEL,
  MINUTES_MISSING,
  RECORDING_BYTES,
  RECORDING_FORMATS,
  RECORDING_PICKABLE,
  TRANSCRIPTION_MISSING,
  elapsed,
  isRecordingType,
  oversizedRecordingText,
  recordingType,
  transcriptPlainText,
  unsupportedRecordingText,
} from './recordings';
export type { RecordingType, TranscriptLineText } from './recordings';
export { AI_BASE_URLS, AI_PROVIDERS, ANTHROPIC_HOST, GEMINI_HOST, OPENAI_HOST, OPENROUTER_HOST, aiEnvironment, aiProviderOf, isAiProvider, type AiEnvironment, type AiProvider } from './environment';
export { AI_MODEL_LIMIT, CLAUDE_MODELS, EFFORT_LABELS, MODEL_EFFORTS, isModelEffort, modelLabel, modelNameProblem, shortModelLabel, type ModelEffort, type ModelEfforts } from './models';
