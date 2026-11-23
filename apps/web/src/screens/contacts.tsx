import { CircleAlert, FileUp, Info, MessageCircle, Plus, UsersRound } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useLoaderData, useRevalidator } from 'react-router-dom';

import { CONTACT_CSV_COLUMNS, CONTACT_CSV_SAMPLE } from '@mail/domain';
import type { Connections, Contact, ContactImportPreview, ContactImportResult, ContactInput, ContactList, LineHandleKind, LineHandleRecord } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { lineHandleKind } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { Button } from '../ui/button';
import { Segmented } from '../ui/choice';
import { Deferred, later } from '../ui/deferred';
import { Disclosure } from '../ui/disclosure';
import { Check, Field, Search } from '../ui/field';
import { List, Row } from '../ui/list';
import { Avatar, Banner, Chip, Chips, Empty } from '../ui/notice';
import { Card, Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import styles from './contacts.module.css';

interface Roster {
  contacts: Contact[];
  lineHandles: LineHandleRecord[];
  connections: Connections;
}

export interface ContactsData {
  roster: Promise<Roster>;
  lists: Promise<ContactList[]>;
}

/** Returns at once; the roster and the lists fill in as they are read. */
export const loader = async (): Promise<ContactsData> => {
  const accountId = await accountIdOf();
  return {
    roster: later(Promise.all([api.contacts(accountId), api.lineHandles(accountId), api.connections(accountId)])
      .then(([contacts, lineHandles, connections]) => ({ contacts, lineHandles, connections }))),
    lists: later(api.contactLists(accountId)),
  };
};

const normalized = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, '');

/** True when the Contact holds an email address, shown or masked. */
export const hasEmail = (contact: Contact): boolean => contact.email.trim() !== '';

/** An active Contact the product has no way to reach: no address and no handle. Nothing else says so. */
export const isUnreachable = (contact: Contact): boolean =>
  contact.state === 'active' && !hasEmail(contact) && contact.lineDestinations.length === 0;

const tags = (text: string): string[] => text.split(/[,、]/u).map((tag) => tag.trim()).filter(Boolean);

/** Adds a Contact with a name alone; everything else is optional and can follow later. */
const AddContact = ({ unassigned, handleId, onClose }: { unassigned: readonly LineHandleRecord[]; handleId: string; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const chosen = unassigned.find((handle) => handle.id === handleId);
  const [name, setName] = useState(chosen?.displayName ?? '');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [tagText, setTagText] = useState('');
  const [lineDestinationId, setLineDestinationId] = useState(handleId);
  const creating = operations.pending(pendingKey.contactCreate);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const input: ContactInput = {
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      description: description.trim(),
      tags: tags(tagText),
      ...(lineDestinationId ? { lineDestinationId } : {}),
    };
    void operations.run(pendingKey.contactCreate, async () => {
      await api.createContact(account.accountId, input);
      await revalidator.revalidate();
      onClose();
    });
  };
  return <Sheet title="連絡先を追加" onClose={onClose} onSubmit={submit}>
    <Note>名前だけで登録できます。個人でもグループでも 1 件です。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: 山田 太郎 / 役員グループ" required />}</Field>
    <Field label="メールアドレス（任意）">{(control) => <input {...control} type="email" value={email} onChange={(change) => setEmail(change.target.value)} />}</Field>
    <Field label="説明（任意）">{(control) => <input {...control} value={description} onChange={(change) => setDescription(change.target.value)} placeholder="例: 会計 / 役員全員が入っている LINE グループ" />}</Field>
    <Field label="タグ（任意）" hint="カンマで区切ります。">{(control) => <input {...control} value={tagText} onChange={(change) => setTagText(change.target.value)} placeholder="例: 役員, 2026" />}</Field>
    {unassigned.length > 0 && <Field label="LINE（任意）">{(control) => <select {...control} value={lineDestinationId} onChange={(change) => setLineDestinationId(change.target.value)}>
      <option value="">LINE なしで登録</option>
      {unassigned.map((handle) => <option key={handle.id} value={handle.id}>{handle.displayName || '名前の分からない LINE'}（{lineHandleKind[handle.kind]}）</option>)}
    </select>}</Field>}
    <Button type="submit" block busy={creating}>{creating ? '追加しています…' : '追加する'}</Button>
  </Sheet>;
};

