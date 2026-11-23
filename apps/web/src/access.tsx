import { CircleAlert, KeyRound, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ACCESS_TOKEN_TOOLS, type AccessToken, type IssuedAccessToken } from '@mail/domain';

import { api } from './api';
import { ToolChecks } from './grant';
import { tool as toolLabel, word } from './labels';
import { errorText, useCopied } from './parts';
import { momentLabel } from './time';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { List, Row } from './ui/list';
import { Banner, Empty } from './ui/notice';
import { Note, Section, Toolbar } from './ui/page';
import { Sheet } from './ui/sheet';

/** Every tool a key can be granted, all checked when it is first issued: an outside agent does what Operator Chat does unless a person unchecks it. */
const SERVER_TOOLS: readonly string[] = ACCESS_TOKEN_TOOLS.map((entry) => entry.name);

/** Which tools a key holds, as its row says it: all of them, all but a few by name, or how many. */
const grantSummary = (tools: readonly string[]): string => {
  const left = SERVER_TOOLS.filter((name) => !tools.includes(name));
  if (!left.length) return 'すべてのツール';
  if (left.length <= 3) return `${left.map((name) => word(toolLabel, name)).join('・')} 以外のすべてのツール`;
  return `${SERVER_TOOLS.length} 個のうち ${tools.length} 個のツール`;
};

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

/** Issues a key an outside agent uses this Account with: its name and the tools it may call, nothing else. */
const IssueToken = ({ accountId, reload, onClose }: { accountId: string; reload: () => Promise<void>; onClose: () => void }) => {
  const [issued, setIssued] = useState<IssuedAccessToken | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [tools, setTools] = useState<string[]>([...SERVER_TOOLS]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      setIssued(await api.issueAccessToken(accountId, { name: name.trim(), tools }));
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
      : <Note>Claude Cowork などの外部エージェントに渡す鍵です。外部エージェントは、チェックしたツールを Operator Chat と同じようにこの Account で使えます。ファイルを作って渡すこととコードの実行は、鍵では使えません。</Note>}
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {!issued && <>
      <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: cowork" required />}</Field>
      <ToolChecks tools={ACCESS_TOKEN_TOOLS} value={tools} onChange={setTools} />
      <Button type="submit" block busy={busy} disabled={!tools.length}>{busy ? '発行しています…' : '発行する'}</Button>
    </>}
    {issued && <Button variant="secondary" block onClick={onClose}>閉じる</Button>}
  </Sheet>;
};

/** The keys outside agents hold, and the way to issue and revoke them. */
export const AccessTokens = ({ accountId, tokens, reload }: {
  accountId: string;
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
  return <Section title="外部エージェント用の鍵" lead="Claude Cowork などの外部の AI が、選んだツールをこの Account で使うための鍵です。">
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {tokens.length === 0
      ? <Empty title="発行した鍵はありません" />
      : <List>{tokens.map((token) => <Row
        key={token.id}
        title={token.name}
        sub={`${grantSummary(token.tools)} ・ ${token.lastUsedAt ? `最後に使われたのは${momentLabel(token.lastUsedAt)}` : 'まだ使われていません'}`}
        aside={<Button variant="quiet" small busy={revoking === token.id} aria-label={`${token.name} を失効`} onClick={() => void revoke(token.id)}>失効</Button>}
        wrap
      />)}</List>}
    <Toolbar><Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setIssuing(true)}>鍵を発行</Button></Toolbar>
    {issuing && <IssueToken accountId={accountId} reload={reload} onClose={() => setIssuing(false)} />}
  </Section>;
};
