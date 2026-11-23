import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, ScrollRestoration, useLoaderData, useNavigate, useNavigation, useParams, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState, AttendanceStatus, ContactPage } from '@mail/domain';

import { api } from './api';
import { SetupBrand } from './brand';
import { setupPhaseLabel, SignedOutEntry } from './entry';
import { pendingKey, usePendingOperations } from './pending';
import { PendingOverlay } from './progress';

/**
 * A route loader can run several API calls in parallel (e.g. switching
 * Account) while the previous page stays on screen, so without this bar
 * that wait looks indistinguishable from the app being stuck.
 */
export const NavigationProgress = () => {
  const navigation = useNavigation();
  const active = navigation.state !== 'idle';
  return <div className={active ? 'nav-progress active' : 'nav-progress'} role="progressbar" aria-hidden={!active}>
    {active && <span className="sr-only">読み込み中…</span>}
  </div>;
};

/**
 * The key a scroll position is remembered under. A page loaded from the address
 * bar always has the key `default`, so it is told apart by its path instead;
 * otherwise a reload of one screen would restore the position of another.
 */
export const scrollKey = (location: { key: string; pathname: string }): string =>
  location.key === 'default' ? location.pathname : location.key;

/** Every screen opens at its top, and the back button returns to where the reader was. */
export const RootLayout = () => <><NavigationProgress /><ScrollRestoration getKey={scrollKey} /><Outlet /></>;

export const OAuthError = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryError = searchParams.get('error') ?? '';
  const [error, setError] = useState(queryError);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!queryError) return;
    setError(queryError);
    setSearchParams({}, { replace: true });
  }, [queryError, setSearchParams]);
  const signIn = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleLogin()).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  return <SignedOutEntry busy={busy} error={error} onSignIn={() => void signIn()} />;
};

const SetupCard = ({ children }: { children: React.ReactNode }) => <main className="setup-shell"><section className="setup-card login-card">{children}</section></main>;

/**
 * A signed-in person with no Account of their own yet. Starting one asks for
 * no name and no Google permission: it is named after them, and its mailbox is
 * connected later on the 接続 screen.
 */
export const SetupRoute = () => {
  const state = useLoaderData<AppState>();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Signing this Google account out returns the browser to whoever else is signed in on it, or to the entry.
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); window.location.assign('/'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。'); setBusy(false); }
  };
  if (state.kind !== 'unassigned') return null;
  const previous = state.people[1];
  const start = async () => {
    setBusy(true); setError('');
    try { await api.startAccount(); navigate('/setup/provisioning', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'はじめられませんでした。'); setBusy(false); }
  };
  return <SetupCard>
    <SetupBrand caption="WELCOME" />
    <p className="eyebrow">{state.identity.email}</p><h1>OrangeAgentをはじめる</h1>
    <p className="setup-copy">このGoogleアカウントで使い始めます。Gmail・カレンダー・Drive は、使いたくなったときに「接続」画面からつなげます。</p>
    {error && <p className="setup-error">{error}</p>}
    <button className="primary" onClick={() => void start()} disabled={busy}>{busy ? '準備しています…' : 'はじめる'}</button>
    <button className="quiet-button" onClick={() => void logout()} disabled={busy}>{previous ? `ログアウトして ${previous.email} に戻る` : '別のGoogleアカウントでログインする'}</button>
  </SetupCard>;
};

