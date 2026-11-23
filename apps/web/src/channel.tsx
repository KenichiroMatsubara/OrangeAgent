import { useState, type FormEvent } from 'react';
import { CircleAlert, CircleCheck, Plug, Plus, Send, Trash2 } from 'lucide-react';

import type { ChannelTestDelivery, McpServer, McpServerTool, McpServerToolResult } from '@mail/domain';

import { api } from './api';
import { mcpAuthentication, word } from './labels';
import { errorText } from './parts';
import { momentLabel } from './time';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { List, Row } from './ui/list';
import { Banner, Empty } from './ui/notice';
import { Note, Section, Toolbar } from './ui/page';
import { Sheet } from './ui/sheet';
import styles from './channel.module.css';

/** What one LINE push carries; more messages go in more pushes. */
const LINE_PUSH_SIZE = 5;

const CHANNEL_LABELS: Record<string, string> = { line: 'LINE', discord: 'Discord', email: 'メール' };

/** Says exactly what the Channel did, because a test that only says 送信しました proves nothing. */
export const ChannelTestOutcome = ({ delivery }: { delivery: ChannelTestDelivery }) => <Banner tone="brand" icon={<CircleCheck size={18} aria-hidden="true" />}>
  {CHANNEL_LABELS[delivery.channel] ?? delivery.channel} が受け付けました。宛先 {delivery.destination}
  {delivery.messages > 1 ? `／${delivery.messages}通を${delivery.requests}リクエストで` : ''}
  {delivery.externalId ? `／識別子 ${delivery.externalId}` : ''}（{momentLabel(delivery.sentAt)}）
</Banner>;

/**
 * Channel Test: a send to one Contact through the same seam an
 * Automation and the MCP Server send through, so the answer is evidence about
 * the production path rather than about a test path. It answers whether this
 * person is reachable, so it lives on the Contact.
 */
export const ChannelTestSheet = ({ accountId, contactId, channels, onClose }: {
  accountId: string;
  contactId: string;
  /** The Channels this Contact holds a handle on. */
  channels: readonly string[];
  onClose: () => void;
}) => {
  const [channel, setChannel] = useState(channels[0] ?? 'line');
  const [texts, setTexts] = useState(['OrangeAgent からのテスト送信です。']);
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<ChannelTestDelivery | null>(null);
  const [error, setError] = useState('');
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setDelivery(null);
    setSending(true);
    try {
      setDelivery(await api.sendChannelTest(accountId, { contactId, channel, texts }));
    } catch (cause) {
      setError(errorText(cause, 'テスト送信に失敗しました。'));
    } finally {
      setSending(false);
    }
  };
  return <Sheet title="テスト送信" onClose={onClose} onSubmit={(event) => void send(event)}>
    <Note>実際の通知と同じ経路で送ります。同じ文面を続けて試せます。LINE は {LINE_PUSH_SIZE} 通ずつ 1 回にまとめて送ります。</Note>
    {channels.length > 1 && <Field label="送る手段">{(control) => <select {...control} value={channel} onChange={(change) => setChannel(change.target.value)}>
      {channels.map((entry) => <option key={entry} value={entry}>{CHANNEL_LABELS[entry] ?? entry}</option>)}
    </select>}</Field>}
    {texts.map((entry, index) => <Field key={index} label={texts.length > 1 ? `メッセージ ${index + 1}` : 'メッセージ'}>{(control) => <textarea
      {...control}
      value={entry}
      rows={2}
      onChange={(change) => setTexts((current) => current.map((value, at) => at === index ? change.target.value : value))}
    />}</Field>)}
    <Toolbar>
      <Button variant="quiet" small onClick={() => setTexts((current) => [...current, ''])}>メッセージを足す</Button>
      {texts.length > 1 && <Button variant="quiet" small onClick={() => setTexts((current) => current.slice(0, -1))}>最後の 1 通を消す</Button>}
    </Toolbar>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {delivery && <ChannelTestOutcome delivery={delivery} />}
    <Button type="submit" block busy={sending} disabled={!texts.some((entry) => entry.trim())} icon={<Send size={18} aria-hidden="true" />}>{sending ? '送信しています…' : '送信する'}</Button>
  </Sheet>;
};

/** Registers one remote MCP Server. Only HTTP or SSE servers can be reached, because Workers have no child processes. */
const AddMcpServer = ({ accountId, reload, onClose }: { accountId: string; reload: () => Promise<void>; onClose: () => void }) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.saveMcpServer(accountId, crypto.randomUUID(), { name: name.trim(), url: url.trim(), token: token.trim() || null });
      await reload();
      onClose();
    } catch (cause) {
      setError(errorText(cause, 'MCP Server を保存できませんでした。'));
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title="外部ツール（MCP）を追加" onClose={onClose} onSubmit={(event) => void save(event)}>
    <Note>リモートの HTTP / SSE サーバーだけを使えます。認証は、サーバーが発行した固定のトークンか、サインイン（OAuth）です。サインインするサーバーは、トークンを空けたまま追加し、一覧の「サインイン」からサインインします。</Note>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: notion" required />}</Field>
    <Field label="URL">{(control) => <input {...control} type="url" value={url} onChange={(change) => setUrl(change.target.value)} placeholder="https://example.com/mcp" autoCapitalize="none" spellCheck={false} required />}</Field>
    <Field label="トークン（任意）">{(control) => <input {...control} type="password" value={token} onChange={(change) => setToken(change.target.value)} autoComplete="off" />}</Field>
    <Button type="submit" block busy={busy}>{busy ? '保存しています…' : '追加する'}</Button>
  </Sheet>;
};

