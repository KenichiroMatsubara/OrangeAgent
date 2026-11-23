import type { AppState } from '@mail/domain';
import { createBrowserRouter, redirect, type LoaderFunctionArgs, type RouteObject } from 'react-router-dom';

import { api } from './api';
import { AuthorizeRoute } from './authorize';
import { Dashboard, forgetOpenedAccount, loadAccount, ScreenError } from './dashboard';
import { LoadingRoute, ContactPageJoinRoute, ContactPageRoute, NotFoundRoute, OAuthError, RootLayout, RouteError, SetupProgressRoute, SetupRoute } from './routes';
import * as automation from './screens/automation';
import * as automations from './screens/automations';
import * as chat from './screens/chat';
import * as connections from './screens/connections';
import * as more from './screens/more';
import * as thread from './screens/thread';
import * as contact from './screens/contact';
import * as contacts from './screens/contacts';
import * as event from './screens/event';
import * as events from './screens/events';
import * as home from './screens/home';
import * as operations from './screens/operations';
import * as memory from './screens/memory';
import * as browser from './screens/browser';
import * as skill from './screens/skill';
import * as skills from './screens/skills';
import * as settings from './screens/settings';
import * as transcript from './screens/transcript';
import * as transcripts from './screens/transcripts';

export const routePaths = {
  signedOut: '/',
  setup: '/setup',
  setupProvisioning: '/setup/provisioning',
  setupFailed: '/setup/failed',
  /** Where every screen used to be, below the Account; such a link switches to its owner and opens the same screen. */
  legacyAccount: '/organizations/:accountId/*',
  portal: '/portal',
  portalJoin: '/portal/join/:accountId/:token',
  authorize: '/authorize',
} as const;

export const accountRoutePaths = {
  home: 'home',
  events: 'events',
  event: 'events/:eventId',
  /** Operator Chat's conversations, and one of them; a conversation of the chat before it opens under its own id (migration 0061). */
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
  // Retired destinations, kept so an existing link still lands somewhere
  // sensible. Nothing navigates to them on purpose.
  members: 'members',
  rules: 'rules',
  agentRule: 'rules/agent/:ruleId',
  schemaRule: 'rules/schema/:ruleId',
  ruleRuns: 'rule-runs',
  mailboxTest: 'mailbox-test',
  channelTest: 'channel-test',
  eventRefresh: 'event-refresh',
  reminders: 'reminders',
  /** Where the chat was while it was being rebuilt, as notifications already sent still name it. */
  chatNext: 'chat/next',
  chatNextThread: 'chat/next/:threadId',
} as const;

/** Where a screen of the Account this page is for is. Its address names no Account: the page is the Google account's it opened as. */
export const accountUrl = (page: keyof typeof accountRoutePaths): string => `/${accountRoutePaths[page]}`;

const firstAccountUrl = accountUrl('chat');

const accountScreens = new Set(Object.values(accountRoutePaths).map((path) => path.split('/')[0]));
const isAccountPath = (pathname: string): boolean => accountScreens.has(pathname.split('/')[1] ?? '');
const isLegacyAccountPath = (pathname: string): boolean => pathname.startsWith('/organizations/');
const isPortalJoinPath = (pathname: string): boolean => pathname.startsWith('/portal/join/');
const isSetupPath = (pathname: string): boolean => pathname === routePaths.setup || pathname === routePaths.setupProvisioning || pathname === routePaths.setupFailed;

export const resolveApplicationRedirect = (pathname: string, state: AppState): string | null => {
  // A portal invitation is the one entry a Contact has, so it survives every
  // other redirect: signing in returns them to the same link.
  if (isPortalJoinPath(pathname)) return null;
  // An app asking to connect waits on its own screen, which signs a person in and returns to it.
  if (pathname === routePaths.authorize) return null;
  if (state.kind === 'member') return pathname === routePaths.portal ? null : routePaths.portal;
  if (state.kind === 'signed_out') return pathname === routePaths.signedOut ? null : routePaths.signedOut;
  if (state.kind === 'unassigned') return pathname === routePaths.setup ? null : routePaths.setup;
  if (state.kind === 'provisioning') return pathname === routePaths.setupProvisioning ? null : routePaths.setupProvisioning;
  if (state.kind === 'provisioning_failed') return pathname === routePaths.setupFailed ? null : routePaths.setupFailed;

  if (isAccountPath(pathname) || isLegacyAccountPath(pathname)) return null;
  if (pathname === routePaths.signedOut || isSetupPath(pathname)) return firstAccountUrl;
  return null;
};

export type RouterClient = Pick<typeof api, 'bootstrap' | 'logout' | 'switchPerson'>;

/**
 * An address from before screens lost the Account, such as a bookmark: it
 * opens the same screen as whoever signed in here owns that Account, switching
 * to them first, and as the current person when nobody here does.
 */
