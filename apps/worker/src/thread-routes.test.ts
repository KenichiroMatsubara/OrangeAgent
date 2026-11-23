import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatCapabilities, ChatDrivePicker, ChatDriveSaved, ChatThread, ChatThreadDeleted, ChatThreadDispatch, ChatThreadModes } from '@mail/domain';

import { app, createApp } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { memoryProviders } from '../test/providers';

// Saving to and attaching from Drive reaches Google, so those routes are served on the in-memory Google.
const providers = memoryProviders();
const drive = createApp(providers);

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const base = '/api/organizations/organization-1/chat-threads';

const connectAi = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/ai',
    { apiKey: 'ai-key', provider: 'openrouter', model: 'test-model' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

/** A conversation's Durable Object, as the routes reach it: what each request named, and what it answers. */
const objects = (app_: TestApp, answer: (path: string) => Response = () => Response.json({ accepted: true })) => {
  const reached: Array<{ name: string; path: string; account: string | null; thread: string | null; body: unknown; member?: string }> = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        const path = new URL(url).pathname + new URL(url).search;
        const member = headers.get('X-FlareChat-Member');
        reached.push({
          name: id.name, path, account: headers.get('X-FlareChat-Account'), thread: headers.get('X-FlareChat-Thread'),
          body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null,
          ...(member ? { member } : {}),
        });
        return answer(path);
      },
    }),
  };
  Object.assign(app_.environment, { CHAT_THREADS: namespace });
  return reached;
};

const create = async (app_: TestApp): Promise<ChatThread> => {
  const response = await app.fetch(app_.request(base, { method: 'POST' }), app_.environment);
  expect(response.status).toBe(201);
  return (await response.json() as { data: ChatThread }).data;
};