/**
 * Calls a registered MCP Server for real: its tools/list and one
 * tools/call. Calling it answers whether the credential and the server work,
 * which is a question about the connection rather than about any one Contact.
 */
const TryMcpServer = ({ accountId, server, onClose }: { accountId: string; server: McpServer; onClose: () => void }) => {
  const [tools, setTools] = useState<McpServerTool[]>([]);
  const [tool, setTool] = useState('');
  const [toolArguments, setToolArguments] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpServerToolResult | null>(null);
  const [error, setError] = useState('');
  const loadTools = async (): Promise<void> => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const listed = await api.listMcpServerTools(accountId, server.id);
      setTools(listed.tools);
      setTool((current) => current || listed.tools[0]?.name || '');
    } catch (cause) {
      setTools([]);
      setError(errorText(cause, 'ツールの一覧を取得できませんでした。'));
    } finally {
      setBusy(false);
    }
  };
  const call = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const parsed = JSON.parse(toolArguments || '{}') as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('引数は JSON オブジェクトで入力してください。');
      setResult(await api.callMcpServerTool(accountId, server.id, { tool, arguments: parsed as Record<string, unknown> }));
    } catch (cause) {
      setError(errorText(cause, 'MCP Server を呼び出せませんでした。'));
    } finally {
      setBusy(false);
    }
  };
  const schema = tools.find((entry) => entry.name === tool)?.inputSchema;
  return <Sheet title={`${server.name} を試す`} onClose={onClose} onSubmit={(event) => void call(event)}>
    <Note>登録したサーバーに、そのまま問い合わせて結果を確かめます。</Note>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    <Button variant="secondary" busy={busy && !tools.length} icon={<Plug size={18} aria-hidden="true" />} onClick={() => void loadTools()}>ツールの一覧を取得</Button>
    {tools.length > 0 && <>
      <Field label="ツール">{(control) => <select {...control} value={tool} onChange={(change) => setTool(change.target.value)}>
        {tools.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select>}</Field>
      {schema !== undefined && <pre className={styles.code}>{JSON.stringify(schema, null, 2)}</pre>}
      <Field label="引数（JSON）">{(control) => <textarea {...control} rows={4} value={toolArguments} onChange={(change) => setToolArguments(change.target.value)} />}</Field>
      <Button type="submit" block busy={busy} disabled={!tool} icon={<Send size={18} aria-hidden="true" />}>{busy ? '呼び出しています…' : 'ツールを実行'}</Button>
    </>}
    {result && (result.isError
      ? <Banner tone="danger">{result.server}.{result.tool} は失敗しました: {result.text}</Banner>
      : <pre className={styles.code}>{result.text || '（本文のない結果）'}</pre>)}
  </Sheet>;
};

/** The MCP Servers that lend their tools to Automations and Operator Chat. */
export const McpServers = ({ accountId, servers, reload }: { accountId: string; servers: readonly McpServer[]; reload: () => Promise<void> }) => {
  const [sheet, setSheet] = useState<{ kind: 'add' } | { kind: 'try'; server: McpServer } | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  const [signing, setSigning] = useState('');
  /** Sends the person to the server's sign-in screen, which sends them back to 接続. */
  const signIn = async (id: string): Promise<void> => {
    setError('');
    setSigning(id);
    try {
      window.location.assign((await api.authorizeMcpServer(accountId, id)).authorizationUrl);
    } catch (cause) {
      setError(errorText(cause, 'サインインを始められませんでした。'));
      setSigning('');
    }
  };
  const remove = async (id: string): Promise<void> => {
    setError('');
    setRemoving(id);
    try {
      await api.removeMcpServer(accountId, id);
      await reload();
    } catch (cause) {
      setError(errorText(cause, 'MCP Server を削除できませんでした。'));
    } finally {
      setRemoving('');
    }
  };
  return <Section title="外部ツール（MCP）" lead="自動化とチャットが使える、外部のツールです。">
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    {servers.filter((server) => server.signInError).map((server) => <Banner
      key={server.id}
      tone="warn"
      icon={<CircleAlert size={18} aria-hidden="true" />}
      action={<Button variant="secondary" small busy={signing === server.id} onClick={() => void signIn(server.id)}>サインイン</Button>}
    >
      {server.name}: {server.signInError} それまで、自動化とチャットはこのツールを使えません。
    </Banner>)}
    {servers.length === 0
      ? <Empty title="外部ツールはありません" />
      : <List>{servers.map((server) => <Row
        key={server.id}
        title={server.name}
        sub={`${server.url} ・ ${server.signInError ? 'サインインが必要です' : word(mcpAuthentication, server.authentication)}`}
        aside={<>
          {server.authentication !== 'token' && <Button variant="quiet" small busy={signing === server.id} aria-label={`${server.name} にサインイン`} onClick={() => void signIn(server.id)}>サインイン</Button>}
          <Button variant="quiet" small onClick={() => setSheet({ kind: 'try', server })}>試す</Button>
          <Button variant="quiet" small busy={removing === server.id} icon={<Trash2 size={16} aria-hidden="true" />} aria-label={`${server.name} を削除`} onClick={() => void remove(server.id)}>削除</Button>
        </>}
        wrap
      />)}</List>}
    <Toolbar><Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setSheet({ kind: 'add' })}>外部ツールを追加</Button></Toolbar>
    {sheet?.kind === 'add' && <AddMcpServer accountId={accountId} reload={reload} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'try' && <TryMcpServer accountId={accountId} server={sheet.server} onClose={() => setSheet(null)} />}
  </Section>;
};
