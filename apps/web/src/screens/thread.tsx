import { ChevronLeft, Pencil, Trash2 } from 'lucide-react';
import { createContext, lazy, Suspense, use, useCallback, useContext, useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { ChatSurfaceProps, ChatTransport } from '@mail/t3chat';

import { api } from '../api';
import { useAccount } from '../dashboard';
import { accountUrl } from '../router';
import { createThreadTransport } from '../threads';
import { SkeletonBlock } from '../ui/skeleton';
import { DeleteSheet, RenameSheet, UNTITLED } from './sheets';

import styles from './thread.module.css';

/** The chat copied from t3code is a separate chunk, so no other screen loads it. */
const LoadedSurface = lazy(() => import('@mail/t3chat/surface'));

/** The chat the screen shows its conversation in; a test hands it one that plays only the bar's part. */
export const SurfaceContext = createContext<ComponentType<ChatSurfaceProps>>(LoadedSurface);

/** The screen reads nothing before it shows; the chat follows its conversation itself. */
export const loader = async (): Promise<null> => null;

interface Demo {
  readonly threadId: string;
  readonly transport: ChatTransport;
  readonly fork: string;
}

let demo: Promise<Demo> | null = null;

/** The mocked GUI's conversation, played in the page whichever conversation is opened, and the one continued from it. */
const loadDemo = (): Promise<Demo> => {
  demo ??= import('@mail/t3chat/fake').then(({ createFakeTransport, FAKE_FORK_ID, FAKE_THREAD_ID }) => ({ threadId: FAKE_THREAD_ID, transport: createFakeTransport(), fork: FAKE_FORK_ID }));
  return demo;
};

interface ChatProps {
  readonly threadId: string;
  readonly onOpenThread: (threadId: string) => void;
  readonly onTitle: (title: string) => void;
  readonly onManageModels: () => void;
}

const DemoChat = ({ threadId, onOpenThread, onTitle, onManageModels }: ChatProps) => {
  const { threadId: sample, transport, fork } = use(loadDemo());
  const ChatSurface = useContext(SurfaceContext);
  return <ChatSurface threadId={threadId === fork ? fork : sample} transport={transport} onOpenThread={onOpenThread} onTitle={onTitle} onManageModels={onManageModels} />;
};

const LiveChat = ({ threadId, onOpenThread, onTitle, onManageModels }: ChatProps) => {
  const { account } = useAccount();
  const transport = useMemo(() => createThreadTransport({ accountId: account.accountId, threadId }), [account.accountId, threadId]);
  const ChatSurface = useContext(SurfaceContext);
  return <ChatSurface threadId={threadId} transport={transport} onOpenThread={onOpenThread} onTitle={onTitle} onManageModels={onManageModels} />;
};

/**
 * One conversation of Operator Chat (ADR 0201), followed live from its
 * Durable Object, under a bar that leads back to the list, names the
 * conversation, and renames or deletes it.
 */
const ThreadScreen = () => {
  const threadId = useParams().threadId ?? '';
  const { account } = useAccount();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [managing, setManaging] = useState<'rename' | 'delete' | null>(null);
  const list = accountUrl('chat');
  const open = useCallback((opened: string) => navigate(`${list}/${encodeURIComponent(opened)}`), [list, navigate]);
  // The model menu's way to add models: the connections screen, opened at the AI Connection.
  const manageModels = useCallback(() => navigate(`${accountUrl('connections')}?sheet=ai`), [navigate]);
  // A conversation copied from the chat before ADR 0201 opens under its own id too.
  const named = title || UNTITLED;
  return <div className={styles.frame}>
    <nav className={styles.bar}>
      <Link to={list} className={styles.back} aria-label="会話の一覧"><ChevronLeft size={18} aria-hidden="true" /><span className={styles.backLabel}>会話の一覧</span></Link>
      <span className={styles.title} title={named}>{title ? named : ''}</span>
      <button type="button" className={styles.action} aria-label="会話の名前を変える" title="会話の名前を変える" disabled={!title} onClick={() => setManaging('rename')}><Pencil size={16} aria-hidden="true" /></button>
      <button type="button" className={styles.action} aria-label="会話を削除" title="会話を削除" disabled={!title} onClick={() => setManaging('delete')}><Trash2 size={16} aria-hidden="true" /></button>
    </nav>
    <div className={styles.chat}>
      <Suspense fallback={<SkeletonBlock height={320} />}>
        {import.meta.env.MODE === 'mock'
          ? <DemoChat key={threadId} threadId={threadId} onOpenThread={open} onTitle={setTitle} onManageModels={manageModels} />
          : <LiveChat key={threadId} threadId={threadId} onOpenThread={open} onTitle={setTitle} onManageModels={manageModels} />}
      </Suspense>
    </div>
    {managing === 'rename' && <RenameSheet
      title={title}
      onRename={async (renamed) => {
        await api.renameChatThread(account.accountId, threadId, { title: renamed });
      }}
      onClose={() => setManaging(null)}
    />}
    {managing === 'delete' && <DeleteSheet
      title={title}
      onDelete={async () => {
        await api.deleteChatThread(account.accountId, threadId);
        navigate(list);
      }}
      onClose={() => setManaging(null)}
    />}
  </div>;
};

export default ThreadScreen;
