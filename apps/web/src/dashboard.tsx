import { CircleAlert, ShieldCheck } from 'lucide-react';
import { createContext, useContext } from 'react';
import { isRouteErrorResponse, Link, Outlet, useLoaderData, useLocation, useNavigation, useRevalidator, useRouteError } from 'react-router-dom';

import type { AccountMembership, AppState, SignedInPerson } from '@mail/domain';

import { api } from './api';
import { BrandMark } from './brand';
import { pendingKey, usePendingOperations } from './pending';
import { SidebarPeople } from './people';
import { dailyPlaces, isAt, morePlace, morePlaceGroups, type Place } from './places';
import { PendingOverlay } from './progress';
import { Button } from './ui/button';
import { Banner } from './ui/notice';
import styles from './ui/shell.module.css';

export type ReadyState = Extract<AppState, { kind: 'ready' }>;

/** What every screen shares: the application state, the person this page is for, and their Account. */
export interface AccountData {
  state: ReadyState;
  person: SignedInPerson;
  account: AccountMembership;
}

/**
 * The Account this page opened with. It stays the page's until the page loads
 * again, so a switch to another Google account made in another tab never turns
 * this one into someone else's: a loaded page goes on reading and writing the
 * Account it shows.
 */
let opened: string | null = null;

/** Forgets the Account this page opened with, as loading the page again would. */
export const forgetOpenedAccount = (): void => { opened = null; };

/** The Account this page is for: the current person's when the page loaded. */
export const openedAccountId = async (): Promise<string> => {
  if (opened) return opened;
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Account is not ready', { status: 409 });
  opened = state.account.accountId;
  return opened;
};

export const loadAccount = async (): Promise<AccountData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Account is not ready', { status: 409 });
  const accountId = await openedAccountId();
  const person = state.people.find((candidate) => candidate.account?.accountId === accountId);
  if (person?.account) return { state, person, account: person.account };
  // Its person signed out in another tab, so the page becomes the current person's.
  opened = state.account.accountId;
  const current = state.people[0];
  if (!current) throw new Response('Account was not found', { status: 404 });
  return { state, person: current, account: state.account };
};

/** The Account a screen loader is asked for: the one this page opened with. */
export const accountIdOf = (): Promise<string> => openedAccountId();

/** The screen below the Account a path is on, such as `tasks` for one Task, to open for someone else. */
const screenOf = (pathname: string): string => pathname.split('/').filter(Boolean)[0] ?? 'chat';

/** The shell's context: the state, the person and their Account, and the actions every screen offers. */
export interface AccountShell extends AccountData {
  /** Signs this page's person out of the browser. */
  logout: () => void;
  /** Signs every Google account out of the browser. */
  logoutEveryone: () => void;
  reauthenticate: () => void;
  /** Opens the same screen as another Google account signed in on this browser. */
  switchPerson: (identityId: string) => void;
  /** Signs another Google account in, keeping this one, and opens the same screen as them. */
  addPerson: () => void;
  leaving: boolean;
  reauthenticating: boolean;
}

const AccountContext = createContext<AccountShell | null>(null);

export const useAccount = (): AccountShell => {
  const value = useContext(AccountContext);
  if (!value) throw new Error('Account shell context is unavailable.');
  return value;
};

export const needsGoogleReauthentication = (error: string): boolean =>
  /token has been expired or revoked/iu.test(error);