export const legacyAccountLoader = (client: RouterClient) => async ({ params, request }: LoaderFunctionArgs): Promise<never> => {
  const url = new URL(request.url);
  const below = params['*'] ?? '';
  const target = `/${below}${url.search}${url.hash}`;
  const state = await client.bootstrap();
  if (state.kind === 'signed_out') throw redirect(routePaths.signedOut);
  const owner = state.people.find((person) => person.account?.accountId === params.accountId);
  if (owner && owner.identityId !== state.people[0]?.identityId) await client.switchPerson(owner.identityId);
  forgetOpenedAccount();
  throw redirect(below ? target : firstAccountUrl);
};

const stateLoader = (client: RouterClient) => async ({ request }: LoaderFunctionArgs): Promise<AppState> => {
  const state = await client.bootstrap();
  const destination = resolveApplicationRedirect(new URL(request.url).pathname, state);
  if (destination) throw redirect(destination);
  return state;
};

/** A screen module: the loader that reads what it needs, and the component that renders it. */
export interface Screen {
  loader: (args: LoaderFunctionArgs) => Promise<unknown>;
  default: () => React.ReactNode;
}

/** One screen route: its own loader, its own element, and an error surface inside the shell. */
export const screenRoute = (path: string, screen: Screen): RouteObject => ({
  path,
  loader: screen.loader,
  element: <screen.default />,
  errorElement: <ScreenError />,
});

const retired = (path: string, to: keyof typeof accountRoutePaths): RouteObject => ({ path, loader: () => redirect(accountUrl(to)), element: <LoadingRoute /> });

/** A conversation under the address the chat had while it was rebuilt, opened where it is now. */
export const movedThread = ({ params, request }: LoaderFunctionArgs): Response => {
  const url = new URL(request.url);
  return redirect(`${accountUrl('chat')}/${encodeURIComponent(params.threadId ?? '')}${url.search}`);
};

const rootRoute = (client: RouterClient): RouteObject => ({
  id: 'root',
  path: '/',
  loader: stateLoader(client),
  element: <RootLayout />,
  hydrateFallbackElement: <LoadingRoute />,
  errorElement: <RouteError logout={client.logout} />,
  children: [
    { index: true, element: <OAuthError /> },
    { path: 'portal', loader: stateLoader(client), element: <ContactPageRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'portal/join/:accountId/:token', loader: stateLoader(client), element: <ContactPageJoinRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'authorize', loader: stateLoader(client), element: <AuthorizeRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup', loader: stateLoader(client), element: <SetupRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/provisioning', loader: stateLoader(client), element: <SetupProgressRoute failed={false} />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/failed', loader: stateLoader(client), element: <SetupProgressRoute failed />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'organizations/:accountId/*', loader: legacyAccountLoader(client), element: <LoadingRoute />, errorElement: <RouteError logout={client.logout} /> },
    {
      // The screens of the Account this page is for, at the top of the address: who it is for is settled when the page loads.
      id: 'account',
      loader: () => loadAccount(),
      element: <Dashboard />,
      errorElement: <RouteError logout={client.logout} />,
      children: [
        screenRoute(accountRoutePaths.home, home),
        screenRoute(accountRoutePaths.events, events),
        screenRoute(accountRoutePaths.event, event),
        screenRoute(accountRoutePaths.chat, chat),
        screenRoute(accountRoutePaths.thread, thread),
        screenRoute(accountRoutePaths.automations, automations),
        screenRoute(accountRoutePaths.automation, automation),
        screenRoute(accountRoutePaths.connections, connections),
        screenRoute(accountRoutePaths.transcripts, transcripts),
        screenRoute(accountRoutePaths.transcript, transcript),
        screenRoute(accountRoutePaths.skills, skills),
        screenRoute(accountRoutePaths.skill, skill),
        screenRoute(accountRoutePaths.memory, memory),
        screenRoute(accountRoutePaths.browser, browser),
        screenRoute(accountRoutePaths.contacts, contacts),
        screenRoute(accountRoutePaths.contact, contact),
        screenRoute(accountRoutePaths.operations, operations),
        screenRoute(accountRoutePaths.settings, settings),
        screenRoute(accountRoutePaths.more, more),
        retired(accountRoutePaths.members, 'contacts'),
        // Every Automation, whatever starts it, and its runs are on 自動化 now.
        retired(accountRoutePaths.rules, 'automations'),
        retired(accountRoutePaths.agentRule, 'automations'),
        retired(accountRoutePaths.schemaRule, 'automations'),
        retired(accountRoutePaths.ruleRuns, 'automations'),
        retired(accountRoutePaths.mailboxTest, 'automations'),
        retired(accountRoutePaths.channelTest, 'contacts'),
        retired(accountRoutePaths.eventRefresh, 'operations'),
        retired(accountRoutePaths.reminders, 'settings'),
        retired(accountRoutePaths.chatNext, 'chat'),
        { path: accountRoutePaths.chatNextThread, loader: movedThread, element: <LoadingRoute /> },
      ],
    },
    { path: '*', element: <NotFoundRoute /> },
  ],
});

export const createAppRoutes = (client: RouterClient = api): RouteObject[] => [rootRoute(client)];
export const createAppRouter = (client: RouterClient = api) => createBrowserRouter(createAppRoutes(client));