/**
 * The LINE handles that reached the Account and no Contact holds yet. Each is
 * made a new Contact here, or linked to an existing one from that Contact.
 */
const LineHandles = ({ unassigned, onPromote, onClose }: { unassigned: readonly LineHandleRecord[]; onPromote: (handleId: string) => void; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [destinationId, setDestinationId] = useState('');
  const [kind, setKind] = useState<LineHandleKind>('user');
  const registering = operations.pending(pendingKey.lineDestinationRegister);
  const register = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.lineDestinationRegister, async () => {
      await api.registerLineHandle(account.accountId, { destinationId: destinationId.trim(), kind });
      setDestinationId('');
      await revalidator.revalidate();
    });
  };
  const remove = (handle: LineHandleRecord): void => void operations.run(pendingKey.lineDestinationRemove(handle.id), async () => {
    await api.removeLineHandle(account.accountId, handle.id);
    await revalidator.revalidate();
  });
  return <Sheet title="LINE から届いた相手" onClose={onClose} onSubmit={register}>
    <Note>公式アカウントにメッセージが届くと、ここに並びます。連絡先にすると、要約やリマインドを LINE で届けられます。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {unassigned.length === 0
      ? <Empty title="待っている LINE はありません" />
      : <List>
        {unassigned.map((handle) => <Row
          key={handle.id}
          leading={<MessageCircle size={20} aria-hidden="true" />}
          title={handle.displayName || '名前の分からない LINE'}
          sub={`${lineHandleKind[handle.kind]} ・ ${handle.source === 'manual' ? '手で登録' : 'LINE から届いた'} ・ ${handle.destinationId}`}
          aside={<>
            <Button variant="soft" small onClick={() => onPromote(handle.id)}>連絡先にする</Button>
            <Button variant="quiet" small busy={operations.pending(pendingKey.lineDestinationRemove(handle.id))} aria-label={`${handle.displayName || handle.destinationId}を削除`} onClick={() => remove(handle)}>削除</Button>
          </>}
          wrap
        />)}
      </List>}
    <Field label="LINE ID を手で登録" hint="友だち追加の前でも、分かっている ID を先に登録できます。">{(control) => <input {...control} value={destinationId} onChange={(change) => setDestinationId(change.target.value)} placeholder="例: U4af498062…" />}</Field>
    <Field label="種類">{(control) => <select {...control} value={kind} onChange={(change) => setKind(change.target.value as LineHandleKind)}>
      <option value="user">個人</option><option value="group">グループ</option><option value="room">トークルーム</option>
    </select>}</Field>
    <Button type="submit" variant="secondary" block busy={registering} disabled={!destinationId.trim()}>{registering ? '登録しています…' : '登録する'}</Button>
  </Sheet>;
};

/** Reads a chosen file as UTF-8, or as Shift_JIS when it is not UTF-8, as Excel in Japanese saves a CSV. */
const textOf = async (file: File): Promise<string> => {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
};

const SAMPLE_URL = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${CONTACT_CSV_SAMPLE.replaceAll('\n', '\r\n')}\r\n`)}`;

