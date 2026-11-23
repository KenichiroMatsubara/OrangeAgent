import { ArrowUp, CalendarDays, CircleAlert, Clock, FileSpreadsheet, MessageSquarePlus, MessagesSquare, Paperclip, Pencil, Trash2, Users, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLoaderData, useNavigate, useRevalidator } from 'react-router-dom';

import { EFFORT_LABELS, isModelEffort, shortModelLabel, type ChatCapabilities, type ChatThread, type ChatThreadMessage, type ModelEffort, type PushSettings } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { NotificationSettings } from '../notifications';
import { browserDevice, mockDevice, type Device } from '../push';
import { pendingKey, usePendingOperations } from '../pending';
import { prepareFiles } from '../photos';
import { rememberedEffort, rememberedModel, rememberEffort, rememberModel } from '../threads';
import { momentLabel, timeLabel } from '../time';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Search } from '../ui/field';
import { ActionRow, List } from '../ui/list';
import { Banner, Empty } from '../ui/notice';
import { Note, Section } from '../ui/page';
import { SkeletonBlock, SkeletonRows } from '../ui/skeleton';
import { DeleteSheet, RenameSheet, UNTITLED } from './sheets';

import styles from './chat.module.css';

export interface ChatData {
  threads: Promise<ChatThread[]>;
  push: Promise<PushSettings>;
  capabilities: Promise<ChatCapabilities>;
}

/** Returns at once; the conversations, whether this FlareChat can notify, and the models it answers with fill in as they are read. */
export const loader = async (): Promise<ChatData> => {
  const accountId = await accountIdOf();
  return { threads: later(api.chatThreads(accountId)), push: later(api.pushSettings(accountId)), capabilities: later(api.chatCapabilities(accountId)) };
};

/** What the box sends with its words: the model and the level of effort, each left out when it is the default, as a conversation's own composer leaves them. */
export interface Choice {
  readonly model?: string;
  readonly effort?: ModelEffort;
}

/**
 * The model and the level of effort the box shows, from what this browser
 * chose last: a model the AI Connection no longer names falls back to its
 * default, and a level the model does not take to the one it thinks at when
 * none is named.
 */
export const chosen = (capabilities: ChatCapabilities, picked: string | null, pickedEffort: ModelEffort | null): { model: string; effort: ModelEffort | null; choice: Choice } => {
  const models = capabilities.models;
  const model = picked !== null && models.includes(picked) ? picked : models[0] ?? '';
  const levels = capabilities.efforts[model]?.levels ?? [];
  const fallback = capabilities.efforts[model]?.default ?? null;
  const effort = pickedEffort !== null && levels.includes(pickedEffort) ? pickedEffort : fallback;
  const choice: Choice = {
    ...(model && model !== models[0] ? { model } : {}),
    ...(effort !== null && effort !== fallback ? { effort } : {}),
  };
  return { model, effort, choice };
};

/** The files a message may carry, as a conversation's own composer offers them. */
const ATTACHABLE = 'image/*,application/pdf,.pdf,.docx,.xlsx,.csv,.txt,text/plain,text/csv';

const NO_CAPABILITIES: ChatCapabilities = { models: [], efforts: {}, drivePicker: false };

/** This browser, or, in the mocked GUI, which has no Service Worker, the one `?device=` names. */
const thisDevice = (): Device => import.meta.env.MODE === 'mock'
  ? mockDevice(new URLSearchParams(window.location.search).get('device'))
  : browserDevice();

/** Where the screen gets the browser it asks about notifications; a test hands it one it plays. */
export const DeviceContext = createContext<() => Device>(thisDevice);

/** The conversations whose name holds every word searched for, as the chat before ADR 0201 searched them. */
export const matching = (threads: readonly ChatThread[], query: string): ChatThread[] => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return threads.filter((thread) => words.every((word) => (thread.title || UNTITLED).toLowerCase().includes(word)));
};

/** The greeting for the hour it is in Tokyo, naming the person when their name is known. */
export const greeting = (name: string, now: Date = new Date()): string => {
  const hour = Number(timeLabel(now).slice(0, 2));
  const word = hour >= 4 && hour < 11 ? 'おはようございます' : hour >= 11 && hour < 18 ? 'こんにちは' : 'こんばんは';
  return name.trim() ? `${word}、${name.trim()}さん` : word;
};

/** What the composer offers to ask, each put in it to send or rewrite. */
const SUGGESTIONS: ReadonlyArray<{ readonly label: string; readonly text: string; readonly icon: ReactNode }> = [
  { label: '今日の予定', text: '今日の予定を教えて', icon: <CalendarDays size={16} aria-hidden="true" /> },
  { label: '空いている時間', text: '来週、1 時間の打ち合わせを入れられる空き時間を教えて', icon: <Clock size={16} aria-hidden="true" /> },
  { label: '連絡先を探す', text: '連絡先から', icon: <Users size={16} aria-hidden="true" /> },
  { label: 'Excel にまとめる', text: '今月の予定を Excel にまとめて', icon: <FileSpreadsheet size={16} aria-hidden="true" /> },
];

