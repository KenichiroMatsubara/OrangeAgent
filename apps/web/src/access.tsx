import { CircleAlert, KeyRound, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { ACCESS_TOKEN_TOOLS, type AccessToken, type ContactList, type IssuedAccessToken } from '@mail/domain';

import { api } from './api';
import { suppressionWindow, tool as toolLabel, word } from './labels';
import { errorText, useCopied } from './parts';
import { momentLabel } from './time';
import { Button } from './ui/button';
import { Check, CheckGroup, Field } from './ui/field';
import { List, Row } from './ui/list';
import { Banner, Empty } from './ui/notice';
import { Note, Section, Toolbar } from './ui/page';
import { Sheet } from './ui/sheet';

/** Every tool a key can be granted, all checked when it is first issued: an outside agent does what Operator Chat does unless a person unchecks it. */
const SERVER_TOOLS: readonly string[] = ACCESS_TOKEN_TOOLS.map((entry) => entry.name);
const WINDOWS = ['none', 'hour', 'day', 'week', 'forever'] as const;

/** Shows the credential exactly once, because only its hash is stored. */
export const IssuedTokenNotice = ({ issued }: { issued: IssuedAccessToken }) => {
  const { copied, copy } = useCopied();
  return <Banner tone="warn" icon={<KeyRound size={18} aria-hidden="true" />}>
    <strong>{issued.name}</strong> を発行しました。<b>この画面を離れると二度と表示されません。</b>
    <Field label="MCP Server URL">{(control) => <input {...control} readOnly value={issued.url} />}</Field>
    <Field label="Access Token">{(control) => <input {...control} readOnly value={issued.token} />}</Field>
    <Toolbar><Button variant="secondary" small onClick={() => copy(`${issued.url}\n${issued.token}`)}>{copied ? 'コピーしました' : '両方をコピー'}</Button></Toolbar>
  </Banner>;
};

/**
 * Issues what an outside agent may do here: one Tool Grant and one Contact List
 * it may reach. Both bounds are set in the same place because a grant without a
 * bound list would reach every Contact the Account has.
 */
const IssueToken = ({ accountId, lists, reload, onClose }: { accountId: string; lists: readonly ContactList[]; reload: () => Promise<void>; onClose: () => void }) => {
  const [issued, setIssued] = useState<IssuedAccessToken | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [tools, setTools] = useState<string[]>([...SERVER_TOOLS]);
  const [window, setWindow] = useState('day');
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      setIssued(await api.issueAccessToken(accountId, { name: name.trim(), contactListId: listId, tools, suppressionWindow: window }));
      setName('');
      await reload();
    } catch (cause) {
      setError(errorText(cause, '鍵を発行できませんでした。'));
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title="外部エージェント用の鍵を発行" onClose={onClose} onSubmit={(event) => void submit(event)}>
    {issued
      ? <IssuedTokenNotice issued={issued} />
      : <Note>Claude Cowork などの外部エージェントに、許可したことと届けてよい相手だけを渡します。</Note>}
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {!issued && <>
      <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: cowork" required />}</Field>
      <Field label="届けてよい相手" hint={lists.length ? undefined : <>先に<Link to="../contacts">連絡先</Link>の「リスト」で作ってください。</>}>{(control) => <select {...control} value={listId} onChange={(change) => setListId(change.target.value)} required>
        {lists.map((list) => <option key={list.id} value={list.id}>{list.name}（{list.contactIds.length}人）</option>)}
      </select>}</Field>
      <CheckGroup legend="許可すること" showLegend>
        {SERVER_TOOLS.map((tool) => <Check key={tool} label={word(toolLabel, tool)} checked={tools.includes(tool)} onChange={(checked) => setTools((current) => checked ? [...new Set([...current, tool])] : current.filter((value) => value !== tool))} />)}
      </CheckGroup>
      <Field label="同じ送信を止める期間">{(control) => <select {...control} value={window} onChange={(change) => setWindow(change.target.value)}>
        {WINDOWS.map((entry) => <option key={entry} value={entry}>{word(suppressionWindow, entry)}</option>)}
      </select>}</Field>
      <Button type="submit" block busy={busy} disabled={!listId || !tools.length}>{busy ? '発行しています…' : '発行する'}</Button>
    </>}
    {issued && <Button variant="secondary" block onClick={onClose}>閉じる</Button>}
  </Sheet>;
};

/** The keys outside agents hold, and the way to issue and revoke them. */
export const AccessTokens = ({ accountId, lists, tokens, reload }: {
  accountId: string;
  lists: readonly ContactList[];
  tokens: readonly AccessToken[];
  reload: () => Promise<void>;
}) => {
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState('');
  const revoke = async (id: string): Promise<void> => {
    setError('');
    setRevoking(id);
    try {
      await api.revokeAccessToken(accountId, id);
      await reload();
    } catch (cause) {
      setError(errorText(cause, '鍵を失効できませんでした。'));
    } finally {
      setRevoking('');
    }
  };
  return <Section title="外部エージェント用の鍵" lead="外部の AI が、許可したことだけをこの Account で行うための鍵です。">
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {tokens.length === 0
      ? <Empty title="発行した鍵はありません" />
      : <List>{tokens.map((token) => <Row
        key={token.id}
        title={token.name}
        sub={`${token.tools.map((tool) => word(toolLabel, tool)).join('・')} ・ ${token.lastUsedAt ? `最後に使われたのは${momentLabel(token.lastUsedAt)}` : 'まだ使われていません'}`}
        aside={<Button variant="quiet" small busy={revoking === token.id} aria-label={`${token.name} を失効`} onClick={() => void revoke(token.id)}>失効</Button>}
        wrap
      />)}</List>}
    <Toolbar><Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setIssuing(true)}>鍵を発行</Button></Toolbar>
    {issuing && <IssueToken accountId={accountId} lists={lists} reload={reload} onClose={() => setIssuing(false)} />}
  </Section>;
};
