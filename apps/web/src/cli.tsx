import { CircleAlert, KeyRound, PlugZap, Terminal } from 'lucide-react';
import { useState } from 'react';

import type { IssuedLoginCode, OperatorToken } from '@mail/domain';

import { api } from './api';
import { errorText, useCopied } from './parts';
import { dateLabel, momentLabel, timeLabel } from './time';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { List, Row } from './ui/list';
import { Banner, Empty } from './ui/notice';
import { Note, Section, Toolbar } from './ui/page';
import { Sheet } from './ui/sheet';

/** What a CLI runs to receive its Operator Token for this code; the answer is JSON holding `token`. */
export const exchangeCommand = (issued: IssuedLoginCode): string =>
  `curl -fsS -X POST -H 'Content-Type: application/json' -d '{"code":"${issued.code}"}' ${issued.exchangeUrl}`;

/**
 * Receives the Operator Token and registers the MCP Server with Claude Code in one line.
 * The Token is base64url, so it holds no quote for sed to stop at, and a refused
 * code prints nothing, so nothing is registered.
 */
export const claudeCodeCommand = (issued: IssuedLoginCode): string =>
  `TOKEN=$(${exchangeCommand(issued)} | sed -nE 's/.*"token":"([^"]+)".*/\\1/p') && [ -n "$TOKEN" ] && claude mcp add --transport http flarechat ${issued.serverUrl} --header "Authorization: Bearer $TOKEN"`;

const Command = ({ label, command, rows = 4 }: { label: string; command: string; rows?: number }) => {
  const { copied, copy } = useCopied();
  return <>
    <Field label={label}>{(control) => <textarea {...control} readOnly rows={rows} value={command} spellCheck={false} />}</Field>
    <Toolbar><Button variant="secondary" small onClick={() => copy(command)}>{copied ? 'コピーしました' : 'コピー'}</Button></Toolbar>
  </>;
};

/** The code, shown once, and the two ways a CLI uses it. */
export const LoginCodeNotice = ({ issued }: { issued: IssuedLoginCode }) => <>
  <Banner tone="warn" icon={<KeyRound size={18} aria-hidden="true" />}>
    ログインコード <strong>{issued.code}</strong>
    <br />{timeLabel(issued.expiresAt)}まで、一度だけ使えます。このコードを渡した CLI は、あなたとして90日間このアカウントを操作できます。
  </Banner>
  <Command label="Claude Code に登録する" command={claudeCodeCommand(issued)} />
  <Command label="トークンだけ受け取る" command={exchangeCommand(issued)} />
  <Note>受け取った JSON の token を、Authorization: Bearer ヘッダーで同じ JSON の url（MCP Server）に渡します。</Note>
</>;

const ShowCode = ({ accountId, reload, onClose }: { accountId: string; reload: () => Promise<void>; onClose: () => void }) => {
  const [issued, setIssued] = useState<IssuedLoginCode | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const show = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      setIssued(await api.issueLoginCode(accountId));
    } catch (cause) {
      setError(errorText(cause, 'ログインコードを表示できませんでした。'));
    } finally {
      setBusy(false);
    }
  };
  const close = (): void => {
    void reload();
    onClose();
  };
  return <Sheet title="CLI にログイン" onClose={close}>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {issued
      ? <LoginCodeNotice issued={issued} />
      : <>
        <Note>CLI でこのアカウントを操作するための、10分だけ有効なコードを表示します。CLI はこれと引き換えに90日間有効なトークンを受け取り、運用チャットと同じように Gmail・カレンダー・連絡先・タスク・スキルを使えます。</Note>
        <Button block busy={busy} onClick={() => void show()}>{busy ? '表示しています…' : 'ログインコードを表示'}</Button>
      </>}
    {issued && <Button variant="secondary" block onClick={close}>閉じる</Button>}
  </Sheet>;
};

/** What holds a Token: the app a member approved, or a CLI that was given a Login Code. */
const holderLabel = (token: OperatorToken): string => token.client === null ? 'CLI' : token.client || 'アプリ';

/** The CLIs and apps members have signed in with, and the way to sign in another or revoke one. */
export const OperatorTokens = ({ accountId, tokens, endpoint, reload }: {
  accountId: string;
  tokens: readonly OperatorToken[];
  /** The MCP Server's URL, which an app such as Claude is given to connect. */
  endpoint: string;
  reload: () => Promise<void>;
}) => {
  const [showing, setShowing] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState('');
  const revoke = async (id: string): Promise<void> => {
    setError('');
    setRevoking(id);
    try {
      await api.revokeOperatorToken(accountId, id);
      await reload();
    } catch (cause) {
      setError(errorText(cause, 'ログインを取り消せませんでした。'));
    } finally {
      setRevoking('');
    }
  };
  return <Section title="CLI とアプリからのログイン" lead="Claude Code などの CLI や、メンバーが接続を許可した Claude などのアプリが、そのメンバーとして90日間このアカウントを操作できます。">
    <Command label="MCP Server の URL" command={endpoint} rows={1} />
    <Note>Claude（claude.ai・デスクトップ・モバイル）では、カスタムコネクタにこの URL を入れて接続し、開いた画面で許可します。Claude Code では claude mcp add --transport http flarechat にこの URL を続けて登録すると、初めて使うときに同じ画面が開きます。</Note>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {tokens.length === 0
      ? <Empty title="ログインしている CLI やアプリはありません" />
      : <List>{tokens.map((token) => <Row
        key={token.id}
        leading={token.client === null ? <Terminal size={20} aria-hidden="true" /> : <PlugZap size={20} aria-hidden="true" />}
        title={`${holderLabel(token)} ・ ${token.email}`}
        sub={`${dateLabel(token.expiresAt)}まで ・ ${token.lastUsedAt ? `最後に使われたのは${momentLabel(token.lastUsedAt)}` : 'まだ使われていません'}`}
        aside={<Button variant="quiet" small busy={revoking === token.id} aria-label={`${token.email} の${holderLabel(token)}ログインを取り消す`} onClick={() => void revoke(token.id)}>取り消す</Button>}
        wrap
      />)}</List>}
    <Toolbar><Button variant="secondary" icon={<Terminal size={18} aria-hidden="true" />} onClick={() => setShowing(true)}>ログインコードを表示</Button></Toolbar>
    {showing && <ShowCode accountId={accountId} reload={reload} onClose={() => setShowing(false)} />}
  </Section>;
};