/** How many conversations the list shows before it is asked for all of them. */
const RECENT = 5;

/** What a member is doing to one conversation of the list: renaming it or deleting it. */
type Managing = { readonly kind: 'rename' | 'delete'; readonly thread: ChatThread };

const ThreadRows = ({ threads, onManage }: { threads: ChatThread[]; onManage: (managing: Managing) => void }) => {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  if (threads.length === 0) return <Empty icon={<MessagesSquare size={28} aria-hidden="true" />} title="会話はまだありません" text="上の欄に聞きたいことを書いて送ると、会話が始まります。" />;
  const found = matching(threads, query);
  // While searching, every conversation that matches is shown.
  const shown = all || query.trim() ? found : found.slice(0, RECENT);
  return <>
    <Search label="会話を探す" placeholder="会話の名前で探す" value={query} onChange={setQuery} />
    {found.length === 0
      ? <Note>「{query.trim()}」を名前に含む会話はありません。</Note>
      : <List label="会話">{shown.map((thread) => <ActionRow
        key={thread.id}
        to={encodeURIComponent(thread.id)}
        label={`${thread.title || UNTITLED}を開く`}
        leading={<MessagesSquare size={20} aria-hidden="true" />}
        title={thread.title || UNTITLED}
        sub={momentLabel(thread.updatedAt)}
        action={<>
          <Button variant="quiet" small icon={<Pencil size={16} aria-hidden="true" />} aria-label={`${thread.title || UNTITLED}の名前を変える`} onClick={() => onManage({ kind: 'rename', thread })} />
          <Button variant="quiet" small icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`${thread.title || UNTITLED}を削除`} onClick={() => onManage({ kind: 'delete', thread })} />
        </>}
      />)}</List>}
    {shown.length < found.length && <div className={styles.more}>
      <Button variant="quiet" small onClick={() => setAll(true)}>すべての会話を表示（{found.length} 件）</Button>
    </div>}
  </>;
};

/**
 * The model and the level of effort the box sends with, each a select that
 * shows only when there is something to choose: more than one model the AI
 * Connection names, and levels the model chosen takes. What is chosen is
 * remembered in this browser for the Account, where the conversation it opens
 * reads it too (threads.ts).
 */
const ModelChoice = ({ accountId, capabilities, model, effort, onModel, onEffort }: {
  accountId: string;
  capabilities: ChatCapabilities;
  model: string;
  effort: ModelEffort | null;
  onModel: (model: string) => void;
  onEffort: (effort: ModelEffort) => void;
}) => {
  const levels = capabilities.efforts[model]?.levels ?? [];
  const fallback = capabilities.efforts[model]?.default ?? null;
  const pickModel = (event: ChangeEvent<HTMLSelectElement>): void => {
    rememberModel(accountId, event.target.value);
    onModel(event.target.value);
  };
  const pickEffort = (event: ChangeEvent<HTMLSelectElement>): void => {
    if (!isModelEffort(event.target.value)) return;
    rememberEffort(accountId, event.target.value);
    onEffort(event.target.value);
  };
  return <>
    {capabilities.models.length > 1 && <select className={styles.pick} aria-label="答えるモデル" value={model} onChange={pickModel}>
      {capabilities.models.map((name) => <option key={name} value={name}>{shortModelLabel(name)}</option>)}
    </select>}
    {levels.length > 0 && <select className={styles.pick} aria-label="考える深さ" value={effort ?? ''} onChange={pickEffort}>
      {fallback === null && effort === null && <option value="">既定</option>}
      {levels.map((level) => <option key={level} value={level}>{EFFORT_LABELS[level]}</option>)}
    </select>}
  </>;
};

/**
 * The box a conversation starts from: what is written in it, and the files
 * attached, become the first message of a new conversation, answered by the
 * model and at the level of effort chosen in it, which then opens. Enter sends
 * it and Shift+Enter starts a new line; Enter that confirms a Japanese
 * conversion does neither.
 */
