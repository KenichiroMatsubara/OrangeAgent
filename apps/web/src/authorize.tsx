import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLoaderData, useLocation } from 'react-router-dom';

import type { AppState, AuthorizationPreview } from '@mail/domain';

import { api } from './api';
import { SetupBrand } from './brand';
import { errorText } from './parts';
import { dateLabel } from './time';

const Card = ({ children }: { children: React.ReactNode }) => <main className="setup-shell"><section className="setup-card login-card">
  <SetupBrand caption="CONNECT AN APP" />
  {children}
</section></main>;

/** A redirect to this machine goes to an app running on it, such as Claude Code, which any program here could claim to be. */
const isThisMachine = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host);

/**
 * The authorization screen an OAuth client such as Claude sends a member to.
 * A member signed out signs in with Google and comes back here; a signed-in
 * member is asked whether the client may act on an Account as them, and the
 * browser then returns to the client with the answer. When the MCP Server the
 * client named is a Google account's that is not signed in here, that account
 * is signed in beside the others and the screen comes back.
 */
export const AuthorizeRoute = () => {
  const state = useLoaderData<AppState>();
  const query = useLocation().search.replace(/^\?/u, '');
  const [preview, setPreview] = useState<AuthorizationPreview | null>(null);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signedIn = state.kind !== 'signed_out';

  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    api.previewAuthorization(query).then((answer) => {
      if (!current) return;
      if (answer.kind === 'refused') {
        window.location.replace(answer.location);
        return;
      }
      setPreview(answer);
      if (answer.kind === 'ask') setAccountId(answer.accounts[0]?.accountId ?? '');
    }, (cause: unknown) => { if (current) setError(errorText(cause, '接続の要求を読めませんでした。')); });
    return () => { current = false; };
  }, [query, signedIn]);

  const signIn = async (): Promise<void> => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleLogin(`/authorize?${query}`)).authorizationUrl); }
    catch (cause) { setError(errorText(cause, 'Google 認可を開始できませんでした。')); setBusy(false); }
  };
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true); setError('');
    try { window.location.assign((await api.decideAuthorization(query, accountId, approve)).location); }
    catch (cause) { setError(errorText(cause, '答えを送れませんでした。')); setBusy(false); }
  };

  if (!signedIn) {
    return <Card>
      <p className="eyebrow">GOOGLE</p><h1>アプリの接続</h1>
      <p className="setup-copy">アプリが OrangeAgent への接続を求めています。許可するかどうかを決める前に、Google でログインしてください。</p>
      {error && <p className="setup-error">{error}</p>}
      <button className="primary google-login entry-login" onClick={() => void signIn()} disabled={busy}><ShieldCheck size={18} />{busy ? 'Googleへ接続中…' : 'Google でログイン'}</button>
    </Card>;
  }
  if (error && !preview) return <Card><p className="eyebrow">CONNECT</p><h1>アプリの接続</h1><p className="setup-error">{error}</p></Card>;
  if (!preview || preview.kind === 'refused') return <Card><p className="eyebrow">CONNECT</p><h1>アプリの接続</h1><p className="setup-copy">接続の要求を確かめています…</p></Card>;
  if (preview.kind === 'unsafe') return <Card><p className="eyebrow">CONNECT</p><h1>アプリの接続</h1><p className="setup-error">{preview.message}</p></Card>;
  if (preview.kind === 'sign_in') {
    return <Card>
      <p className="eyebrow">GOOGLE</p><h1>{preview.client} の接続</h1>
      <p className="setup-copy">{preview.client} がつなごうとしているアカウントの Google アカウントで、このブラウザにログインしていません。そのアカウントを持つ Google アカウントでログインしてください。いまログイン中の Google アカウントは、そのまま残ります。</p>
      {error && <p className="setup-error">{error}</p>}
      <button className="primary google-login entry-login" onClick={() => void signIn()} disabled={busy}><ShieldCheck size={18} />{busy ? 'Googleへ接続中…' : '別の Google アカウントでログイン'}</button>
    </Card>;
  }

  const chosen = preview.accounts.find((account) => account.accountId === accountId);
  return <Card>
    <p className="eyebrow">CONNECT</p><h1>{preview.client} を接続しますか？</h1>
    <p className="setup-copy">
      {`${preview.client} が、${chosen ? `${chosen.email} として「${chosen.name}」` : 'アカウント'}を操作できるようになります。運用チャットと同じように Gmail・カレンダー・Drive・連絡先・タスク・スキル・記憶を使い、送信もできます。`}
    </p>
    <p className="setup-copy">答えを受け取る先: <strong>{preview.redirectHost}</strong></p>
    {isThisMachine(preview.redirectHost) && <p className="setup-error">このコンピューターで動いているアプリ（Claude Code など）に渡します。自分で始めた接続でなければ拒否してください。</p>}
    <p className="setup-copy">許可は{dateLabel(preview.expiresAt)}まで続き、接続画面からいつでも取り消せます。</p>
    {preview.accounts.length > 1 && <label className="setup-copy">アカウント
      <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        {preview.accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.name}（{account.email}）</option>)}
      </select>
    </label>}
    {error && <p className="setup-error">{error}</p>}
    <button className="primary" onClick={() => void decide(true)} disabled={busy || !accountId}>{busy ? '送っています…' : '許可する'}</button>
    <button className="secondary" onClick={() => void decide(false)} disabled={busy}>拒否する</button>
  </Card>;
};
