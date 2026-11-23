import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppState } from '@mail/domain';

import { api } from './api';
import { fakeApi } from './fake';
import { AuthorizeRoute } from './authorize';

fakeApi();

const QUERY = 'response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=s';
const identity = { email: 'owner@example.com', displayName: 'Owner' };
const ready: AppState = {
  kind: 'ready',
  identity,
  people: [{ identityId: 'identity-1', ...identity, account: { accountId: 'org-1', name: 'サンプル町内会', status: 'active' } }],
  account: { accountId: 'org-1', name: 'サンプル町内会', status: 'active' },
};

const open = (state: AppState): void => {
  const router = createMemoryRouter([{ path: '/authorize', loader: () => state, element: <AuthorizeRoute /> }], { initialEntries: [`/authorize?${QUERY}`] });
  render(<RouterProvider router={router} />);
};

const assign = vi.fn();
const replace = vi.fn();

describe('the authorization screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('location', { ...window.location, assign, replace });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('signs a member in with Google and returns them to this same request', async () => {
    vi.mocked(api.beginGoogleLogin).mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' });
    const user = userEvent.setup();
    open({ kind: 'signed_out' });

    await user.click(await screen.findByRole('button', { name: 'Google でログイン' }));

    expect(api.beginGoogleLogin).toHaveBeenCalledWith(`/authorize?${QUERY}`);
    expect(api.previewAuthorization).not.toHaveBeenCalled();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth'));
  });

  it('asks whether the app may act as the member on the Account, saying who receives the answer and until when', async () => {
    vi.mocked(api.previewAuthorization).mockResolvedValue({
      kind: 'ask', client: 'Claude', redirectHost: 'claude.ai',
      accounts: [{ accountId: 'org-1', name: 'サンプル町内会', email: 'owner@example.com' }], expiresAt: '2027-02-02T09:00:00.000Z',
    });
    vi.mocked(api.decideAuthorization).mockResolvedValue({ location: 'https://claude.ai/api/mcp/auth_callback?code=x&state=s' });
    const user = userEvent.setup();
    open(ready);

    expect(await screen.findByRole('heading', { name: 'Claude を接続しますか？' })).toBeTruthy();
    expect(screen.getByText(/owner@example.com として「サンプル町内会」を操作できるようになります/u)).toBeTruthy();
    expect(screen.getByText('claude.ai')).toBeTruthy();
    expect(screen.getByText(/2月2日（火）まで続き/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '許可する' }));

    expect(api.previewAuthorization).toHaveBeenCalledWith(QUERY);
    expect(api.decideAuthorization).toHaveBeenCalledWith(QUERY, 'org-1', true);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=x&state=s'));
  });

  it('warns that an answer to this machine goes to whatever app is listening here', async () => {
    vi.mocked(api.previewAuthorization).mockResolvedValue({
      kind: 'ask', client: 'Claude Code', redirectHost: 'localhost:3118',
      accounts: [{ accountId: 'org-1', name: 'サンプル町内会', email: 'owner@example.com' }], expiresAt: '2027-02-02T09:00:00.000Z',
    });
    open(ready);

    expect(await screen.findByText(/このコンピューターで動いているアプリ/u)).toBeTruthy();
  });

  it('sends a request the client must be told about straight back to it', async () => {
    vi.mocked(api.previewAuthorization).mockResolvedValue({ kind: 'refused', location: 'https://claude.ai/api/mcp/auth_callback?error=invalid_request' });
    open(ready);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?error=invalid_request'));
  });

  it('signs in the Google account whose MCP Server the app named, beside those signed in, and returns to this request', async () => {
    vi.mocked(api.previewAuthorization).mockResolvedValue({ kind: 'sign_in', client: 'Claude' });
    vi.mocked(api.beginGoogleLogin).mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' });
    const user = userEvent.setup();
    open(ready);

    await user.click(await screen.findByRole('button', { name: '別の Google アカウントでログイン' }));

    expect(screen.getByText(/いまログイン中の Google アカウントは、そのまま残ります/u)).toBeTruthy();
    expect(api.beginGoogleLogin).toHaveBeenCalledWith(`/authorize?${QUERY}`);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth'));
  });

  it('says why a request that cannot be answered goes nowhere', async () => {
    vi.mocked(api.previewAuthorization).mockResolvedValue({ kind: 'unsafe', message: 'この接続元は FlareChat に登録されていません。' });
    open(ready);

    expect(await screen.findByText('この接続元は FlareChat に登録されていません。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '許可する' })).toBeNull();
  });
});