/** The format the import takes, stated in full where the CSV is written. */
const CsvFormat = ({ onSample }: { onSample: () => void }) => <Disclosure title="CSV の形式" sub="見出し・列・書き方の決まり" open>
  <table className={styles.format}>
    <thead><tr><th scope="col">見出し</th><th scope="col">中身</th></tr></thead>
    <tbody>{CONTACT_CSV_COLUMNS.map((column) => <tr key={column.field}>
      <th scope="row"><code>{column.heading}</code></th>
      <td><strong>{column.label}</strong>（{column.required ? '必須' : '任意'}）<br />{column.note}</td>
    </tr>)}</tbody>
  </table>
  <ul className={styles.rules}>
    <li>1 行目は見出しです。列の順番は自由で、使わない列は省けます。見出しは「{CONTACT_CSV_COLUMNS.map((column) => column.label).join('」「')}」でも構いません。</li>
    <li>2 行目から、1 行に連絡先 1 件です。</li>
    <li>値にカンマ・改行・「"」を含むときは値全体を「"」で囲み、中の「"」は「""」と重ねます。</li>
    <li>文字コードは UTF-8 です。Excel で保存した Shift_JIS のファイルも選べます。</li>
    <li>既にある連絡先は書き換えません。同じメールアドレスの連絡先がある行と、メールアドレスがなく同じ名前の連絡先がある行は取り込みません。</li>
  </ul>
  <pre className={styles.sample} aria-label="見本">{CONTACT_CSV_SAMPLE}</pre>
  <Toolbar>
    <Button variant="secondary" small onClick={onSample}>見本を入れる</Button>
    <a className={styles.download} href={SAMPLE_URL} download="contacts-sample.csv">見本をダウンロード</a>
  </Toolbar>
</Disclosure>;

/** What a preview or an import found, line by line. */
const CsvOutcome = ({ result }: { result: ContactImportPreview | ContactImportResult }) => {
  const imported = 'imported' in result ? result.imported : null;
  const accepted = imported === null ? result.accepted : [];
  return <>
    {imported === null
      ? <Banner tone="info" icon={<Info size={18} aria-hidden="true" />}>取り込むと {result.accepted.length}件 が加わります。{result.skipped.length + result.invalid.length > 0 && `${result.skipped.length + result.invalid.length}行 は取り込みません。`}</Banner>
      : <Banner tone="brand" icon={<FileUp size={18} aria-hidden="true" />}>{imported}件 を取り込みました。{result.skipped.length + result.invalid.length > 0 && `${result.skipped.length + result.invalid.length}行 は取り込んでいません。`}</Banner>}
    {accepted.length > 0 && <List label="取り込む行">{accepted.map((row) => <Row
      key={row.line}
      title={row.name}
      sub={[`${row.line} 行目`, row.email || 'メールなし', row.description, row.tags.join('・')].filter(Boolean).join(' ・ ')}
      wrap
    />)}</List>}
    {result.skipped.length > 0 && <List label="取り込まない行">{result.skipped.map((row) => <Row
      key={row.line}
      title={`${row.line} 行目 ${row.name}`}
      sub={row.reason}
      aside={<Chip tone="muted">既にある</Chip>}
      wrap
    />)}</List>}
    {result.invalid.length > 0 && <List label="読めない行">{result.invalid.map((row) => <Row
      key={row.line}
      title={`${row.line} 行目: ${row.reason}`}
      sub={row.text}
      aside={<Chip tone="warn">直してください</Chip>}
      wrap
    />)}</List>}
  </>;
};

/** Taking the roster in and out as CSV. The format is stated, and a preview says which rows would be accepted before anything is written. */
const Csv = ({ onClose }: { onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ContactImportPreview | ContactImportResult | null>(null);
  const busy = operations.pending(pendingKey.contactImport);
  const write = (text: string): void => { setCsv(text); setResult(null); };
  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void textOf(file).then(write);
  };
  const run = (mode: 'preview' | 'import'): void => void operations.run(pendingKey.contactImport, async () => {
    setResult(null);
    const outcome = mode === 'preview'
      ? await api.contactImportPreview(account.accountId, csv)
      : await api.importContacts(account.accountId, csv);
    setResult(outcome);
    if (mode === 'import') await revalidator.revalidate();
  });
  return <Sheet title="CSV で入出力" onClose={onClose}>
    <Note>連絡先をまとめて追加します。取り込む前に、どの行が入り、どの行が入らないかを確認できます。</Note>
    <CsvFormat onSample={() => write(CONTACT_CSV_SAMPLE)} />
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="CSV" hint={`1 行目は ${CONTACT_CSV_COLUMNS.map((column) => column.heading).join(',')} のような見出しです。貼り付けるか、ファイルを選びます。`}>{(control) => <textarea {...control} value={csv} rows={6} disabled={busy} spellCheck={false} onChange={(change) => write(change.target.value)} />}</Field>
    <input type="file" className="fc-sr-only" tabIndex={-1} accept=".csv,text/csv,text/plain" aria-label="CSV ファイル" onChange={choose} />
    <Toolbar>
      <Button variant="secondary" disabled={busy} onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="CSV ファイル"]')?.click()}>ファイルを選ぶ</Button>
      <Button variant="secondary" disabled={busy || !csv.trim()} onClick={() => run('preview')}>取り込み結果を確認</Button>
      <Button busy={busy} disabled={!csv.trim()} onClick={() => run('import')}>取り込む</Button>
    </Toolbar>
    {result && <CsvOutcome result={result} />}
    <a className={styles.download} href={api.contactExportUrl(account.accountId)}>いまの連絡先を CSV で書き出す</a>
  </Sheet>;
};