export const GoogleReauthenticationAction = ({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) =>
  <Button variant="secondary" small onClick={onClick} busy={busy} icon={<ShieldCheck size={16} aria-hidden="true" />}>
    {busy ? 'Google へ接続中…' : 'メールの受信箱を再接続する'}
  </Button>;

/**
 * The Account shell: the side bar on a wide screen, the bottom tabs on a phone,
 * and an outlet for the screen. It loads nothing a screen
 * reads and holds no screen's state. A pressed destination is current at once,
 * before its screen has loaded.
 */
export const Dashboard = () => {
  const { state, person, account } = useLoaderData<AccountData>();
  const navigation = useNavigation();
  const location = useLocation();
  const operations = usePendingOperations();
  const destination = navigation.location?.pathname ?? location.pathname;
  const current = (place: Place): 'page' | undefined => isAt(destination, '', place.to) ? 'page' : undefined;
  const inMore = morePlaceGroups.some((group) => group.places.some((place) => current(place))) || current(morePlace) !== undefined;
  const leaving = operations.pending(pendingKey.logout);
  const reauthenticating = operations.pending(pendingKey.reauthenticate);
  // Who a page is for is settled when it loads, so each of these loads the page anew.
  const logout = (): void => void operations.run(pendingKey.logout, async () => {
    await api.logout({ identityId: person.identityId });
    window.location.assign('/');
  });
  const logoutEveryone = (): void => void operations.run(pendingKey.logout, async () => {
    await api.logout({ everyone: true });
    window.location.assign('/');
  });
  const reauthenticate = (): void => void operations.run(pendingKey.reauthenticate, async () => {
    window.location.assign((await api.reauthorizeAutomationInbox(account.accountId)).authorizationUrl);
  });
  const switchPerson = (identityId: string): void => void operations.run(pendingKey.switchPerson, async () => {
    const target = state.people.find((candidate) => candidate.identityId === identityId);
    await api.switchPerson(identityId);
    window.location.assign(target?.account ? `/${screenOf(location.pathname)}` : '/');
  });
  const addPerson = (): void => void operations.run(pendingKey.switchPerson, async () => {
    window.location.assign((await api.beginGoogleLogin(`/${screenOf(location.pathname)}`)).authorizationUrl);
  });

  const shell: AccountShell = { state, person, account, logout, logoutEveryone, reauthenticate, switchPerson, addPerson, leaving, reauthenticating };
  return <AccountContext.Provider value={shell}><div className={styles.shell}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><BrandMark className={styles.brandMark} size={34} />OrangeAgent</div>
      <nav className={styles.nav} aria-label="メインナビゲーション">
        <div className={styles.group}>
          <span className={styles.groupTitle}>毎日</span>
          {dailyPlaces.map((place) => <Link key={place.to} to={place.to} className={styles.link} aria-current={current(place)}><place.icon size={18} aria-hidden="true" />{place.label}</Link>)}
        </div>
        {morePlaceGroups.map((group) => <div key={group.title} className={styles.group}>
          <span className={styles.groupTitle}>{group.title}</span>
          {group.places.map((place) => <Link key={place.to} to={place.to} className={styles.link} aria-current={current(place)}><place.icon size={18} aria-hidden="true" />{place.label}</Link>)}
        </div>)}
      </nav>
      <SidebarPeople />
    </aside>
    <main className={styles.main} aria-busy={navigation.state !== 'idle'}>
      {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
      <Outlet key={account.accountId} />
    </main>
    <nav className={styles.tabbar} aria-label="タブ">
      {dailyPlaces.map((place) => <Link key={place.to} to={place.to} className={styles.tab} aria-current={current(place)}><place.icon size={24} aria-hidden="true" />{place.label}</Link>)}
      <Link to={morePlace.to} className={styles.tab} aria-current={inMore ? 'page' : undefined}><morePlace.icon size={24} aria-hidden="true" />{morePlace.label}</Link>
    </nav>
    <PendingOverlay running={operations.running} />
  </div></AccountContext.Provider>;
};

/** A screen whose loader failed, shown inside the shell so the way out stays visible. */
export const ScreenError = () => {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const { reauthenticate, reauthenticating } = useAccount();
  const message = isRouteErrorResponse(error)
    ? error.status === 404 ? 'この画面の対象が見つかりません。' : error.statusText || '画面を表示できませんでした。'
    : error instanceof Error ? error.message : '画面を表示できませんでした。';
  const retrying = revalidator.state !== 'idle';
  return <Banner
    tone="danger"
    icon={<CircleAlert size={18} aria-hidden="true" />}
    action={<>
      {needsGoogleReauthentication(message) && <GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />}
      <Button variant="secondary" small busy={retrying} onClick={() => void revalidator.revalidate()}>{retrying ? '再試行中…' : '再試行'}</Button>
    </>}
  >{message}</Banner>;
};
