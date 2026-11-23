import type { BrowserLogin, BrowserSettings } from '@mail/domain';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import * as browser from './browser';
import { ACCOUNT_ID } from './fixtures';
import { renderScreen } from './render';

fakeApi();

const shop: BrowserLogin = { id: 'login-1', site: 'www.example-shop.jp', url: 'https://www.example-shop.jp/login', signingIn: false, savedAt: '2026-10-08T01:00:00.000Z', usedAt: null };

const settings = (overrides: Partial<BrowserSettings> = {}): BrowserSettings => ({ enabled: true, available: true, timeZone: null, logins: [], ...overrides });

describe('ブラウザ screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.browserSettings).mockResolvedValue(settings());
  });

  it('turns the browser off for every run, chat and Automation alike, from its one switch', async () => {
    vi.mocked(api.setBrowserEnabled).mockResolvedValue(settings({ enabled: false }));
    const user = userEvent.setup();
    renderScreen('browser', browser);

    const toggle = await screen.findByRole('switch', { name: /AI にブラウザを操作させる/u });
    expect(screen.getByText(/AI に聞く画面でも自動化でも/u)).toBeTruthy();
    await user.click(toggle);

    await waitFor(() => expect(api.setBrowserEnabled).toHaveBeenCalledWith(ACCOUNT_ID, false));
  });

  it('starts the time zone at the zone of the browser it is open in, and sets any zone a person chooses', async () => {
    vi.mocked(api.setBrowserTimeZone).mockResolvedValue(settings({ timeZone: 'Europe/London' }));
    const user = userEvent.setup();
    renderScreen('browser', browser);

    const select = await screen.findByLabelText('タイムゾーン') as HTMLSelectElement;
    expect(select.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByText(/まだ決めていないので/u)).toBeTruthy();
    await user.selectOptions(select, 'Europe/London');

    await waitFor(() => expect(api.setBrowserTimeZone).toHaveBeenCalledWith(ACCOUNT_ID, 'Europe/London'));
  });

  it('shows the zone already set, whatever zone this browser is in', async () => {
    vi.mocked(api.browserSettings).mockResolvedValue(settings({ timeZone: 'America/New_York' }));
    renderScreen('browser', browser);

    expect((await screen.findByLabelText('タイムゾーン') as HTMLSelectElement).value).toBe('America/New_York');
    expect(screen.queryByText(/まだ決めていないので/u)).toBeNull();
  });

  it('says when this Worker has no Browser Run, and begins no sign-in then', async () => {
    vi.mocked(api.browserSettings).mockResolvedValue(settings({ available: false }));
    renderScreen('browser', browser);

    expect(await screen.findByText(/Browser Run が結び付けられていない/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'ログインを始める' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('signs in through the Live View it hands out, and saves the sign-in once the person is done', async () => {
    vi.mocked(api.beginBrowserSignIn).mockResolvedValue({
      login: { ...shop, signingIn: true, savedAt: null },
      liveViewUrl: 'https://live.browser.run/view/target-1',
      expiresAt: '2026-11-21T01:20:00.000Z',
    });
    vi.mocked(api.saveBrowserSignIn).mockResolvedValue({ ...shop, savedAt: '2026-11-21T01:05:00.000Z' });
    const user = userEvent.setup();
    renderScreen('browser', browser);

    await user.type(await screen.findByLabelText('ログインするページの URL'), 'https://www.example-shop.jp/login');
    await user.click(screen.getByRole('button', { name: 'ログインを始める' }));

    await waitFor(() => expect(api.beginBrowserSignIn).toHaveBeenCalledWith(ACCOUNT_ID, 'https://www.example-shop.jp/login'));
    expect((await screen.findByRole('link', { name: /ログイン用の画面を開く/u })).getAttribute('href')).toBe('https://live.browser.run/view/target-1');
    await user.click(screen.getByRole('button', { name: 'ログインを保存' }));
    await waitFor(() => expect(api.saveBrowserSignIn).toHaveBeenCalledWith(ACCOUNT_ID, 'login-1'));
  });

  it('lists each saved sign-in in Tokyo time, and deletes one', async () => {
    vi.mocked(api.browserSettings).mockResolvedValue(settings({ logins: [shop] }));
    vi.mocked(api.removeBrowserLogin).mockResolvedValue({ id: 'login-1', deleted: true });
    const user = userEvent.setup();
    renderScreen('browser', browser);

    expect(await screen.findByText('www.example-shop.jp')).toBeTruthy();
    expect(screen.getByText(/10:00に保存 ・ まだ使っていません/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'www.example-shop.jp のログインを削除する' }));

    await waitFor(() => expect(api.removeBrowserLogin).toHaveBeenCalledWith(ACCOUNT_ID, 'login-1'));
  });
});
