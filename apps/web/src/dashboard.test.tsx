import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import type { AppState } from '@mail/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { fakeApi } from './fake';
import { accountIdOf, Dashboard, forgetOpenedAccount, loadAccount } from './dashboard';
import { screenRoute, type Screen } from './router';
import { RootLayout } from './routes';
import { ACCOUNT_ID, ready } from './screens/fixtures';
import { deferred } from './screens/render';

fakeApi();

/** The side bar; the bottom tabs hold the same links for a phone. */
const sidebar = () => within(screen.getByRole('navigation', { name: 'メインナビゲーション' }));
const tabs = () => within(screen.getByRole('navigation', { name: 'タブ' }));

const instant = (heading: string): Screen => ({ loader: async () => null, default: () => <h1>{heading}</h1> });

/** Renders the shell with a Tasks screen that loads at once and a Contacts screen that waits for the test. */
const renderShell = (contactsLoad: Promise<null>) => {
  vi.mocked(api.bootstrap).mockResolvedValue(ready);
  forgetOpenedAccount();
  const router = createMemoryRouter([{
    path: '/',
    element: <RootLayout />,
    children: [{
      loader: () => loadAccount(),
      element: <Dashboard />,
      children: [
        screenRoute('events', instant('予定の画面')),
        screenRoute('contacts', { loader: () => contactsLoad, default: () => <h1>連絡先の画面</h1> }),
        screenRoute('automations', instant('自動化の画面')),
      ],
    }],
  }], { initialEntries: ['/events'] });
  return render(<RouterProvider router={router} />);
};

describe('moving between screens', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('marks the pressed destination current while its screen is still loading', async () => {
    const contacts = deferred<null>();
    const user = userEvent.setup();
    renderShell(contacts.promise);
    await screen.findByRole('heading', { name: '予定の画面' });

    await user.click(tabs().getByRole('link', { name: '連絡先' }));

    expect(tabs().getByRole('link', { name: '連絡先' }).getAttribute('aria-current')).toBe('page');
    expect(tabs().getByRole('link', { name: '予定' }).getAttribute('aria-current')).toBeNull();
    expect(sidebar().getByRole('link', { name: '連絡先' }).getAttribute('aria-current')).toBe('page');
    contacts.resolve(null);
    await screen.findByRole('heading', { name: '連絡先の画面' });
  });

  it('keeps the screen uncovered while the next one loads', async () => {
    const contacts = deferred<null>();
    const user = userEvent.setup();
    renderShell(contacts.promise);
    await screen.findByRole('heading', { name: '予定の画面' });

    await user.click(sidebar().getByRole('link', { name: '連絡先' }));

    expect(screen.queryByText('ページを読み込んでいます')).toBeNull();
    expect(screen.queryByText('完了するまでこのページを開いたままにしてください。')).toBeNull();
    contacts.resolve(null);
    await screen.findByRole('heading', { name: '連絡先の画面' });
  });

  it('marks その他 current on a screen the bottom tabs leave out', async () => {
    const user = userEvent.setup();
    renderShell(Promise.resolve(null));
    await screen.findByRole('heading', { name: '予定の画面' });

    await user.click(sidebar().getByRole('link', { name: '自動化' }));

    await screen.findByRole('heading', { name: '自動化の画面' });
    expect(tabs().getByRole('link', { name: 'その他' }).getAttribute('aria-current')).toBe('page');
    expect(tabs().getByRole('link', { name: '予定' }).getAttribute('aria-current')).toBeNull();
  });

  it('opens the next screen at its top', async () => {
    const user = userEvent.setup();
    renderShell(Promise.resolve(null));
    await screen.findByRole('heading', { name: '予定の画面' });
    vi.mocked(window.scrollTo).mockClear();

    await user.click(sidebar().getByRole('link', { name: '連絡先' }));

    await screen.findByRole('heading', { name: '連絡先の画面' });
    await waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith(0, 0));
  });
});

describe('a page signed in to several Google accounts', () => {
  /** The same browser after another tab switched to the second person, who owns org-2. */
  const switchedElsewhere: AppState = {
    kind: 'ready',
    identity: { email: 'second@example.com', displayName: 'Second' },
    people: [
      { identityId: 'identity-2', email: 'second@example.com', displayName: 'Second', account: { accountId: 'org-2', name: 'Second', status: 'active' } },
      { identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: ACCOUNT_ID, name: 'Example', status: 'active' } },
    ],
    account: { accountId: 'org-2', name: 'Second', status: 'active' },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    forgetOpenedAccount();
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps the Account it opened with after another tab switches to someone else', async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(ready);
    expect(await accountIdOf()).toBe(ACCOUNT_ID);
    vi.mocked(api.bootstrap).mockResolvedValue(switchedElsewhere);

    const data = await loadAccount();

    expect(await accountIdOf()).toBe(ACCOUNT_ID);
    expect(data.account.accountId).toBe(ACCOUNT_ID);
    expect(data.person.email).toBe('owner@example.com');
  });

  it('becomes the current person’s once its own person has signed out in another tab', async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(switchedElsewhere);
    expect(await accountIdOf()).toBe('org-2');
    vi.mocked(api.bootstrap).mockResolvedValue(ready);

    const data = await loadAccount();

    expect(data.account.accountId).toBe(ACCOUNT_ID);
    expect(await accountIdOf()).toBe(ACCOUNT_ID);
  });

  it('lists in the side bar every Google account signed in here, marking the one it is for', async () => {
    vi.mocked(api.bootstrap).mockResolvedValue(switchedElsewhere);
    const router = createMemoryRouter([{ loader: () => loadAccount(), element: <Dashboard />, children: [screenRoute('events', instant('予定の画面'))] }], { initialEntries: ['/events'] });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: '予定の画面' });

    const list = within(screen.getByRole('list', { name: 'ログイン中の Google アカウント' }));
    expect(list.getAllByRole('button').map((button) => button.textContent)).toEqual(['Secondsecond@example.com表示中', 'Ownerowner@example.com']);
    expect(list.getByRole('button', { name: /Second/u }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'すべてログアウト' })).toBeTruthy();
  });
});