/** A Contact List: a named set of Contacts an Automation or an Access Token is bounded to. */
const ContactListEditor = ({ list, contacts, onClose }: { list: ContactList | null; contacts: readonly Contact[]; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [name, setName] = useState(list?.name ?? '');
  const [members, setMembers] = useState<readonly string[]>(list?.contactIds ?? []);
  const key = `contact-list:${list?.id ?? 'new'}`;
  const saving = operations.pending(key);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(key, async () => {
      await api.saveContactList(account.accountId, list?.id ?? crypto.randomUUID(), { name: name.trim(), contactIds: [...members] });
      await revalidator.revalidate();
      onClose();
    });
  };
  const candidates = contacts.filter((contact) => contact.state === 'active' || members.includes(contact.id));
  return <Sheet title={list ? 'リストを編集' : 'リストを作る'} onClose={onClose} onSubmit={submit}>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="リストの名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: 役員" required />}</Field>
    <fieldset className={styles.members}>
      <legend>入れる連絡先</legend>
      {candidates.map((contact) => <Check
        key={contact.id}
        label={contact.name}
        sub={contact.description || undefined}
        checked={members.includes(contact.id)}
        onChange={(checked) => setMembers((current) => checked ? [...current, contact.id] : current.filter((id) => id !== contact.id))}
      />)}
    </fieldset>
    <Button type="submit" block busy={saving}>{saving ? '保存しています…' : '保存する'}</Button>
  </Sheet>;
};

const ContactRows = ({ contacts }: { contacts: readonly Contact[] }) => <List>
  {contacts.map((contact) => <Row
    key={contact.id}
    to={contact.id}
    leading={<Avatar name={contact.name} />}
    title={contact.name}
    sub={contact.description || contact.tags.join('・') || undefined}
    aside={<Chips>
      {contact.state === 'inactive' && <Chip tone="muted">停止中</Chip>}
      {contact.lineDestinations.length > 0 && <Chip tone="brand">LINE</Chip>}
      {hasEmail(contact) && <Chip tone="info">メール</Chip>}
      {isUnreachable(contact) && <Chip tone="warn">届く手段なし</Chip>}
    </Chips>}
  />)}
</List>;

type View = 'contacts' | 'lists';
type Sheets = { kind: 'add'; handleId: string } | { kind: 'line' } | { kind: 'csv' } | { kind: 'list'; list: ContactList | null } | null;

