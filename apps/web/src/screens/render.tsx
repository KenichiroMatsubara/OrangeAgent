import { render, type RenderResult } from '@testing-library/react';
import { Fragment, type JSXElementConstructor, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import type { AppState } from '@mail/domain';
import { vi } from 'vitest';

import { api } from '../api';
import { Dashboard, forgetOpenedAccount, loadAccount } from '../dashboard';
import { screenRoute, type Screen } from '../router';
import { ready } from './fixtures';

/** Resolves when the test says so, so a control can be observed mid-operation. */
export const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

/**
 * Renders one screen inside the Account shell, against the mocked client. The
 * test file mocks `../api` and stubs the endpoints its screen's loader reads;
 * the router is returned so a test can read the URL the screen moved to.
 * `wrapper` surrounds the screen, so a test can hand it what it reads from a
 * context, as the browser it asks about notifications.
 */
export const renderScreen = (
  path: string,
  screen: Screen,
  url = `/${path}`,
  state: AppState = ready,
  wrapper?: JSXElementConstructor<{ children: ReactNode }>,
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } => {
  vi.mocked(api.bootstrap).mockResolvedValue(state);
  forgetOpenedAccount();
  const router = createMemoryRouter([{
    id: 'account',
    path: '/',
    loader: () => loadAccount(),
    element: <Dashboard />,
    // Anywhere else a screen sends the Account, such as back to a list after a delete.
    children: [screenRoute(path, screen), { path: '*', element: <p>別の画面</p> }],
  }], { initialEntries: [url] });
  const Around = wrapper ?? Fragment;
  return { ...render(<Around><RouterProvider router={router} /></Around>), router };
};
