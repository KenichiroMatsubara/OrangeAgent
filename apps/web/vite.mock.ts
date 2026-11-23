import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The domain package is TypeScript source, which Node cannot load, so `dev:mock`
// loads this config through Vite's module runner (`--configLoader runner`).
import { t3chat } from '@mail/t3chat/vite';

import { mockResponse, mockSkillFile, startMockAt, type MockEntry } from './src/mock';

/** Milliseconds every mocked response waits, so loading states can be seen. */
const delay = Number(process.env.MOCK_DELAY ?? 0);

/** Where the mock starts (`MOCK_STATE=signed_out|unassigned|no_mailbox`); signed in with Accounts otherwise. */
const MOCK_ENTRIES: readonly MockEntry[] = ['ready', 'signed_out', 'unassigned', 'no_mailbox'];
const entry = MOCK_ENTRIES.find((candidate) => candidate === process.env.MOCK_STATE);
if (entry) startMockAt(entry);

/** A request's body: JSON as what it says, and anything else, such as a file, as its bytes. */
const readBody = (request: NodeJS.ReadableStream & { headers?: Record<string, string | string[] | undefined> }): Promise<unknown> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  request.on('end', () => {
    const bytes = Buffer.concat(chunks);
    const type = String(request.headers?.['content-type'] ?? 'application/json');
    if (!type.startsWith('application/json')) {
      resolve(new Uint8Array(bytes));
      return;
    }
    const text = bytes.toString('utf8');
    try { resolve(text ? JSON.parse(text) : undefined); }
    catch { resolve(undefined); }
  });
});

/** Answers `/api/*` from `src/mock.ts` instead of the Worker. */
const mockApi = (): Plugin => ({
  name: 'orangeagent-mock-api',
  configureServer: (server) => {
    server.middlewares.use('/api', (request, response) => {
      void (async () => {
        const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
        const skillFile = request.method === 'GET' ? mockSkillFile(url.pathname, url.search) : null;
        if (skillFile) {
          response.setHeader('Content-Type', skillFile.mediaType);
          response.end(Buffer.from(skillFile.bytes));
          return;
        }
        const answer = mockResponse(request.method ?? 'GET', url.pathname, await readBody(request), url.search, String(request.headers['content-type'] ?? ''));
        if (delay > 0) await new Promise((settle) => setTimeout(settle, delay));
        response.statusCode = answer.status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(answer.body));
      })();
    });
  },
});

export default defineConfig({
  plugins: [react(), ...t3chat(), mockApi()],
  server: { port: 5199 },
});
