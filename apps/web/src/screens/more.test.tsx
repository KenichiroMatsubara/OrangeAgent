import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppState } from '@mail/domain';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, ready } from './fixtures';
import * as more from './more';
import { renderScreen } from './render';

fakeApi();

/** A browser signed in to two Google accounts, each with an Account of its own, the owner current. */
const twoPeople: AppState = {
  kind: 'ready',
  identity: { email: 'owner@example.com', displayName: 'Owner' },
  people: [
    { identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: ACCOUNT_ID, name: 'Example', status: 'active' } },
    { identityId: 'identity-2', email: 'bousai@example.com', displayName: '防災委員会', account: { accountId: 'org-2', name: '防災委員会', status: 'active' } },
  ],
  account: { accountId: ACCOUNT_ID, name: 'Example', status: 'active' },
};

const people = () => within(screen.getByRole('region', { name: 'Google アカウント' }));

describe('その他 screen', () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('location', { ...window.location, assign });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists every screen the bottom tabs leave out, each with what it is for', async () => {
    renderScreen('more', more);

    const automation = await screen.findByRole('region', { name: 'AI と自動化' });
    expect(within(automation).getAllByRole('link').map((link) => link.textContent)).toEqual([
      '文字起こし会議の録音を話者ごとに文字起こしし、議事録にする',
      '自動化メール・毎朝・決まった時刻に動く AI',
      'スキルAI の仕事のやり方',
      '記憶AI が覚えていること・意味で探す',
      'ブラウザAI が操作するブラウザと、ログインしておくサイト',
    ]);
    expect(within(screen.getByRole('region', { name: '記録' })).getByRole('link', { name: /履歴/u }).getAttribute('href')).toBe(`/operations`);
  });

  it('shows the one Google account signed in, without a way to sign out everyone', async () => {
    renderScreen('more', more, undefined, ready);
    await screen.findByRole('heading', { name: 'その他' });

    expect(people().getByText('owner@example.com')).toBeTruthy();
    expect(people().getByText('表示中')).toBeTruthy();
    expect(people().getByRole('button', { name: 'Owner からログアウト' })).toBeTruthy();
    expect(people().queryByRole('button', { name: 'すべてログアウト' })).toBeNull();
  });

  it('opens the same screen as another Google account signed in here', async () => {
    const user = userEvent.setup();
    vi.mocked(api.switchPerson).mockResolvedValue({ switched: true });
    renderScreen('more', more, undefined, twoPeople);
    await screen.findByRole('heading', { name: 'その他' });

    await user.click(people().getByRole('button', { name: '防災委員会 に切り替える' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/more'));
    expect(api.switchPerson).toHaveBeenCalledWith('identity-2');
  });

  it('signs another Google account in and returns to the same screen', async () => {
    const user = userEvent.setup();
    vi.mocked(api.beginGoogleLogin).mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    renderScreen('more', more, undefined, twoPeople);
    await screen.findByRole('heading', { name: 'その他' });

    await user.click(people().getByRole('button', { name: '別の Google アカウントを追加' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(api.beginGoogleLogin).toHaveBeenCalledWith('/more');
  });

  it('signs out only the Google account this page is for, or everyone', async () => {
    const user = userEvent.setup();
    vi.mocked(api.logout).mockResolvedValue({ loggedOut: true, remaining: 1 });
    renderScreen('more', more, undefined, twoPeople);
    await screen.findByRole('heading', { name: 'その他' });

    await user.click(people().getByRole('button', { name: 'Owner からログアウト' }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledWith({ identityId: 'identity-1' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));

    await user.click(people().getByRole('button', { name: 'すべてログアウト' }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledWith({ everyone: true }));
  });
});
