import { CalendarDays, CircleAlert, Clock, FileSpreadsheet, MessageSquarePlus, MessagesSquare, Pencil, Trash2, Users } from 'lucide-react';
import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useLoaderData, useNavigate, useRevalidator } from 'react-router-dom';

import type { ChatThread, PushSettings } from '@mail/domain';
import type { ChatStarterHandle, ChatStarterProps, ChatStarterSource } from '@mail/t3chat';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { NotificationSettings } from '../notifications';
import { browserDevice, mockDevice, type Device } from '../push';
import { pendingKey, usePendingOperations } from '../pending';
import { prepareFiles } from '../photos';
import { accountUrl } from '../router';
import { createStarterSource } from '../threads';
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
}

/** Returns at once; the conversations and whether this OrangeAgent can notify fill in as they are read, and the box reads the models it offers itself. */
export const loader = async (): Promise<ChatData> => {
  const accountId = await accountIdOf();
  return { threads: later(api.chatThreads(accountId)), push: later(api.pushSettings(accountId)) };
};

/** The box a conversation starts from is a conversation's own composer, in the chat's chunk, which the conversation it opens loads too. */
const LoadedStarter = lazy(() => import('@mail/t3chat/starter'));

/** The box the screen starts a conversation from; a test hands it one that plays only its part. */
export const StarterContext = createContext<ComponentType<ChatStarterProps>>(LoadedStarter);

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

/** Puts an example in the box, to send or rewrite. */
const Suggestions = ({ onPick }: { onPick: (text: string) => void }) =>
  <div className={styles.suggestions} role="group" aria-label="聞くことの例">
    {SUGGESTIONS.map((suggestion) => <button key={suggestion.label} type="button" className={styles.suggestion} onClick={() => onPick(suggestion.text)}>{suggestion.icon}{suggestion.label}</button>)}
  </div>;

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
  const starter = useRef<ChatStarterHandle>(null);
  const Starter = useContext(StarterContext);
  const { run } = operations;
  const accountId = account.accountId;
  // What is written in the box, and the files attached, become the first message of a new conversation, which then opens.
  const source = useMemo<ChatStarterSource>(() => createStarterSource({
    accountId,
    start: async (text, options) => {
      let started = false;
      await run(pendingKey.chatThreadCreate, async () => {
        const prepared = await prepareFiles(options.files ?? []);
        const thread = await api.createChatThread(accountId);
        await api.sendChatThreadMessage(accountId, thread.id, { text, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) }, prepared);
        started = true;
        void navigate(encodeURIComponent(thread.id));
      });
      return started;
    },
  }), [accountId, navigate, run]);
  // The model menu's way to add models: the connections screen, opened at the AI Connection.
  const manageModels = (): void => {
    void navigate(`${accountUrl('connections')}?sheet=ai`);
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
    <div className={styles.starter}>
      <Suspense fallback={<SkeletonBlock height={124} />}>
        <Starter ref={starter} source={source} busy={starting} onManageModels={manageModels} />
      </Suspense>
    </div>
    <Suggestions onPick={(text) => starter.current?.put(text)} />
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
