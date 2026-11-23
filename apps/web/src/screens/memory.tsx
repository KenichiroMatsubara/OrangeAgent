import { Brain, CircleAlert, FileText, MessageSquare, Pencil, Plus, Search as SearchIcon, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router-dom';

import type { Memory, MemoryDetail, MemoryHit, MemoryList, MemorySearch } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { memoryAuthor, memoryChangeAction, memoryChangeActor, memoryEpisodeSource, memoryProvenance, memoryStatus } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { accountUrl } from '../router';
import { momentLabel } from '../time';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Field } from '../ui/field';
import { Banner, Chip, Empty } from '../ui/notice';
import { Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import styles from './memory.module.css';

export interface MemoryData {
  memories: Promise<MemoryList>;
}

/** Returns at once; the Memory fills in as it is read. */
export const loader = async (): Promise<MemoryData> => ({ memories: later(api.memories(await accountIdOf())) });

/** Who wrote a memory and where, in words; the conversation it was kept in opens from it. */
const Source = ({ memory }: { memory: Memory }) => {
  const who = memory.author.kind === 'person'
    ? memory.author.name || memoryAuthor.person
    : `${memoryAuthor[memory.author.kind]}${memory.author.kind === 'cli' && memory.author.name ? ` ・ ${memory.author.name}` : ''}`;
  return <span className={styles.source}>
    <Chip tone={memory.author.kind === 'person' ? 'neutral' : 'brand'}>{who}</Chip>
    {memory.author.conversationId && <Link className={styles.conversation} to={`${accountUrl('chat')}/${encodeURIComponent(memory.author.conversationId)}`}>
      <MessageSquare size={14} aria-hidden="true" />覚えた会話を開く
    </Link>}
    <span>{momentLabel(memory.updatedAt)}{memory.editedBy ? ` ・ ${memory.editedBy} が直しました` : ''}</span>
  </span>;
};

/** One way a memory matched what was asked, as a bar and a percentage, with the number the AI is told. */
const Match = ({ label, value }: { label: string; value: number }) => {
  const percent = Math.round(value * 100);
  return <span className={styles.nearness} title={value.toFixed(2)}>
    <span className={styles.bar} aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
    <span>{label} {percent}%</span>
  </span>;
};

/** How a search found a memory: how near its meaning is, and how many of the words asked it holds. */
const Matches = ({ hit }: { hit: Pick<MemoryHit, 'similarity' | 'keywords'> }) => <span className={styles.matches}>
  {hit.similarity !== null && <Match label="意味の近さ" value={hit.similarity} />}
  {hit.keywords !== null && <Match label="ことばの重なり" value={hit.keywords} />}
</span>;

/** One memory, with its source, and how it matched when a search found it. */
const MemoryCard = ({ memory, hit, focused, onEdit, onExplain, onForget, forgetting }: {
  memory: Memory;
  hit?: Pick<MemoryHit, 'similarity' | 'keywords'>;
  focused: boolean;
  onEdit: () => void;
  onExplain: () => void;
  onForget: () => void;
  forgetting: boolean;
}) => {
  const [confirming, setConfirming] = useState(false);
  return <li className={styles.card} data-focused={focused || undefined} id={`memory-${memory.id}`}>
    {hit && <Matches hit={hit} />}
    <p className={styles.content}>{memory.content}</p>
    <div className={styles.foot}>
      <Source memory={memory} />
      <span className={styles.actions}>
        {memory.status !== 'active' && <Chip tone="neutral">{memoryStatus[memory.status]}</Chip>}
        <Button variant="quiet" small icon={<FileText size={16} aria-hidden="true" />} onClick={onExplain}>根拠</Button>
        <Button variant="quiet" small icon={<Pencil size={16} aria-hidden="true" />} onClick={onEdit}>直す</Button>
        {confirming
          ? <Button variant="danger" small busy={forgetting} icon={<Trash2 size={16} aria-hidden="true" />} onClick={onForget}>{forgetting ? '削除しています…' : '本当に削除する'}</Button>
          : <Button variant="quiet" small icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setConfirming(true)}>削除</Button>}
      </span>
    </div>
  </li>;
};

