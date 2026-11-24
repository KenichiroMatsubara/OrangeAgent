/**
 * What every part of the chat copied from t3code runs inside: its i18n, its atoms, its own router
 * (t3code's components read router state; the chat keeps its own in memory, apart from
 * OrangeAgent's), its toasts, and the `.t3chat` element its copied styles are scoped to (chat.css).
 */
import './chat.css';

import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createContext, type ReactElement, type ReactNode, use, useState } from 'react';

import { I18nProvider } from '~/i18n/I18nProvider';
import { startI18n } from '~/i18n/runtime';
import { chatPortalContainer } from '~/components/ui/portalContainer';
import { AnchoredToastProvider, ToastProvider } from '~/components/ui/toast';
import { AppAtomRegistryProvider } from '~/rpc/atomRegistry';

let i18nStarted = false;
const startI18nOnce = (): void => {
  if (i18nStarted) return;
  i18nStarted = true;
  startI18n();
};

const keepPortalContainer = (element: HTMLDivElement | null): void => {
  chatPortalContainer.current = element;
};

const ContentContext = createContext<ReactNode>(null);

function Routed(): ReactElement {
  const content = use(ContentContext);
  // Inside the router, as in t3code's root route: toasts read router state too.
  return (
    <ToastProvider>
      <AnchoredToastProvider>{content}</AnchoredToastProvider>
    </ToastProvider>
  );
}

export function ChatFrame({ className, children }: { readonly className: string; readonly children: ReactNode }): ReactElement {
  startI18nOnce();
  const [router] = useState(() => createRouter({
    routeTree: createRootRoute({ component: Routed }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  }));
  return (
    <div className={`t3chat ${className}`} lang="ja">
      <AppAtomRegistryProvider>
        <I18nProvider>
          <ContentContext value={children}>
            <RouterProvider router={router} />
          </ContentContext>
        </I18nProvider>
      </AppAtomRegistryProvider>
      <div ref={keepPortalContainer} />
    </div>
  );
}
