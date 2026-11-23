import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a control with no other visible outcome keeps reporting that it finished. */
export const SETTLED_NOTICE_MS = 2_000;

/**
 * The identity of one in-flight operation. Every control that starts work names
 * the exact work it started, so progress is never reported on an unrelated
 * control and two controls never share one flag.
 */
export const pendingKey = {
  logout: 'session:logout',
  reauthenticate: 'session:reauthenticate',
  switchPerson: 'session:switch',
  lineConnection: 'connection:line',
  aiConnection: 'connection:ai',
  transcriptionConnection: 'connection:transcription',
  transcriptionRemoval: 'connection:transcription-removal',
  recordingUpload: 'transcript:upload',
  chatThreadCreate: 'chat-thread:create',
  chatThreadRename: (threadId: string): string => `chat-thread:rename:${threadId}`,
  chatThreadDelete: (threadId: string): string => `chat-thread:delete:${threadId}`,
  pushDevice: 'push:device',
  transcriptRename: (transcriptId: string): string => `transcript:rename:${transcriptId}`,
  transcriptRemove: (transcriptId: string): string => `transcript:remove:${transcriptId}`,
  transcriptAgain: (transcriptId: string): string => `transcript:again:${transcriptId}`,
  minutesWrite: (transcriptId: string): string => `transcript:minutes:${transcriptId}`,
  microsoftConnection: 'connection:microsoft',
  driveFolderAdd: 'drive-folder:add',
  browserEnabled: 'browser:enabled',
  browserSignIn: 'browser:sign-in',
  browserTimeZone: 'browser:time-zone',
  browserLogin: (loginId: string): string => `browser:login:${loginId}`,
  driveFolderRemove: (folderId: string): string => `drive-folder:remove:${folderId}`,
  aiTest: 'connection:ai-test',
  automationTrial: (automationId: string): string => `automation:trial:${automationId}`,
  skillCreate: 'skill:create',
  skillUpdate: (skillId: string): string => `skill:update:${skillId}`,
  skillDelete: (skillId: string): string => `skill:delete:${skillId}`,
  skillImport: 'skill:import',
  memorySave: 'memory:save',
  memorySearch: 'memory:search',
  memoryUpdate: (memoryId: string): string => `memory:update:${memoryId}`,
  memoryForget: (memoryId: string): string => `memory:forget:${memoryId}`,
  skillExport: 'skill:export',
  automationCreate: 'automation:create',
  automationUpdate: (automationId: string): string => `automation:update:${automationId}`,
  automationRemove: (automationId: string): string => `automation:remove:${automationId}`,
  runTranscript: (runId: string): string => `run:transcript:${runId}`,
  runDecision: (runId: string, decision: string): string => `run:${runId}:${decision}`,
  presetApply: (presetId: string): string => `preset:${presetId}`,
  contactCreate: 'member:create',
  contactUpdate: (contactId: string): string => `member:update:${contactId}`,
  contactDelete: (contactId: string): string => `member:delete:${contactId}`,
  contactRefresh: 'member:refresh',
  lineDestinationSet: (contactId: string): string => `line-destination:set:${contactId}`,
  lineDestinationUnlink: (lineDestinationId: string): string => `line-destination:unlink:${lineDestinationId}`,
  lineDestinationRegister: 'line-destination:register',
  lineDestinationRemove: (lineDestinationId: string): string => `line-destination:remove:${lineDestinationId}`,
  exceptionResolve: (id: string): string => `exception:resolve:${id}`,
  accountSuspension: 'account:suspension',
  contactImport: 'member:import',
  portalAttendance: (eventId: string, status: string): string => `portal:attendance:${eventId}:${status}`,
  portalComment: (eventId: string): string => `portal:comment:${eventId}`,
  portalLogout: 'portal:logout',
} as const;

/** What the screen says it is doing, keyed by the start of an operation key. */
const OPERATION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['automation:trial:', 'AI が試しに動いています'],
  ['session:logout', 'ログアウトしています'],
  ['session:reauthenticate', 'Google に接続しています'],
  ['connection:ai-test', 'AI に問い合わせています'],
  ['drive-folder:add', 'フォルダを確かめています'],
  ['drive-folder:remove:', 'フォルダを外しています'],
  ['connection:', '接続設定を保存しています'],
  ['skill:create', 'スキルを作成しています'],
  ['skill:update:', 'スキルを保存しています'],
  ['skill:delete:', 'スキルを削除しています'],
  ['skill:import', 'スキルを読み込んでいます'],
  ['skill:export', 'スキルを書き出しています'],
  ['automation:create', '自動化を追加しています'],
  ['automation:update:', '自動化を保存しています'],
  ['automation:remove:', '自動化を削除しています'],
  ['chat-thread:rename:', '会話の名前を変えています'],
  ['chat-thread:delete:', '会話を削除しています'],
  ['run:transcript:', 'AI が読んだものを読み込んでいます'],
  ['run:', '承認を記録しています'],
  ['preset:', 'Preset を適用しています'],
  ['member:create', '連絡先を登録しています'],
  ['member:update:', '連絡先を保存しています'],
  ['member:delete:', '連絡先を削除しています'],
  ['member:refresh', '連絡先を読み直しています'],
  ['line-destination:', 'LINE の連絡先を更新しています'],
  ['exception:resolve:', '例外を解決済みにしています'],
  ['account:suspension', 'Account の状態を変更しています'],
  ['member:import', 'CSV を処理しています'],
  ['portal:attendance:', '出欠を送信しています'],
  ['portal:comment:', 'コメントを保存しています'],
  ['portal:remarks:', '備考を保存しています'],
  ['portal:logout', 'ログアウトしています'],
];

/** The sentence shown for an operation while it runs. */
export const operationLabel = (key: string): string =>
  OPERATION_LABELS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? '処理しています';

export interface PendingOperations {
  /** Every operation the screen has in flight, oldest first. */
  running: readonly string[];
  /** True while the named operation is running. */
  pending: (key: string) => boolean;
  /** True for a short while after the named operation succeeded. */
  settled: (key: string) => boolean;
  error: string;
  setError: (message: string) => void;
  run: (key: string, work: () => Promise<void>) => Promise<void>;
}

const withoutOne = (keys: readonly string[], key: string): readonly string[] => {
  const at = keys.indexOf(key);
  return at < 0 ? keys : [...keys.slice(0, at), ...keys.slice(at + 1)];
};

/** Tracks every operation a screen has in flight, and the error of the last one to fail. */
export const usePendingOperations = (): PendingOperations => {
  const [running, setRunning] = useState<readonly string[]>([]);
  const [succeeded, setSucceeded] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  const run = useCallback(async (key: string, work: () => Promise<void>): Promise<void> => {
    setRunning((current) => [...current, key]);
    setSucceeded((current) => current.filter((finished) => finished !== key));
    setError('');
    try {
      await work();
      setSucceeded((current) => [...current, key]);
      timers.current.push(setTimeout(
        () => setSucceeded((current) => current.filter((finished) => finished !== key)),
        SETTLED_NOTICE_MS,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作に失敗しました。');
    } finally {
      setRunning((current) => withoutOne(current, key));
    }
  }, []);

  return {
    running,
    pending: (key: string): boolean => running.includes(key),
    settled: (key: string): boolean => succeeded.includes(key),
    error,
    setError,
    run,
  };
};