const Composer = ({ accountId, capabilities, busy, onAsk }: {
  accountId: string;
  capabilities: Promise<ChatCapabilities>;
  busy: boolean;
  onAsk: (message: ChatThreadMessage, files: readonly File[]) => void;
}) => {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [offered, setOffered] = useState<ChatCapabilities>(NO_CAPABILITIES);
  const [picked, setPicked] = useState<string | null>(() => rememberedModel(accountId));
  const [pickedEffort, setPickedEffort] = useState<ModelEffort | null>(() => rememberedEffort(accountId));
  const field = useRef<HTMLTextAreaElement>(null);
  const clip = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    // Until the models are read, or where they cannot be, the message goes to the default.
    capabilities.then((read) => {
      if (current) setOffered(read);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [capabilities]);
  const { model, effort, choice } = chosen(offered, picked, pickedEffort);
  const ready = (text.trim().length > 0 || files.length > 0) && !busy;
  const submit = (event?: FormEvent<HTMLFormElement>): void => {
    event?.preventDefault();
    if (ready) onAsk({ text: text.trim(), ...choice }, files);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  const suggest = (suggestion: string): void => {
    setText(suggestion);
    field.current?.focus();
  };
  const attach = (event: ChangeEvent<HTMLInputElement>): void => {
    const added = [...(event.target.files ?? [])];
    event.target.value = '';
    if (added.length) setFiles((kept) => [...kept, ...added]);
  };
  return <>
    <form className={styles.composer} onSubmit={submit}>
      <textarea
        ref={field}
        className={styles.input}
        aria-label="AI に聞くこと"
        placeholder="予定や連絡先のこと、何でも聞いてください"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keyDown}
      />
      {files.length > 0 && <ul className={styles.files} aria-label="添付するファイル">
        {files.map((file, index) => <li key={`${file.name}-${index}`} className={styles.file}>
          <span className={styles.fileName}>{file.name}</span>
          <button type="button" className={styles.unattach} aria-label={`${file.name}を外す`} onClick={() => setFiles((kept) => kept.filter((_, at) => at !== index))}><X size={14} aria-hidden="true" /></button>
        </li>)}
      </ul>}
      <div className={styles.controls}>
        <div className={styles.choices}>
          <input ref={clip} type="file" multiple accept={ATTACHABLE} hidden onChange={attach} />
          <button type="button" className={styles.clip} aria-label="ファイルを添付" onClick={() => clip.current?.click()}><Paperclip size={18} aria-hidden="true" /></button>
          <ModelChoice accountId={accountId} capabilities={offered} model={model} effort={effort} onModel={setPicked} onEffort={setPickedEffort} />
        </div>
        <button type="submit" className={styles.send} aria-label="送る" aria-busy={busy || undefined} disabled={!ready}><ArrowUp size={18} aria-hidden="true" /></button>
      </div>
    </form>
    <div className={styles.suggestions} role="group" aria-label="聞くことの例">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion.label} type="button" className={styles.suggestion} onClick={() => suggest(suggestion.text)}>{suggestion.icon}{suggestion.label}</button>)}
    </div>
  </>;
};

/**
 * The top of Operator Chat, laid out as Claude's is: a greeting over the box a
 * conversation starts from, examples of what to ask, then the conversations,
 * the one changed last first, the latest few until all are asked for,
 * searched by name, each renamed or deleted from its row. It is the one place
 * a new one is started, from the box or empty from 新しい会話. Its 通知 section is the one
 * place this browser is set to be notified of what their answers do: the
 * notifications are the chat's alone, and are set per browser rather than for
 * the Account, which 設定 holds.
 */
const ChatScreen = () => {
  const data = useLoaderData<ChatData>();
  const { account, person } = useAccount();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const operations = usePendingOperations();
  const starting = operations.pending(pendingKey.chatThreadCreate);
  const makeDevice = useContext(DeviceContext);
  const device = useMemo(makeDevice, [makeDevice]);
  const [managing, setManaging] = useState<Managing | null>(null);
  const start = (): void => {
    void operations.run(pendingKey.chatThreadCreate, async () => {
      const thread = await api.createChatThread(account.accountId);
      navigate(encodeURIComponent(thread.id));
    });
  };
  const ask = (message: ChatThreadMessage, files: readonly File[]): void => {
    void operations.run(pendingKey.chatThreadCreate, async () => {
      const prepared = await prepareFiles(files);
      const thread = await api.createChatThread(account.accountId);
      await api.sendChatThreadMessage(account.accountId, thread.id, message, prepared);
      navigate(encodeURIComponent(thread.id));
    });
  };
  const rename = async (thread: ChatThread, title: string): Promise<void> => {
    await api.renameChatThread(account.accountId, thread.id, { title });
    await revalidator.revalidate();
  };
  const remove = async (thread: ChatThread): Promise<void> => {
    await api.deleteChatThread(account.accountId, thread.id);
    setManaging(null);
    await revalidator.revalidate();
  };
  return <div className={styles.page}>
    <header className={styles.hero}>
      <h1 className={styles.greeting}>{greeting(person.displayName)}</h1>
      <p className={styles.lead}>予定や連絡先のことを AI に聞けます。</p>
    </header>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Composer accountId={account.accountId} capabilities={data.capabilities} busy={starting} onAsk={ask} />
    <Section title="最近の会話">
      <div className={styles.recentActions}>
        <Button variant="soft" small pill icon={<MessageSquarePlus size={16} aria-hidden="true" />} busy={starting} onClick={start}>新しい会話</Button>
      </div>
      <Deferred value={data.threads} fallback={<SkeletonRows />}>{(threads) => <ThreadRows threads={threads} onManage={setManaging} />}</Deferred>
    </Section>
    <Deferred value={data.push} fallback={<SkeletonBlock height={160} />}>{(settings) => <NotificationSettings settings={settings} device={device} />}</Deferred>
    {managing?.kind === 'rename' && <RenameSheet title={managing.thread.title} onRename={(title) => rename(managing.thread, title)} onClose={() => setManaging(null)} />}
    {managing?.kind === 'delete' && <DeleteSheet title={managing.thread.title} onDelete={() => remove(managing.thread)} onClose={() => setManaging(null)} />}
  </div>;
};

export default ChatScreen;
