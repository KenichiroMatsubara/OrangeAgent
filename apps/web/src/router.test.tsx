// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, type LoaderFunctionArgs } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { ApiError } from './api';
import { createAppRoutes, accountRoutePaths, resolveApplicationRedirect, routePaths } from './router';
import { logoutFromRouteError, ContactPageView, scrollKey } from './routes';
import { pendingKey } from './pending';

describe('application routes', () => {
  it('exposes stable public and organization URLs', () => {
    expect(routePaths).toEqual({
      signedOut: '/',
      setup: '/setup',
      setupProvisioning: '/setup/provisioning',
      setupFailed: '/setup/failed',
      legacyAccount: '/organizations/:accountId/*',
      portal: '/portal',
      portalJoin: '/portal/join/:accountId/:token',
      authorize: '/authorize',
    });
    expect(accountRoutePaths).toEqual({
      home: 'home',
      events: 'events',
      event: 'events/:eventId',
      chat: 'chat',
      thread: 'chat/:threadId',
      automations: 'automations',
      automation: 'automations/:automationId',
      connections: 'connections',
      transcripts: 'transcripts',
      transcript: 'transcripts/:transcriptId',
      skills: 'skills',
      skill: 'skills/:skillId',
      memory: 'memory',
      browser: 'browser',
      contacts: 'contacts',
      contact: 'contacts/:contactId',
      operations: 'operations',
      settings: 'settings',
      more: 'more',
      // Retired destinations keep redirecting so existing links still land
      // somewhere sensible.
      members: 'members',
      rules: 'rules',
      agentRule: 'rules/agent/:ruleId',
      schemaRule: 'rules/schema/:ruleId',
      ruleRuns: 'rule-runs',
      mailboxTest: 'mailbox-test',
      channelTest: 'channel-test',
      eventRefresh: 'event-refresh',
      reminders: 'reminders',
      chatNext: 'chat/next',
      chatNextThread: 'chat/next/:threadId',
    });
  });

  it('builds screen URLs that name no Account, without string concatenation at call sites', async () => {
    const { accountUrl } = await import('./router');

    expect(accountUrl('automations')).toBe('/automations');
  });

  it('redirects a URL that does not match the durable application state', () => {
    const signedOut = { kind: 'signed_out' } as AppState;
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;

    expect(resolveApplicationRedirect('/setup', signedOut)).toBe('/');
    expect(resolveApplicationRedirect('/setup/provisioning', ready)).toBe('/chat');
    expect(resolveApplicationRedirect('/', ready)).toBe('/chat');
    expect(resolveApplicationRedirect('/automations', signedOut)).toBe('/');
    expect(resolveApplicationRedirect('/automations', ready)).toBeNull();
    // An address from before screens lost the Account is settled by its own route.
    expect(resolveApplicationRedirect('/organizations/org-1/automations', ready)).toBeNull();
    expect(resolveApplicationRedirect('/authorize', signedOut)).toBeNull();
    expect(resolveApplicationRedirect('/authorize', ready)).toBeNull();
  });

  it('supports memory-router deep links and a visible unknown-route match', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), { initialEntries: ['/automations/automation-1'] });
    await router.initialize();
    expect(router.state.location.pathname).toBe('/automations/automation-1');
    expect(router.state.matches.at(-1)?.route.path).toBe('automations/:automationId');
    expect(router.state.matches.at(-1)?.params.automationId).toBe('automation-1');

    const unknown = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), { initialEntries: ['/unknown'] });
    await unknown.initialize();
    expect(unknown.state.matches.at(-1)?.route.path).toBe('*');
  });

  it('sends the retired reminders screen to the settings that took it over', async () => {
    const [root] = createAppRoutes({ bootstrap: async () => ({ kind: 'signed_out' } as AppState), logout: async () => ({ loggedOut: true, remaining: 0 }), switchPerson: async () => ({ switched: true }) });
    const account = root?.children?.find((route) => route.id === 'account');
    const reminders = account?.children?.find((route) => route.path === 'reminders');
    const args = { request: new Request('http://localhost/reminders'), params: {}, context: {} } as LoaderFunctionArgs;
    const result: unknown = typeof reminders?.loader === 'function' ? await reminders.loader(args) : null;

    expect(result instanceof Response ? result.headers.get('Location') : null).toBe('/settings');
  });

  it('opens the Account’s Contacts as a durable deep link', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), { initialEntries: ['/contacts'] });
    await router.initialize();
    expect(router.state.matches.at(-1)?.route.path).toBe('contacts');
  });

  it('sends a link to a retired Agent Rule or its runs to 自動化', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    for (const path of ['rules/agent/rule-1', 'rule-runs', 'mailbox-test']) {
      const router = createMemoryRouter(createAppRoutes({
        bootstrap: async () => ready,
        logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
      }), { initialEntries: [`/${path}`] });
      await router.initialize();
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/automations'));
    }
  });

  it('opens the member roster as a durable deep link', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), { initialEntries: ['/contacts'] });
    await router.initialize();
    expect(router.state.matches.at(-1)?.route.path).toBe('contacts');
  });

  it('opens a conversation under the address the chat had while it was rebuilt where it is now', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [{ identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } }],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    const routes = (initial: string) => createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), { initialEntries: [initial] });

    const thread = routes('/chat/next/thread%201?from=push');
    await thread.initialize();
    await vi.waitFor(() => expect(thread.state.location.pathname).toBe('/chat/thread%201'));
    expect(thread.state.location.search).toBe('?from=push');
    expect(thread.state.matches.at(-1)?.route.path).toBe('chat/:threadId');

    const list = routes('/chat/next');
    await list.initialize();
    await vi.waitFor(() => expect(list.state.location.pathname).toBe('/chat'));
  });

  it('opens an address from before screens lost the Account as its owner, switching to them first', async () => {
    const twoPeople = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      people: [
        { identityId: 'identity-1', email: 'owner@example.com', displayName: 'Owner', account: { accountId: 'org-1', name: 'Example', status: 'active' } },
        { identityId: 'identity-2', email: 'second@example.com', displayName: 'Second', account: { accountId: 'org-2', name: 'Second', status: 'active' } },
      ],
      account: { accountId: 'org-1', name: 'Example', status: 'active' },
    } as AppState;
    const switchPerson = vi.fn().mockResolvedValue({ switched: true });
    const routes = (initial: string) => createMemoryRouter(createAppRoutes({
      bootstrap: async () => twoPeople,
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson,
    }), { initialEntries: [initial] });

    const other = routes('/organizations/org-2/contacts/contact-1?tab=1');
    await other.initialize();
    await vi.waitFor(() => expect(other.state.location.pathname).toBe('/contacts/contact-1'));
    expect(other.state.location.search).toBe('?tab=1');
    expect(switchPerson).toHaveBeenCalledWith('identity-2');

    switchPerson.mockClear();
    const own = routes('/organizations/org-1/automations');
    await own.initialize();
    await vi.waitFor(() => expect(own.state.location.pathname).toBe('/automations'));
    const nobody = routes('/organizations/org-9');
    await nobody.initialize();
    await vi.waitFor(() => expect(nobody.state.location.pathname).toBe('/chat'));
    expect(switchPerson).not.toHaveBeenCalled();
  });

  it('offers a real logout action when a route cannot be displayed', async () => {
    const logout = vi.fn().mockResolvedValue({ loggedOut: true });
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ({ kind: 'signed_out' }),
      logout,
      switchPerson: async () => ({ switched: true }),
    }), {
      initialEntries: ['/automations'],
      hydrationData: {
        loaderData: {},
        errors: { root: new Error('Account database is unavailable.') },
      },
    });

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('ログアウトして入口へ戻る');
    expect(markup).toContain('<button');
  });

  it('offers retry first and keeps the session when a schema gate reports its versions', async () => {
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ({ kind: 'signed_out' }),
      logout: async () => ({ loggedOut: true, remaining: 0 }),
      switchPerson: async () => ({ switched: true }),
    }), {
      initialEntries: ['/'],
      hydrationData: {
        loaderData: {},
        errors: {
          root: new ApiError({
            code: 'schema_not_ready',
            databaseKind: 'organization',
            currentMigration: '9999_future.sql',
            expectedMigration: '0017_member_portal.sql',
            requestId: 'request-1',
          }, 503),
        },
      },
    });

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('再試行');
    expect(markup).toContain('9999_future.sql');
    expect(markup).toContain('0017_member_portal.sql');
    expect(markup.indexOf('再試行')).toBeLessThan(markup.indexOf('ログアウト'));
  });

  it('revokes the session before replacing the broken route with the entry route', async () => {
    const logout = vi.fn().mockResolvedValue({ loggedOut: true });
    const navigate = vi.fn();

    await logoutFromRouteError(logout, navigate);

    expect(logout).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('sends a Contact to the Portal and keeps them off the management GUI', () => {
    const contact = {
      kind: 'member',
      identity: { email: 'hanako@example.com', displayName: '山田花子' },
      account: { accountId: 'org-1', name: 'Example' },
    } as AppState;

    expect(resolveApplicationRedirect('/portal', contact)).toBeNull();
    expect(resolveApplicationRedirect('/', contact)).toBe('/portal');
    expect(resolveApplicationRedirect('/automations', contact)).toBe('/portal');
    expect(resolveApplicationRedirect('/organizations/org-1/automations', contact)).toBe('/portal');
  });

  it('keeps a portal invitation reachable in every application state, so signing in returns to it', () => {
    const signedOut = { kind: 'signed_out' } as AppState;
    const join = '/portal/join/org-1/token-1';

    expect(resolveApplicationRedirect(join, signedOut)).toBeNull();
    expect(resolveApplicationRedirect(join, {
      kind: 'unassigned',
      identity: { email: 'hanako@example.com', displayName: '山田花子' },
    } as AppState)).toBeNull();
  });
});