/** Everything about who the product can reach: the roster, its LINE handles, and the lists drawn from it. */
const ContactsScreen = () => {
  const data = useLoaderData<ContactsData>();
  const [view, setView] = useState<View>('contacts');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<Sheets>(null);
  const close = (): void => setSheet(null);
  return <Page title="連絡先" actions={<Button pill icon={<Plus size={18} aria-hidden="true" />} onClick={() => setSheet({ kind: 'add', handleId: '' })}>追加</Button>}>
    <Deferred value={data.roster} fallback={<SkeletonRows count={5} />}>{(roster) => {
      const unassigned = roster.lineHandles.filter((handle) => handle.status === 'discovered' && !handle.contactId);
      const unreachable = roster.contacts.filter(isUnreachable);
      const token = normalized(query);
      const visible = roster.contacts
        .filter((contact) => !token || normalized([contact.name, contact.email, contact.description, ...contact.tags, ...contact.lineDestinations.map((handle) => handle.displayName)].join(' ')).includes(token))
        .sort((a, b) => Number(a.state === 'inactive') - Number(b.state === 'inactive'));
      const lineConfigured = roster.connections.line.channelAccessTokenConfigured && roster.connections.line.channelSecretConfigured;
      return <>
        <Search label="連絡先を検索" placeholder="名前・メール・LINE 名で検索" value={query} onChange={setQuery} />
        <Deferred value={data.lists} fallback={null}>{(lists) => <Segmented label="表示" value={view} onChange={setView} options={[
          { value: 'contacts', label: `連絡先 ${roster.contacts.length}` },
          { value: 'lists', label: `リスト ${lists.length}` },
        ]} />}</Deferred>
        {view === 'contacts' ? <>
          {unassigned.length > 0 && <Banner tone="info" icon={<MessageCircle size={18} aria-hidden="true" />} action={<Button variant="secondary" small onClick={() => setSheet({ kind: 'line' })}>結び付ける</Button>}>
            LINE から {unassigned.length}件 届いています。連絡先にすると届けられます。
          </Banner>}
          {!lineConfigured && <Banner tone="neutral" icon={<Info size={18} aria-hidden="true" />} action={<Link to="../connections">接続を開く</Link>}>
            LINE の接続が未設定です。LINE なしでも登録できます。
          </Banner>}
          {unreachable.length > 0 && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>
            {unreachable.map((contact) => contact.name).join('、')}にはメールアドレスも LINE もありません。要約もリマインドも届きません。
          </Banner>}
          {visible.length === 0
            ? <Empty icon={<UsersRound size={32} aria-hidden="true" />} title={roster.contacts.length ? '一致する連絡先がありません' : '連絡先はまだありません'} text={roster.contacts.length ? '検索の言葉を変えてください。' : '名前だけで追加できます。'} />
            : <ContactRows contacts={visible} />}
          <List>
            <Row onClick={() => setSheet({ kind: 'line' })} leading={<MessageCircle size={20} aria-hidden="true" />} title="LINE から届いた相手" sub={unassigned.length ? `${unassigned.length}件が連絡先を待っています` : '待っている LINE はありません'} />
            <Row onClick={() => setSheet({ kind: 'csv' })} leading={<FileUp size={20} aria-hidden="true" />} title="CSV で入出力" sub="まとめて取り込む・書き出す" />
          </List>
          {sheet?.kind === 'add' && <AddContact unassigned={unassigned} handleId={sheet.handleId} onClose={close} />}
          {sheet?.kind === 'line' && <LineHandles unassigned={unassigned} onPromote={(handleId) => setSheet({ kind: 'add', handleId })} onClose={close} />}
          {sheet?.kind === 'csv' && <Csv onClose={close} />}
        </> : <Deferred value={data.lists} fallback={<SkeletonRows />}>{(lists) => <>
          <Section title="連絡先のリスト" lead="自動化と外部エージェントは、それぞれに選んだリストの相手にだけ届けます。">
            {lists.length === 0
              ? <Empty title="リストはまだありません" text="自動化に届けてよい相手を選ぶには、先にリストを作ります。" />
              : <List>{lists.map((list) => <Row
                key={list.id}
                onClick={() => setSheet({ kind: 'list', list })}
                title={list.name}
                sub={`${list.contactIds.length}人 ・ ${roster.contacts.filter((contact) => list.contactIds.includes(contact.id)).map((contact) => contact.name).join('、') || 'まだ誰もいません'}`}
              />)}</List>}
            <Toolbar><Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setSheet({ kind: 'list', list: null })}>リストを作る</Button></Toolbar>
          </Section>
          {sheet?.kind === 'list' && <ContactListEditor list={sheet.list} contacts={roster.contacts} onClose={close} />}
        </>}</Deferred>}
        {sheet?.kind === 'add' && view === 'lists' && <AddContact unassigned={unassigned} handleId="" onClose={close} />}
      </>;
    }}</Deferred>
  </Page>;
};

export default ContactsScreen;