export const SetupProgressRoute = ({ failed }: { failed: boolean }) => {
  const state = useLoaderData<AppState>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (failed || state.kind !== 'provisioning') return undefined;
    const timer = window.setInterval(() => void revalidator.revalidate(), 5_000);
    return () => window.clearInterval(timer);
  }, [failed, revalidator, state.kind]);
  if (failed && state.kind !== 'provisioning_failed') return null;
  if (!failed && state.kind !== 'provisioning') return null;
  const retry = async () => {
    setBusy(true); setError('');
    try { await api.retryOnboarding(); navigate('/setup/provisioning', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '再試行できませんでした。'); setBusy(false); }
  };
  const restart = async () => {
    setBusy(true); setError('');
    try { await api.cancelOnboarding(); navigate('/setup', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '最初からやり直せませんでした。'); setBusy(false); }
  };
  if (failed && state.kind === 'provisioning_failed') return <SetupCard>
    <p className="eyebrow">FAILED</p><h1>アカウントを準備できませんでした</h1>
    <p className="setup-copy">{setupPhaseLabel(state.phase)}</p>
    <p className="setup-error">{state.error ?? 'データベースを用意できませんでした。'}{error && ` ${error}`}</p>
    <button className="primary" onClick={() => void retry()} disabled={busy}>{busy ? '再試行中…' : 'この段階から再試行する'}</button>
    <button className="quiet-button" onClick={() => void restart()} disabled={busy}>最初からやり直す</button>
  </SetupCard>;
  if (!failed && state.kind === 'provisioning') return <SetupCard>
    <p className="eyebrow">PREPARING</p><h1>アカウントを準備しています</h1>
    <p className="setup-copy">{setupPhaseLabel(state.phase)}</p>
    <div className="loading"><RefreshCw className="spin" size={18} />{revalidator.state === 'idle' ? '5秒ごとに状態を確認しています…' : '状態を確認中…'}</div>
  </SetupCard>;
  return null;
};

export const NotFoundRoute = () => <SetupCard><p className="eyebrow">404</p><h1>ページが見つかりません</h1><p className="setup-copy">このURLには対応する画面がありません。</p><NavLink className="primary" to="/">入口へ戻る</NavLink></SetupCard>;

type Logout = () => Promise<{ loggedOut: boolean }>;
type EntryNavigation = (to: string, options: { replace: true }) => void;

export const logoutFromRouteError = async (
  logout: Logout,
  navigate: EntryNavigation,
): Promise<void> => {
  await logout();
  navigate('/', { replace: true });
};