/** Writes a new memory, or changes one, in a sheet over the screen. */
const MemoryEditor = ({ memory, onClose, onSaved }: { memory: Memory | null; onClose: () => void; onSaved: () => Promise<void> }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [content, setContent] = useState(memory?.content ?? '');
  const key = memory ? pendingKey.memoryUpdate(memory.id) : pendingKey.memorySave;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void operations.run(key, async () => {
      if (memory) await api.updateMemory(account.accountId, memory.id, content);
      else await api.saveMemory(account.accountId, content);
      await onSaved();
      onClose();
    });
  };
  return <Sheet title={memory ? '記憶を直す' : '記憶を足す'} onClose={onClose} onSubmit={submit}>
    <Note>AI がチャット・CLI・自動化で、意味の近いものを探して読みます。</Note>
    <Field label="覚えること">{(control) => <textarea
      {...control}
      className={`${control.className} ${styles.editor}`}
      value={content}
      placeholder="例：田中さんへの連絡はメールではなく LINE で送る"
      onChange={(event) => setContent(event.target.value)}
    />}</Field>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Button type="submit" block busy={operations.pending(key)} disabled={!content.trim()}>{memory ? '直す' : '覚える'}</Button>
  </Sheet>;
};

/** The words a memory rests on in its Episode, marked where they are. */
const Evidence = ({ episode }: { episode: NonNullable<MemoryDetail['episode']> }) => {
  if (!episode.evidence) return <p className={styles.episode}>{episode.content}</p>;
  const { start, end } = episode.evidence;
  return <p className={styles.episode}>
    {episode.content.slice(0, start)}<mark>{episode.content.slice(start, end)}</mark>{episode.content.slice(end)}
  </p>;
};

/** Why the Account remembers a memory: who said it, the words it rests on as they were said, and every change since. */
const MemoryExplanation = ({ memory, onClose }: { memory: Memory; onClose: () => void }) => {
  const { account } = useAccount();
  const [detail, setDetail] = useState<Promise<MemoryDetail> | null>(null);
  useEffect(() => { setDetail(api.memory(account.accountId, memory.id)); }, [account.accountId, memory.id]);
  return <Sheet title="この記憶の根拠" onClose={onClose}>
    <p className={styles.content}>{memory.content}</p>
    {detail
      ? <Deferred value={detail} fallback={<SkeletonRows />}>{(found) => <>
        <Section title="もとのことば" lead={found.episode
          ? `${memoryEpisodeSource[found.episode.source]}${found.episode.memberName ? `（${found.episode.memberName}）` : ''} ・ ${momentLabel(found.episode.receivedAt)}。${memoryProvenance[found.memory.provenance]}として覚えています。`
          : 'もとのことばは残っていません。'}>
          {found.episode && <Evidence episode={found.episode} />}
        </Section>
        <Section title="変更の記録">
          <ol className={styles.history} aria-label="変更の記録">{found.changes.map((change, index) => <li key={`${change.at}-${index}`}>
            <span>{momentLabel(change.at)}</span>
            <span>{change.actor.name || memoryChangeActor[change.actor.kind]} が{memoryChangeAction[change.action] ?? change.action}</span>
          </li>)}</ol>
        </Section>
      </>}</Deferred>
      : <SkeletonRows />}
  </Sheet>;
};

/** The search a member makes the way an AI does, and what it found. */
const MemorySearchPanel = ({ focus, onEdit, onExplain, onForget, forgetting }: {
  focus: string | null;
  onEdit: (memory: Memory) => void;
  onExplain: (memory: Memory) => void;
  onForget: (memory: Memory) => Promise<boolean>;
  forgetting: (memoryId: string) => boolean;
}) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<MemorySearch | null>(null);
  const search = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void operations.run(pendingKey.memorySearch, async () => setFound(await api.searchMemories(account.accountId, query)));
  };
  return <Section title="AI と同じように探す" lead="AI の memory.search と同じ検索です。意味が近い（50% を超える）か、探すことばの 60% 以上を含む記憶だけが、よく当たる順に 10 件まで出ます。どれも当たらなければ、AI にも「確かな記憶はない」と返り、推測で答えないよう伝えます。">
    <form className={styles.search} onSubmit={search} role="search">
      <label className={styles.searchBox}>
        <SearchIcon size={18} aria-hidden="true" />
        <span className="fc-sr-only">記憶を探す</span>
        <input type="search" value={query} placeholder="例：田中さんに連絡するには？" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <Button type="submit" busy={operations.pending(pendingKey.memorySearch)} disabled={!query.trim()}>探す</Button>
    </form>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {found && (found.hits.length === 0
      ? <Note>「{found.query}」について確かな記憶はありません。AI にもそう返ります。</Note>
      : <>
        <Note>「{found.query}」でよく当たる順に {found.hits.length} 件。AI にはこのとおりに返ります。</Note>
        <ul className={styles.cards} aria-label="見つかった記憶">{found.hits.map((hit) => <MemoryCard
          key={hit.memory.id}
          memory={hit.memory}
          hit={hit}
          focused={hit.memory.id === focus}
          onEdit={() => onEdit(hit.memory)}
          onExplain={() => onExplain(hit.memory)}
          onForget={() => void onForget(hit.memory).then((forgotten) => {
            if (forgotten) setFound((current) => current && { ...current, hits: current.hits.filter((kept) => kept.memory.id !== hit.memory.id) });
          })}
          forgetting={forgetting(hit.memory.id)}
        />)}</ul>
      </>)}
  </Section>;
};