describe('the Operator Chat routes', () => {
  it('creates a conversation with no title yet and lists conversations, the one changed last first', async () => {
    fixture = await createAutomationTestApp();
    const first = await create(fixture);
    const second = await create(fixture);
    fixture.account.execute("UPDATE chat_threads SET updated_at = '2026-11-21T09:00:00.000Z', title = '請求の確認' WHERE id = ?", first.id);

    const response = await app.fetch(fixture.request(base), fixture.environment);
    const listed = (await response.json() as { data: ChatThread[] }).data;

    expect(first.title).toBe('');
    expect(listed.map((thread) => [thread.id, thread.title])).toEqual([[first.id, '請求の確認'], [second.id, '']]);
  });

  it('sends a message to the conversation\'s own object, with the model the AI Connection answers with', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);

    const response = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/messages`, { text: '  今日の予定は？ ' }), fixture.environment);

    expect(response.status).toBe(200);
    expect((await response.json() as { data: ChatThreadDispatch }).data).toEqual({ threadId: thread.id, accepted: true });
    expect(reached).toEqual([{
      name: `organization-1:${thread.id}`, path: '/dispatch', account: 'organization-1', thread: thread.id,
      body: { request: '今日の予定は？', model: 'test-model', by: { identityId: 'identity-1', name: 'Owner' }, files: [], delivery: 'steer' },
    }]);
  });

  it('hands on the level of effort a message names, and refuses a value that names no level', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);

    const named = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/messages`, { text: 'よく考えて', effort: 'max' }), fixture.environment);
    const unknown = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/messages`, { text: 'よく考えて', effort: 'ultra' }), fixture.environment);

    expect(named.status).toBe(200);
    expect(unknown.status).toBe(400);
    expect(reached.map((entry) => entry.body)).toEqual([
      { request: 'よく考えて', model: 'test-model', effort: 'max', by: { identityId: 'identity-1', name: 'Owner' }, files: [], delivery: 'steer' },
    ]);
  });

  it('keeps each file a message carries as it is before handing the message on, and queues it when asked', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const form = new FormData();
    form.set('text', 'この写真の予定を入れて');
    form.set('delivery', 'queue');
    // A phone sends a photo from its camera roll under a name and type that may not say what it is.
    form.append('attachment', new File([png], 'IMG_0001.jpg', { type: 'image/jpeg' }));

    const response = await app.fetch(fixture.request(`${base}/${thread.id}/messages`, { method: 'POST', body: form }), fixture.environment);

    expect(response.status).toBe(200);
    const sent = reached[0]?.body as { files: Array<{ id: string; filename: string; mediaType: string; size: number; objectKey: string }>; delivery: string; request: string };
    expect(sent).toMatchObject({ request: 'この写真の予定を入れて', delivery: 'queue', files: [{ filename: 'IMG_0001.jpg', mediaType: 'image/png', size: 12 }] });
    const kept = await fixture.r2.bucket.get(sent.files[0]?.objectKey ?? '');
    expect(new Uint8Array(await kept?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(png);
  });

  it('refuses a file of no kind a message may carry, and keeps nothing of a message the object did not take', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture, () => Response.json({ accepted: false }));
    const thread = await create(fixture);
    const refused = new FormData();
    refused.append('attachment', new File([new Uint8Array([1, 2, 3])], 'run.exe', { type: 'application/octet-stream' }));
    const dropped = new FormData();
    dropped.append('attachment', new File([new TextEncoder().encode('メモ')], 'memo.txt', { type: 'text/plain' }));

    const bad = await app.fetch(fixture.request(`${base}/${thread.id}/messages`, { method: 'POST', body: refused }), fixture.environment);
    const notTaken = await app.fetch(fixture.request(`${base}/${thread.id}/messages`, { method: 'POST', body: dropped }), fixture.environment);

    expect(bad.status).toBe(400);
    expect((await notTaken.json() as { data: ChatThreadDispatch }).data.accepted).toBe(false);
    expect(reached).toHaveLength(1);
    const key = (reached[0]?.body as { files: Array<{ objectKey: string }> }).files[0]?.objectKey ?? '';
    expect(await fixture.r2.bucket.get(key)).toBeNull();
  });

  it('sends, removes, rewrites, and moves a queued message at the conversation\'s object, and refuses what it cannot read', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);
    const queue = (body: unknown) => app.fetch(fixture!.jsonRequest(`${base}/${thread.id}/queue`, body), fixture!.environment);

    const statuses = [
      (await queue({ action: 'send', runId: 'run-2' })).status,
      (await queue({ action: 'remove', runId: 'run-3' })).status,
      (await queue({ action: 'edit', runId: 'run-2', text: '  直した ' })).status,
      (await queue({ action: 'move', runId: 'run-3', beforeRunId: 'run-2' })).status,
      (await queue({ action: 'move', runId: 'run-3', beforeRunId: null })).status,
      (await queue({ action: 'edit', runId: 'run-2', text: '  ' })).status,
      (await queue({ action: 'shuffle', runId: 'run-2' })).status,
      (await queue({ action: 'send' })).status,
    ];

    expect(statuses).toEqual([200, 200, 200, 200, 200, 400, 400, 400]);
    // Whoever starts a queued message is among those its answer notifies.
    const by = { identityId: 'identity-1', name: 'Owner' };
    expect(reached.map((entry) => [entry.path, entry.body])).toEqual([
      ['/queue', { kind: 'steer', runId: 'run-2', by }],
      ['/queue', { kind: 'cancel', runId: 'run-3', by }],
      ['/queue', { kind: 'edit', runId: 'run-2', text: '直した', by }],
      ['/queue', { kind: 'move', runId: 'run-3', beforeRunId: 'run-2', by }],
      ['/queue', { kind: 'move', runId: 'run-3', beforeRunId: null, by }],
    ]);
  });

  it('answers a call waiting for approval at the conversation\'s object, with the member and what they said, and refuses an answer it cannot read', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);

    const answered = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/approvals`, { requestId: 'request-1', decision: 'decline', feedback: '  宛先が違います ' }), fixture.environment);
    const unknown = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/approvals`, { requestId: 'request-1', decision: 'maybe' }), fixture.environment);
    const nameless = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/approvals`, { decision: 'accept' }), fixture.environment);

    expect((await answered.json() as { data: ChatThreadDispatch }).data).toEqual({ threadId: thread.id, accepted: true });
    expect(unknown.status).toBe(400);
    expect(nameless.status).toBe(400);
    expect(reached).toEqual([{
      name: `organization-1:${thread.id}`, path: '/respond', account: 'organization-1', thread: thread.id,
      body: { requestId: 'request-1', decision: 'decline', feedback: '宛先が違います', by: { identityId: 'identity-1', name: 'Owner' } },
    }]);
  });

  it('sets a conversation\'s approval mode at its object, and refuses a mode it does not know', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);

    const set = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/mode`, { mode: 'read_only' }, 'PUT'), fixture.environment);
    const unknown = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/mode`, { mode: 'sometimes' }, 'PUT'), fixture.environment);

    expect(set.status).toBe(200);
    expect(unknown.status).toBe(400);
    expect(reached.map((entry) => [entry.path, entry.body])).toEqual([['/mode', { mode: 'read_only', by: { identityId: 'identity-1', name: 'Owner' } }]]);
    // A new conversation is given a mode to start in: unrestricted, when its member has no conversation before it.
    expect(fixture.account.rows('SELECT mode, changed_by_identity FROM chat_thread_modes WHERE thread_id = ?', thread.id)).toEqual([{ mode: 'unrestricted', changed_by_identity: null }]);
  });

  it('offers 自動 only where the Worker holds an OpenRouter key, and refuses to set it elsewhere', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);

    const without = await app.fetch(fixture.request(`${base}/${thread.id}/mode`), fixture.environment);
    const refused = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/mode`, { mode: 'auto' }, 'PUT'), fixture.environment);
    const missing = await app.fetch(fixture.request(`${base}/thread-of-no-one/mode`), fixture.environment);
    expect((await without.json() as { data: ChatThreadModes }).data).toEqual({ modes: ['read_only', 'ask', 'unrestricted'] });
    expect(refused.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(reached).toEqual([]);

    Object.assign(fixture.environment, { OPENROUTER_API_KEY: 'sk-or-test' });
    const withKey = await app.fetch(fixture.request(`${base}/${thread.id}/mode`), fixture.environment);
    const set = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/mode`, { mode: 'auto' }, 'PUT'), fixture.environment);
    expect((await withKey.json() as { data: ChatThreadModes }).data).toEqual({ modes: ['read_only', 'ask', 'auto', 'unrestricted'] });
    expect(set.status).toBe(200);
    expect(reached.map((entry) => entry.body)).toEqual([{ mode: 'auto', by: { identityId: 'identity-1', name: 'Owner' } }]);
  });

  it('refuses an empty message, a model the Connection does not name, and a conversation of no one', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);

    const empty = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/messages`, { text: '   ' }), fixture.environment);
    const model = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/messages`, { text: 'hi', model: 'unknown-model' }), fixture.environment);
    const missing = await app.fetch(fixture.jsonRequest(`${base}/missing/messages`, { text: 'hi' }), fixture.environment);

    expect(empty.status).toBe(400);
    expect(model.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(reached).toEqual([]);
  });

  it('stops an answer at the conversation\'s object', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture, () => Response.json({ accepted: false }));
    const thread = await create(fixture);

    const response = await app.fetch(fixture.request(`${base}/${thread.id}/interrupt`, { method: 'POST' }), fixture.environment);

    expect((await response.json() as { data: ChatThreadDispatch }).data).toEqual({ threadId: thread.id, accepted: false });
    expect(reached.map((entry) => entry.path)).toEqual(['/interrupt']);
  });

  it('opens the stream only as a WebSocket from this site, after the sequence the screen names', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture, () => new Response(null, { status: 200 }));
    const thread = await create(fixture);

    const plain = await app.fetch(fixture.request(`${base}/${thread.id}/stream`), fixture.environment);
    const foreign = await app.fetch(fixture.request(`${base}/${thread.id}/stream`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }), fixture.environment);
    await app.fetch(fixture.request(`${base}/${thread.id}/stream?afterSequence=12`, { headers: { Upgrade: 'websocket', Origin: 'https://app.example.com' } }), fixture.environment);

    expect(plain.status).toBe(400);
    expect(foreign.status).toBe(403);
    expect(reached.map((entry) => entry.path)).toEqual(['/connect?afterSequence=12']);
    // The socket is named as the member's, so their screen in view keeps them from being notified.
    expect(reached[0]?.member).toBe('identity-1');
  });

  it('serves a file an answer kept, and no file of another conversation', async () => {
    fixture = await createAutomationTestApp();
    const thread = await create(fixture);
    const other = await create(fixture);
    await fixture.r2.bucket.put('chat-files/organization-1/file-1', new TextEncoder().encode('png'), { httpMetadata: { contentType: 'image/png' } });
    fixture.account.execute(
      "INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at) VALUES ('file-1', ?, 'run-1', 'screen.png', 'image/png', 3, 'chat-files/organization-1/file-1', '2026-11-21T00:00:00.000Z')",
      thread.id,
    );

    const shown = await app.fetch(fixture.request(`${base}/${thread.id}/files/file-1`), fixture.environment);
    const elsewhere = await app.fetch(fixture.request(`${base}/${other.id}/files/file-1`), fixture.environment);

    expect(shown.status).toBe(200);
    expect(shown.headers.get('Content-Type')).toBe('image/png');
    expect(shown.headers.get('Content-Disposition')).toContain('inline');
    expect(await shown.text()).toBe('png');
    expect(elsewhere.status).toBe(404);
  });

  it('renames a conversation at its object, its place in the list unchanged, and refuses a name of nothing', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);

    const renamed = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}`, { title: '  請求の\n確認 ' }, 'PATCH'), fixture.environment);
    const blank = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}`, { title: '  ' }, 'PATCH'), fixture.environment);
    const missing = await app.fetch(fixture.jsonRequest(`${base}/missing`, { title: '名前' }, 'PATCH'), fixture.environment);

    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { data: ChatThread }).data.id).toBe(thread.id);
    expect(blank.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(reached.map((entry) => [entry.path, entry.body])).toEqual([['/rename', { title: '請求の 確認' }]]);
  });

  it('deletes a conversation once its object has stopped, and only the bytes nothing else names', async () => {
    fixture = await createAutomationTestApp();
    const reached = objects(fixture);
    const thread = await create(fixture);
    const forked = await create(fixture);
    const file = (id: string, threadId: string, key: string): void => {
      fixture?.account.execute(
        "INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at) VALUES (?, ?, 'run-1', 'a.png', 'image/png', 3, ?, '2026-11-21T00:00:00.000Z')",
        id, threadId, key,
      );
    };
    for (const key of ['own', 'shared', 'legacy', 'paused/state.json']) await fixture.r2.bucket.put(`chat-files/organization-1/${key}`, new TextEncoder().encode(key));
    file('file-own', thread.id, 'chat-files/organization-1/own');
    // A conversation continued from it names the same bytes, as one copied from the chat before ADR 0201 names that chat's.
    file('file-shared', thread.id, 'chat-files/organization-1/shared');
    file('file-shared-copy', forked.id, 'chat-files/organization-1/shared');
    file('file-legacy', thread.id, 'chat-files/organization-1/legacy');
    fixture.account.execute("INSERT INTO runs (id, trigger, execution_mode, status, started_at, updated_at) VALUES ('run-old', 'chat', 'unattended', 'completed', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
    fixture.account.execute("INSERT INTO chat_conversations (id, account_id, title, created_at, updated_at) VALUES ('old', 'organization-1', '', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
    fixture.account.execute("INSERT INTO chat_turns (id, conversation_id, run_id, position, request, status, created_at, updated_at) VALUES ('turn-old', 'old', 'run-old', 1, 'a', 'completed', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
    fixture.account.execute("INSERT INTO chat_attachments (id, turn_id, position, filename, media_type, size, object_key, origin, created_at) VALUES ('att-old', 'turn-old', 1, 'a.png', 'image/png', 3, 'chat-files/organization-1/legacy', 'request', '2026-11-01T00:00:00.000Z')");
    fixture.account.execute(
      "INSERT INTO chat_pauses (id, thread_id, run_id, call_id, tool, arguments, item_id, state_key, created_at) VALUES ('pause-1', ?, 'run-1', 'call-1', 'mail.send', '{}', 'item-1', 'chat-files/organization-1/paused', '2026-11-21T00:00:00.000Z')",
      thread.id,
    );
    fixture.account.execute("INSERT INTO chat_events (thread_id, sequence, type, payload, created_at) VALUES (?, 1, 'run.created', '{}', '2026-11-21T00:00:00.000Z')", thread.id);

    const deleted = await app.fetch(fixture.request(`${base}/${thread.id}`, { method: 'DELETE' }), fixture.environment);

    expect((await deleted.json() as { data: ChatThreadDeleted }).data).toEqual({ id: thread.id, deleted: true });
    expect(reached.map((entry) => entry.path)).toEqual(['/close']);
    for (const table of ['chat_threads', 'chat_events', 'chat_files', 'chat_pauses', 'chat_thread_modes']) {
      expect(fixture.account.rows(`SELECT * FROM ${table} WHERE ${table === 'chat_threads' ? 'id' : 'thread_id'} = ?`, thread.id)).toEqual([]);
    }
    expect(fixture.account.rows('SELECT id FROM chat_threads').map((row) => (row as { id: string }).id)).toEqual([forked.id]);
    const kept = async (key: string): Promise<boolean> => (await fixture!.r2.bucket.get(`chat-files/organization-1/${key}`)) !== null;
    expect(await kept('own')).toBe(false);
    expect(await kept('shared')).toBe(true);
    expect(await kept('legacy')).toBe(true);
    expect(await kept('paused/state.json')).toBe(false);
    // The Run an answer was recorded as stays.
    expect(fixture.account.rows("SELECT id FROM runs WHERE id = 'run-old'")).toHaveLength(1);
  });

  it('asks an earlier message again at the conversation\'s object, with the model the Connection answers with', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);

    const rewound = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/rewind`, { messageId: 'run-1:user', text: ' 直した ' }), fixture.environment);
    const nameless = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/rewind`, { text: '直した' }), fixture.environment);
    const model = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/rewind`, { messageId: 'run-1:user', text: 'a', model: 'unknown-model' }), fixture.environment);

    expect((await rewound.json() as { data: ChatThreadDispatch }).data).toEqual({ threadId: thread.id, accepted: true });
    expect(nameless.status).toBe(400);
    expect(model.status).toBe(400);
    expect(reached.map((entry) => [entry.path, entry.body])).toEqual([
      ['/rewind', { messageId: 'run-1:user', request: '直した', model: 'test-model', by: { identityId: 'identity-1', name: 'Owner' } }],
    ]);
  });

  it('asks an earlier message again with the files it keeps and the files added to it, each added file kept as it is first', async () => {
    fixture = await createAutomationTestApp();
    await connectAi(fixture);
    const reached = objects(fixture);
    const thread = await create(fixture);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const form = new FormData();
    form.set('messageId', 'run-1:user');
    form.set('text', 'こちらの写真で');
    form.append('drop', 'photo-old');
    form.append('attachment', new File([png], 'IMG_0002.png', { type: 'image/png' }));

    const response = await app.fetch(fixture.request(`${base}/${thread.id}/rewind`, { method: 'POST', body: form }), fixture.environment);

    expect(response.status).toBe(200);
    const sent = reached[0]?.body as { files: Array<{ objectKey: string }>; drop: string[] };
    expect(sent).toMatchObject({ messageId: 'run-1:user', request: 'こちらの写真で', drop: ['photo-old'], files: [{ filename: 'IMG_0002.png', mediaType: 'image/png', size: 12 }] });
    const kept = await fixture.r2.bucket.get(sent.files[0]?.objectKey ?? '');
    expect(new Uint8Array(await kept?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(png);
  });

  it('continues a conversation as a new one from what its object copies, each file naming the same bytes, in the mode a new one starts in', async () => {
    fixture = await createAutomationTestApp();
    const thread = await create(fixture);
    fixture.account.execute(
      "INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at, origin, position) VALUES ('photo', ?, 'run-1', 'a.png', 'image/png', 3, 'chat-files/organization-1/photo', '2026-11-21T00:00:00.000Z', 'request', 0)",
      thread.id,
    );
    fixture.account.execute("UPDATE chat_thread_modes SET mode = 'ask', changed_by_identity = 'identity-1', changed_at = '2026-11-21T09:00:00.000Z' WHERE thread_id = ?", thread.id);
    const events = [
      { sequence: 1, type: 'turn-item.updated', payload: '{"id":"1"}', createdAt: '2026-11-21T10:00:00.000Z' },
      { sequence: 2, type: 'run.created', payload: '{"id":"2"}', createdAt: '2026-11-21T10:00:00.000Z' },
    ];
    const reached = objects(fixture, (path) => path === '/fork'
      ? Response.json({ fork: { title: '週末の予定（続き）', events, files: [{ id: 'photo', copy: 'photo-copy' }] } })
      : Response.json({ accepted: true }));

    const response = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/fork`, { runId: 'run-1' }), fixture.environment);

    expect(response.status).toBe(201);
    const forked = (await response.json() as { data: ChatThread }).data;
    expect(forked).toMatchObject({ title: '週末の予定（続き）' });
    expect(reached.map((entry) => [entry.path, entry.body])).toEqual([['/fork', { runId: 'run-1', threadId: forked.id }]]);
    expect(fixture.account.rows('SELECT sequence, type, payload FROM chat_events WHERE thread_id = ? ORDER BY sequence', forked.id))
      .toEqual(events.map(({ sequence, type, payload }) => ({ sequence, type, payload })));
    expect(fixture.account.rows('SELECT last_sequence FROM chat_threads WHERE id = ?', forked.id)).toEqual([{ last_sequence: 2 }]);
    expect(fixture.account.rows('SELECT id, run_id, object_key, origin FROM chat_files WHERE thread_id = ?', forked.id))
      .toEqual([{ id: 'photo-copy', run_id: 'run-1', object_key: 'chat-files/organization-1/photo', origin: 'request' }]);
    expect(fixture.account.rows('SELECT mode FROM chat_thread_modes WHERE thread_id = ?', forked.id)).toEqual([{ mode: 'ask' }]);

    const refused = objects(fixture, () => Response.json({ fork: null }));
    const none = await app.fetch(fixture.jsonRequest(`${base}/${thread.id}/fork`, { runId: 'run-9' }), fixture.environment);
    expect(none.status).toBe(400);
    expect(refused).toHaveLength(1);
  });

  it('says which models a message may be answered by and whether Google Picker is configured', async () => {
    fixture = await createAutomationTestApp();
    const without = await app.fetch(fixture.request('/api/organizations/organization-1/chat-capabilities'), fixture.environment);
    expect((await without.json() as { data: ChatCapabilities }).data).toEqual({ models: [], efforts: {}, drivePicker: false });

    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'k', provider: 'openrouter', model: 'model-a', models: ['model-b'] }, 'PUT'), fixture.environment);
    Object.assign(fixture.environment, { GOOGLE_PICKER_API_KEY: 'picker-key', GOOGLE_PICKER_APP_ID: '1234567890' });
    const withAll = await app.fetch(fixture.request('/api/organizations/organization-1/chat-capabilities'), fixture.environment);
    expect((await withAll.json() as { data: ChatCapabilities }).data).toEqual({ models: ['model-a', 'model-b'], efforts: {}, drivePicker: true });
  });

  it('says which levels of effort each Claude model takes, as Pi\'s model catalog describes it', async () => {
    fixture = await createAutomationTestApp();
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'k', provider: 'anthropic', model: 'claude-opus-5-5', models: ['claude-haiku-4-5', 'claude-unknown-1'] }, 'PUT'), fixture.environment);

    const read = await app.fetch(fixture.request('/api/organizations/organization-1/chat-capabilities'), fixture.environment);

    // A model the catalog does not know offers no choice, and is left out.
    expect((await read.json() as { data: ChatCapabilities }).data).toEqual({
      models: ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-unknown-1'],
      efforts: {
        'claude-opus-5-5': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
        'claude-haiku-4-5': { levels: ['low', 'medium', 'high'], default: 'high' },
      },
      drivePicker: false,
    });
  });

  it('says which levels of effort each OpenAI model takes, by its family, as OpenAI\'s API does not say', async () => {
    fixture = await createAutomationTestApp();
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'k', provider: 'openai', model: 'gpt-5.5', models: ['o4-mini', 'gpt-4.1'] }, 'PUT'), fixture.environment);

    const read = await app.fetch(fixture.request('/api/organizations/organization-1/chat-capabilities'), fixture.environment);

    expect((await read.json() as { data: ChatCapabilities }).data.efforts).toEqual({
      'gpt-5.5': { levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'none' },
      'o4-mini': { levels: ['low', 'medium', 'high'], default: 'medium' },
    });
  });

  it('hands the screen a Picker token narrowed to drive.file, only where Picker is configured', async () => {
    fixture = await createAutomationTestApp();
    const none = await drive.fetch(fixture.request('/api/organizations/organization-1/chat-drive-picker', { method: 'POST' }), fixture.environment);
    expect((await none.json() as { data: ChatDrivePicker | null }).data).toBeNull();

    Object.assign(fixture.environment, { GOOGLE_PICKER_API_KEY: 'picker-key', GOOGLE_PICKER_APP_ID: '1234567890' });
    const picker = await drive.fetch(fixture.request('/api/organizations/organization-1/chat-drive-picker', { method: 'POST' }), fixture.environment);
    expect((await picker.json() as { data: ChatDrivePicker | null }).data).toMatchObject({ apiKey: 'picker-key', appId: '1234567890', accessToken: expect.any(String) });
  });

  it('saves a file of the conversation to the folder the member chose, or to AI に聞く', async () => {
    fixture = await createAutomationTestApp();
    const thread = await create(fixture);
    await fixture.r2.bucket.put('chat-files/organization-1/sheet', new TextEncoder().encode('xlsx'));
    fixture.account.execute(
      "INSERT INTO chat_files (id, thread_id, run_id, filename, media_type, size, object_key, created_at) VALUES ('sheet', ?, 'run-1', '予定.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 4, 'chat-files/organization-1/sheet', '2026-11-21T00:00:00.000Z')",
      thread.id,
    );
    const save = (body: unknown, fileId = 'sheet') => drive.fetch(fixture!.jsonRequest(`${base}/${thread.id}/files/${fileId}/drive`, body), fixture!.environment);

    const chosen = await save({ folderId: 'folder-chosen-123' });
    const default_ = await save({});
    const bad = await save({ folderId: 'no/such' });
    const missing = await save({}, 'nothing');

    expect((await chosen.json() as { data: ChatDriveSaved }).data).toMatchObject({ url: expect.stringContaining('drive.example') });
    expect(default_.status).toBe(200);
    expect(bad.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(providers.google.drive.files.slice(-2).map((file) => [file.filename, file.folderId])).toEqual([['予定.xlsx', 'folder-chosen-123'], ['予定.xlsx', 'folder:AI に聞く']]);
  });

  it('hands the composer a Drive file the member picked as the file itself, a Google document as its export', async () => {
    fixture = await createAutomationTestApp();
    providers.google.drive.held.push(
      { id: 'drive-pdf-0001', name: '議事録.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.7 minutes') },
      { id: 'drive-doc-0001', name: '案内', mimeType: 'application/vnd.google-apps.document', exports: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': new Uint8Array([0x50, 0x4b, 3, 4]) } },
      { id: 'drive-folder-01', name: '資料', mimeType: 'application/vnd.google-apps.folder' },
    );
    const read = (fileId: string) => drive.fetch(fixture!.request(`/api/organizations/organization-1/chat-drive-files/${fileId}`), fixture!.environment);

    const pdf = await read('drive-pdf-0001');
    const doc = await read('drive-doc-0001');
    const folder = await read('drive-folder-01');
    const odd = await read('no');

    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(await pdf.text()).toBe('%PDF-1.7 minutes');
    expect(doc.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(doc.headers.get('Content-Disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('案内.docx')}`);
    expect(folder.status).toBe(400);
    expect(odd.status).toBe(400);
  });
});