describe('Contact Portal progress', () => {
  const portal = {
    account: { accountId: 'org-1', name: 'Example' },
    contact: { contactId: 'member-1', name: '山田' },
    events: [{
      eventId: 'event-1', title: '総会', startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T03:00:00.000Z',
      location: '本部', registrationDeadline: null, status: 'unanswered' as const, comment: '', open: true,
    }],
  };
  const view = (pending: (key: string) => boolean, settled: (key: string) => boolean = () => false, running: string[] = []): string =>
    renderToStaticMarkup(<ContactPageView
      page={portal}
      running={running}
      pending={pending}
      settled={settled}
      error=""
      onAttendance={vi.fn()}
      onComment={vi.fn()}
      onLogout={vi.fn()}
    />);

  it('reports which attendance answer is being sent', () => {
    const html = view((key) => key === pendingKey.portalAttendance('event-1', 'attending'));

    expect(html.match(/送信中…/gu)?.length).toBe(1);
    expect(html).toContain('欠席');
  });

  it('reports a comment being saved, and that it was saved', () => {
    const saving = view((key) => key === pendingKey.portalComment('event-1'));
    const saved = view(() => false, (key) => key === pendingKey.portalComment('event-1'));

    expect(saving).toContain('保存中…');
    expect(saved).toContain('保存しました');
  });

  it('reports a Contact leaving the portal', () => {
    expect(view((key) => key === pendingKey.portalLogout)).toContain('ログアウト中…');
  });

  it('names the answer being sent outside the control too, where it stays in view', () => {
    const html = view(() => true, () => false, [pendingKey.portalAttendance('event-1', 'attending')]);

    expect(html).toContain('data-testid="pending-overlay"');
    expect(html).toContain('出欠を送信しています');
  });
});

describe('scroll positions', () => {
  it('remembers a page loaded from the address bar by its path, and any other by its history entry', () => {
    expect(scrollKey({ key: 'default', pathname: '/more' })).toBe('/more');
    expect(scrollKey({ key: 'k3x9', pathname: '/more' })).toBe('k3x9');
  });
});

describe('route loading progress', () => {
  it('shows a loading screen while the first route resolves', () => {
    const [root] = createAppRoutes({ bootstrap: async () => ({ kind: 'signed_out' } as AppState), logout: async () => ({ loggedOut: true, remaining: 0 }), switchPerson: async () => ({ switched: true }) });

    expect(root?.hydrateFallbackElement).toBeDefined();
  });
});