/**
 * The Account's Memory: what Operator Chat's AI, a member's CLI, or a member
 * here chose to keep. Every memory any run recalls is on this screen, where it
 * is searched the way the AI searches it, traced to the words it rests on,
 * corrected, and erased.
 */
const MemoryScreen = () => {
  const data = useLoaderData<MemoryData>();
  const { account } = useAccount();
  const revalidator = useRevalidator();
  const operations = usePendingOperations();
  const [searchParams] = useSearchParams();
  const focus = searchParams.get('focus');
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [explaining, setExplaining] = useState<Memory | null>(null);

  useEffect(() => {
    if (!focus) return;
    void data.memories.then(() => document.getElementById(`memory-${focus}`)?.scrollIntoView({ block: 'center' })).catch(() => undefined);
  }, [data.memories, focus]);

  /** Whether the memory was deleted; a failure is shown where the list is. */
  const forget = async (memory: Memory): Promise<boolean> => {
    let forgotten = false;
    await operations.run(pendingKey.memoryForget(memory.id), async () => {
      await api.eraseMemory(account.accountId, memory.id);
      forgotten = true;
      await revalidator.revalidate();
    });
    return forgotten;
  };
  const forgetting = (memoryId: string): boolean => operations.pending(pendingKey.memoryForget(memoryId));

  return <Page
    title="記憶"
    lead="AI が覚えていることです。チャットと CLI の AI は、頼まれたことや後で要る事実を、話した人のことばのまま覚えます。同じことばは二度覚えません。チャット・CLI・自動化の AI はここから思い出して使います。ここで探し方を試し、根拠を確かめ、間違いを直し、要らないものを消せます。"
    back={{ to: '../more', label: 'その他' }}
    actions={<Button pill icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing('new')}>足す</Button>}
  >
    <Deferred value={data.memories} fallback={<SkeletonRows />}>{(list) => <>
      <MemorySearchPanel focus={focus} onEdit={setEditing} onExplain={setExplaining} onForget={forget} forgetting={forgetting} />
      <Section title="覚えていること" count={list.memories.length}>
        {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
        {list.memories.length === 0
          ? <Empty icon={<Brain size={28} aria-hidden="true" />} title="まだ何も覚えていません" text="チャットで「〜を覚えておいて」と頼むか、「足す」から書きます。" />
          : <ul className={styles.cards} aria-label="覚えていること">{list.memories.map((memory) => <MemoryCard
            key={memory.id}
            memory={memory}
            focused={memory.id === focus}
            onEdit={() => setEditing(memory)}
            onExplain={() => setExplaining(memory)}
            onForget={() => void forget(memory)}
            forgetting={forgetting(memory.id)}
          />)}</ul>}
        {focus && !list.memories.some((memory) => memory.id === focus) && <Note>開こうとした記憶は、すでに削除されています。</Note>}
      </Section>
      <Toolbar><Note>覚えるのは人がいる実行（チャットと CLI）だけです。自動化は思い出すだけで、外部エージェントの Access Token は記憶に触れません。</Note></Toolbar>
    </>}</Deferred>
    {explaining && <MemoryExplanation memory={explaining} onClose={() => setExplaining(null)} />}
    {editing && <MemoryEditor memory={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { await revalidator.revalidate(); }} />}
  </Page>;
};

export default MemoryScreen;
