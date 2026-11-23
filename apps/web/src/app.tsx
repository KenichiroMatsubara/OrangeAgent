import { RouterProvider } from 'react-router-dom';

import { startWorker } from './register';
import { createAppRouter } from './router';

const router = typeof window === 'undefined' ? null : createAppRouter();

// The Service Worker serves a built release; the development server has none.
if (router && import.meta.env.PROD) startWorker(router);

export const App = () => router ? <RouterProvider router={router} /> : null;