export const RouteError = ({ logout = api.logout }: { logout?: Logout }) => {
  const error = useRouteError();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const message = isRouteErrorResponse(error) ? error.status === 404 ? 'Accountまたはページが見つかりません。' : error.statusText : error instanceof Error ? error.message : '画面を表示できませんでした。';
  const leave = async () => {
    setBusy(true);
    setLogoutError('');
    try {
      await logoutFromRouteError(logout, navigate);
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <p className="eyebrow">ROUTE ERROR</p>
    <h1>画面を表示できません</h1>
    <p className="setup-error">{message}</p>
    {logoutError && <p className="setup-error">{logoutError}</p>}
    <button className="primary" type="button" onClick={() => void revalidator.revalidate()} disabled={revalidator.state !== 'idle'}>
      {revalidator.state !== 'idle' ? '再試行中…' : '再試行'}
    </button>
    <button className="quiet-button" type="button" onClick={() => void leave()} disabled={busy}>
      {busy ? 'ログアウト中…' : 'ログアウトして入口へ戻る'}
    </button>
  </SetupCard>;
};

export const LoadingRoute = () => <SetupCard><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></SetupCard>;

/**
 * The single-use link that first brings a Contact to its Contact Page. It is
 * the only entry: a Contact reaches it through their linked Channel Handle,
 * signs in with the identity-only Google grant, and is bound to that account.
 */
export const ContactPageJoinRoute = () => {
  const state = useLoaderData<AppState>();
  const parameters = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accountId = parameters.accountId ?? '';
  const token = parameters.token ?? '';
  const signIn = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleLogin()).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  const join = async () => {
    setBusy(true); setError('');
    try {
      await api.joinContactPage(accountId, token);
      navigate('/portal', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このリンクは使用できませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <SetupBrand caption="CONTACT PAGE" />
    <p className="eyebrow">JOIN</p><h1>連絡先ページを開く</h1>
    {error && <p className="setup-error">{error}</p>}
    {state.kind === 'signed_out'
      ? <>
        <p className="setup-copy">Googleでログインすると、このリンクの連絡先としてアカウントが結び付きます。以降はこのアカウントだけで入れます。</p>
        <button className="primary" onClick={() => void signIn()} disabled={busy}>{busy ? 'Googleへ接続中…' : 'Googleでログイン'}</button>
      </>
      : <>
        <p className="setup-copy">{state.identity.email} をこの連絡先に結び付けます。リンクは一度だけ使えます。</p>
        <button className="primary" onClick={() => void join()} disabled={busy}>{busy ? '確認中…' : 'このアカウントで開始する'}</button>
      </>}
  </SetupCard>;
};

const attendanceLabel: Record<AttendanceStatus, string> = {
  unanswered: '未回答',
  attending: '出席',
  not_attending: '欠席',
};

export interface ContactPageViewProps {
  page: ContactPage;
  running: readonly string[];
  pending: (key: string) => boolean;
  settled: (key: string) => boolean;
  error: string;
  onAttendance: (eventId: string, status: AttendanceStatus, comment: string) => void;
  onComment: (eventId: string, status: AttendanceStatus, comment: string) => void;
  onLogout: () => void;
}

/** The Contact Page itself: every control reports the one answer it is sending. */
export const ContactPageView = ({ page, running, pending, settled, error, onAttendance, onComment, onLogout }: ContactPageViewProps) => {
  const leaving = pending(pendingKey.portalLogout);
  return <main className="portal-shell">
    <PendingOverlay running={running} />
    <header className="portal-header">
      <div><p className="eyebrow">{page.account.name}</p><h1>{page.contact.name} さんのページ</h1></div>
      <button className="quiet-button" disabled={leaving} onClick={onLogout}>{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
    </header>
    {error && <p className="setup-error">{error}</p>}
    <section className="portal-section">
      <h2>出欠登録</h2>
      {page.events.length === 0 && <p className="portal-empty">登録が必要な予定はありません。</p>}
      {page.events.map((event) => {
        const answering = (status: AttendanceStatus): boolean => pending(pendingKey.portalAttendance(event.eventId, status));
        const commenting = pending(pendingKey.portalComment(event.eventId));
        return <article key={event.eventId} className="portal-event" aria-busy={commenting || answering('attending') || answering('not_attending')}>
          <div><h3>{event.title}</h3><p>{event.startsAt}{event.location && ` ・ ${event.location}`}</p></div>
          {event.open
            ? <div className="portal-answer">
              {(['attending', 'not_attending'] as const).map((status) => <button
                key={status}
                type="button"
                className={event.status === status ? 'primary' : 'secondary'}
                disabled={answering(status)}
                onClick={() => onAttendance(event.eventId, status, event.comment)}
              >{answering(status) ? <><RefreshCw className="spin" size={14} />送信中…</> : attendanceLabel[status]}</button>)}
              <label>コメント<input
                defaultValue={event.comment}
                disabled={commenting}
                onBlur={(change) => { if (change.target.value !== event.comment) onComment(event.eventId, event.status, change.target.value); }}
              />{commenting
                ? <small className="portal-field-state"><RefreshCw className="spin" size={12} />保存中…</small>
                : settled(pendingKey.portalComment(event.eventId)) ? <small className="portal-field-state saved">保存しました</small> : null}</label>
            </div>
            : <p className="portal-locked">回答期限を過ぎました（現在: {attendanceLabel[event.status]}）</p>}
        </article>;
      })}
    </section>
  </main>;
};

/** The one signed-in page a Contact has: attendance and comments. */
export const ContactPageRoute = () => {
  const [page, setPage] = useState<ContactPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const { running, pending, settled, error, run } = usePendingOperations();
  const reload = async (): Promise<void> => { setPage(await api.contactPage()); };
  useEffect(() => {
    void reload().catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : '連絡先ページを開けませんでした。'));
  }, []);
  const answer = (key: string, work: () => Promise<unknown>): void => void run(key, async () => { await work(); await reload(); });
  if (!page) return <SetupCard>{loadError ? <p className="setup-error">{loadError}</p> : <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>}</SetupCard>;
  return <ContactPageView
    page={page}
    running={running}
    pending={pending}
    settled={settled}
    error={loadError || error}
    onAttendance={(eventId, status, comment) => answer(pendingKey.portalAttendance(eventId, status), () => api.registerContactAttendance(eventId, { status, comment }))}
    onComment={(eventId, status, comment) => answer(pendingKey.portalComment(eventId), () => api.registerContactAttendance(eventId, { status, comment }))}
    onLogout={() => void run(pendingKey.portalLogout, async () => { await api.logout(); window.location.assign('/'); })}
  />;
};
