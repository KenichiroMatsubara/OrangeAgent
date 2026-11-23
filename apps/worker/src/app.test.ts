import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { createTestApp, type TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { streamed } from '../test/claude';
import {
  seedAttendanceRegistration,
  seedAutomationException,
  seedContact,
  seedDeliveryRecord,
  seedAccountContact,
  seedScheduledEvent,
  skillDocument,
} from '../test/seed';

let fixture: TestApp | undefined;

const backgroundExecution = () => {
  const tasks: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil: (task: Promise<unknown>) => { tasks.push(task); },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    settle: async (): Promise<void> => { await Promise.all(tasks); },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

describe('Account access', () => {
  it('returns Automation Inbox behavior from the selected Account', async () => {
    fixture = createTestApp();

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', displayName: 'Owner', status: 'active' },
    });
  });

  it('never falls back to another database when an Account binding is unavailable', async () => {
    fixture = createTestApp();
    delete (fixture.environment as unknown as Record<string, unknown>).ORG_ORGANIZATION1;

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/connections'),
      fixture.environment,
    );

    expect(response.status).toBe(503);
  });

  it('keeps management data isolated between two Accounts', async () => {
    fixture = createTestApp();
    fixture.addAccount({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2' });
    const created = await app.fetch(fixture.fileRequest(
      '/api/organizations/organization-2/skills',
      skillDocument({ name: 'account-two-skill', instructions: 'Act.' }), 'POST', 'text/markdown',
    ), fixture.environment);

    const first = await app.fetch(
      fixture.request('/api/organizations/organization-1/skills'),
      fixture.environment,
    );
    const second = await app.fetch(
      fixture.request('/api/organizations/organization-2/skills'),
      fixture.environment,
    );

    expect(created.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ data: [] });
    await expect(second.json()).resolves.toMatchObject({
      data: [{ name: 'account-two-skill' }],
    });
  });

  it('lets the one Account of an Account read outcomes and make management changes', async () => {
    fixture = createTestApp();

    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    const listChange = await app.fetch(fixture.fileRequest(
      '/api/organizations/organization-1/skills',
      skillDocument({ name: 'allowed', instructions: 'Act.' }), 'POST', 'text/markdown',
    ), fixture.environment);
    const contactChange = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Allowed', email: 'allowed@example.com' },
    ), fixture.environment);

    expect(dashboard.status).toBe(200);
    expect(listChange.status).toBe(201);
    expect(contactChange.status).toBe(201);
  });
});

describe('Account connections', () => {
  it('stores a LINE Connection without requiring an AI Connection', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/line',
      {
        channelAccessToken: 'line-token',
        channelSecret: 'line-secret',
      },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        channelAccessTokenConfigured: true,
        channelSecretConfigured: true,
        webhookUrl: 'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      },
    });

    const connections = await app.fetch(fixture.request(
      '/api/organizations/organization-1/connections',
    ), fixture.environment);
    await expect(connections.json()).resolves.toMatchObject({
      data: {
        line: {
          channelAccessTokenConfigured: true,
          channelSecretConfigured: true,
          webhookUrl: 'https://app.example.com/api/public/organizations/organization-1/line/webhook',
        },
        ai: { apiKeyConfigured: false },
      },
    });
  });
});

describe('AI connection', () => {
  it('saves a provider and its key, calls it at the provider’s own Base URL, and never takes one typed', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai',
      { provider: 'openrouter', model: 'openai/gpt-5.5', apiKey: 'or-key', baseUrl: 'https://gateway.example.com/v1' },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    const view = (await saved.json() as { data: Record<string, unknown> }).data;
    expect(view).toEqual({ apiKeyConfigured: true, model: 'openai/gpt-5.5', models: ['openai/gpt-5.5'], provider: 'openrouter' });

    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'openai/gpt-5.5', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/models')
      ? Response.json({ data: [] })
      : new Response(`${chunk({ role: 'assistant', content: '接続成功' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const tested = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai/test', { prompt: '接続を確認' }), fixture.environment);

    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ data: { text: '接続成功', model: 'openai/gpt-5.5' } });
    const [, sent] = fetchMock.mock.calls.find(([url]) => String(url) === 'https://openrouter.ai/api/v1/chat/completions') as unknown as [string, RequestInit];
    expect(new Headers(sent.headers).get('Authorization')).toBe('Bearer or-key');
  });

  it('refuses a provider that is not one of the four, and moving to another provider without its key', async () => {
    fixture = await createAutomationTestApp();
    const put = (body: Record<string, unknown>) => app.fetch(fixture!.jsonRequest('/api/organizations/organization-1/connections/ai', body, 'PUT'), fixture!.environment);

    expect((await put({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k' })).status).toBe(400);
    expect((await put({ model: 'gpt-5.5', apiKey: 'k' })).status).toBe(400);
    expect((await put({ provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-openai' })).status).toBe(200);
    // The key saved is OpenAI's, so Gemini needs its own.
    expect((await put({ provider: 'gemini', model: 'gemini-3-flash' })).status).toBe(400);
    const moved = await put({ provider: 'gemini', model: 'gemini-3-flash', apiKey: 'gemini-key' });
    expect(moved.status).toBe(200);
    // The models OpenAI's API named are not Gemini's.
    await expect(moved.json()).resolves.toMatchObject({ data: { provider: 'gemini', models: ['gemini-3-flash'] } });
  });

  it('calls the Anthropic Messages API through Pi for a Connection on Anthropic', async () => {
    fixture = await createAutomationTestApp();
    const saved = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai',
      { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test' },
      'PUT',
    ), fixture.environment);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', provider: 'anthropic' },
    });

    const fetchMock = vi.fn(async (url: string) => new URL(url).pathname.startsWith('/v1/models/')
      ? new Response(JSON.stringify({ id: 'claude-sonnet-5-5', type: 'model', max_tokens: 128_000 }), { headers: { 'Content-Type': 'application/json' } })
      : streamed({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: '接続成功' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const tested = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai/test',
      { prompt: '接続を確認' },
    ), fixture.environment);

    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ data: { text: '接続成功', model: 'claude-sonnet-5-5' } });
    const [url, init] = fetchMock.mock.calls.find(([called]) => new URL(String(called)).pathname === '/v1/messages') as unknown as [string, RequestInit];
    expect(url.split('?')[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init.headers).get('x-api-key')).toBe('sk-ant-test');
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: Array<{ text?: string }> }> };
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '接続を確認' }] });
  });

  it('reports an Anthropic error from the connection test', async () => {
    fixture = await createAutomationTestApp();
    await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai',
      { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-wrong' },
      'PUT',
    ), fixture.environment);
    // A response per request: the model is looked up before the message is sent, and a body is read once.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    const tested = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/connections/ai/test',
      { prompt: '接続を確認' },
    ), fixture.environment);

    expect(tested.status).toBe(503);
    expect(JSON.stringify(await tested.json())).toContain('invalid x-api-key');
  });

});

describe('Account management', () => {
  it('serves no Task of its own: the Account’s Tasks are in Google Tasks, and the routes that kept and completed them are gone', async () => {
    fixture = createTestApp();

    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/tasks'), fixture.environment);
    const added = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/tasks', { title: '会場を予約する', deadline: '2026-08-20' }), fixture.environment);
    const changed = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/tasks/task-1', { status: 'completed' }, 'PATCH'), fixture.environment);
    // A Task Link opened for whoever held it, signed in or not; now it is no route at all.
    const link = await app.fetch(fixture.request(`/api/task-links/organization-1/${'a'.repeat(48)}`), fixture.environment);
    const heldByAnyone = await app.fetch(new Request(`https://app.example.com/api/task-links/organization-1/${'a'.repeat(48)}`), fixture.environment);
    const completion = await app.fetch(fixture.jsonRequest(`/api/task-links/organization-1/${'a'.repeat(48)}/completion`, { remarks: '済み' }), fixture.environment);

    expect([listed.status, added.status, changed.status, link.status, completion.status]).toEqual([410, 410, 410, 410, 410]);
    expect(heldByAnyone.status).toBe(401);
    expect(fixture.account.rows('SELECT id FROM tasks')).toEqual([]);
  });

  it('makes a Skill from its SKILL.md, renames it by writing its SKILL.md, lists it, and deletes it', async () => {
    fixture = createTestApp();
    const skills = '/api/organizations/organization-1/skills';
    const created = await app.fetch(fixture.fileRequest(skills, skillDocument({ name: 'event-analyst', description: 'When a mail announces an event.', instructions: 'Read the Source Message.' }), 'POST', 'text/markdown'), fixture.environment);
    const { data: { id } } = await created.json() as { data: { id: string } };
    const described = await app.fetch(fixture.fileRequest(`${skills}/${id}/file?path=SKILL.md`, skillDocument({ name: 'event-analyst', description: 'When a mail announces or changes an event.', instructions: 'Read the Source Message.' }), 'PUT', 'text/markdown'), fixture.environment);
    const unnamed = await app.fetch(fixture.fileRequest(`${skills}/${id}/file?path=SKILL.md`, 'No front matter.', 'PUT', 'text/markdown'), fixture.environment);
    const listed = await app.fetch(fixture.request(skills), fixture.environment);
    const document = await app.fetch(fixture.request(`${skills}/${id}/file?path=SKILL.md`), fixture.environment);
    const removed = await app.fetch(fixture.request(`${skills}/${id}`, { method: 'DELETE' }), fixture.environment);
    const afterRemoval = await app.fetch(fixture.request(skills), fixture.environment);

    expect([created.status, described.status, unnamed.status, document.status, removed.status]).toEqual([201, 200, 400, 200, 200]);
    await expect(listed.json()).resolves.toMatchObject({ data: [{
      id, name: 'event-analyst', description: 'When a mail announces or changes an event.', files: [{ path: 'SKILL.md', mediaType: 'text/markdown' }],
    }] });
    expect(document.headers.get('Content-Type')).toBe('text/markdown');
    expect(document.headers.get('Content-Disposition')).toMatch(/^attachment;/u);
    await expect(document.text()).resolves.toContain('When a mail announces or changes an event.');
    await expect(afterRemoval.json()).resolves.toEqual({ data: [] });
    expect(fixture.r2.keys()).toEqual([]);
  });

  it('writes, moves, and deletes a Skill’s files one at a time, as their bytes, in the one directory', async () => {
    fixture = createTestApp();
    const skills = '/api/organizations/organization-1/skills';
    const logo = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const created = await app.fetch(fixture.fileRequest(skills, skillDocument({ name: 'weekly-report', title: '週報', description: '週の終わり。', instructions: 'Write it as examples/report.md shows.' }), 'POST', 'text/markdown'), fixture.environment);
    const { data: { id } } = await created.json() as { data: { id: string } };
    const file = (path: string, body: string | Uint8Array, mediaType?: string) => app.fetch(fixture!.fileRequest(`${skills}/${id}/file?path=${encodeURIComponent(path)}`, body, 'PUT', mediaType), fixture!.environment);
    const move = (from: string, to: string) => app.fetch(fixture!.jsonRequest(`${skills}/${id}/move`, { from, to }), fixture!.environment);
    const remove = (path: string) => app.fetch(fixture!.request(`${skills}/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }), fixture!.environment);

    const report = await file('examples/report.md', '今週は…', 'text/markdown');
    const image = await file('logo.png', logo, 'image/png');
    const rewritten = await file('examples/report.md', '今週は例会が…', 'text/markdown');
    const moved = await move('examples', 'samples');
    const outside = await file('../secret.md', 'x');
    const documentGone = await remove('SKILL.md');
    const logoGone = await remove('logo.png');
    const read = await app.fetch(fixture.request(`${skills}/${id}/file?path=samples/report.md`), fixture.environment);

    expect([report.status, image.status, rewritten.status, moved.status, outside.status, documentGone.status, logoGone.status]).toEqual([200, 200, 200, 200, 400, 400, 200]);
    await expect(image.json()).resolves.toMatchObject({ data: { files: [{ path: 'SKILL.md' }, { path: 'examples/report.md' }, { path: 'logo.png', size: 6, mediaType: 'image/png' }] } });
    await expect(logoGone.json()).resolves.toMatchObject({ data: { files: [{ path: 'SKILL.md' }, { path: 'samples/report.md', size: new TextEncoder().encode('今週は例会が…').byteLength }] } });
    await expect(read.text()).resolves.toBe('今週は例会が…');
    // The Skill is its directory, named as the Skill is (Agent Skills).
    expect(fixture.account.rows('SELECT name, title, directory FROM skills')).toEqual([{ name: 'weekly-report', title: '週報', directory: 'weekly-report' }]);
    expect(fixture.r2.keys().sort()).toEqual(['skills/organization-1/weekly-report/SKILL.md', 'skills/organization-1/weekly-report/samples/report.md']);
  });

  it('shows the guests of an upcoming Scheduled Event and leaves a finished one out', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, {
      id: 'event-upcoming', title: '例会', startsAt: '2999-08-03T19:00:00+09:00', endsAt: '2999-08-03T21:00:00+09:00',
    });
    seedScheduledEvent(fixture.account, {
      id: 'event-past', title: '前回の例会', startsAt: '2020-08-03T19:00:00+09:00', endsAt: '2020-08-03T21:00:00+09:00',
    });
    fixture.account.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('response-1', 'gmail-1', 'history-1', 'chair@example.com', 'Re: 例会', '2026-08-01', 'processed')",
    );
    const guest = (id: string, eventId: string, name: string, affiliation: string, attending: number): void =>
      fixture!.account.execute(
        'INSERT INTO guest_registrations (id, event_id, source_message_id, name, affiliation, attending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, eventId, 'response-1', name, affiliation, attending, '2026-08-01',
      );
    guest('guest-1', 'event-upcoming', '山田太郎', '北クラブ', 1);
    guest('guest-2', 'event-upcoming', '鈴木花子', '北クラブ', 1);
    guest('guest-3', 'event-upcoming', '佐藤一郎', '南クラブ', 0);
    guest('guest-4', 'event-past', '過去太郎', '北クラブ', 1);

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/guest-registrations'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{
        eventId: 'event-upcoming',
        title: '例会',
        startsAt: '2999-08-03T19:00:00+09:00',
        attendingCount: 2,
        affiliations: [{ affiliation: '北クラブ', attending: 2 }],
        guests: [
          { name: '佐藤一郎', affiliation: '南クラブ', attending: false },
          { name: '山田太郎', affiliation: '北クラブ', attending: true },
          { name: '鈴木花子', affiliation: '北クラブ', attending: true },
        ],
      }],
    });
  });

  it('creates, changes, imports, reads, and snapshots Contacts', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1' });
    const created = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const body = await created.json() as { data: { id: string } };
    const updated = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${body.data.id}`,
      { tags: ['vip'], state: 'active' },
      'PATCH',
    ), fixture.environment);
    const imported = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members/import',
      { csv: 'name,email,description,tags\nSecond,second@example.com,会計,"役員;2026"\nAgain,GUEST@example.com,,\nInvalid,not-an-email,,' },
    ), fixture.environment);
    const snapshotted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1/recipient-snapshots',
      { contactIds: [body.data.id] },
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect([created.status, updated.status, imported.status, snapshotted.status]).toEqual([201, 200, 201, 201]);
    await expect(snapshotted.json()).resolves.toMatchObject({ data: { snapshotted: 1 } });
    await expect(imported.json()).resolves.toMatchObject({ data: {
      imported: 1,
      skipped: [{ line: 3, name: 'Again', reason: 'このメールアドレスは既に「Guest」に登録されています。' }],
      invalid: [{ line: 4, text: 'Invalid,not-an-email,,' }],
    } });
    await expect(listed.json()).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'Guest', email: 'guest@example.com', tags: ['vip'] }),
        expect.objectContaining({ name: 'Second', email: 'second@example.com', description: '会計', tags: ['役員', '2026'] }),
      ]),
    });
  });

  it('registers a Contact from a name alone, and a second one the same way, with no LINE handle and no email', async () => {
    fixture = createTestApp();
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '佐藤 次郎' },
    ), fixture.environment);
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '鈴木 花子', description: '会計', tags: ['2026年度'] },
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect([first.status, second.status]).toEqual([201, 201]);
    await expect(first.json()).resolves.toMatchObject({ data: { name: '佐藤 次郎', email: '', state: 'active', lineDestinations: [] } });
    await expect(listed.json()).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ name: '佐藤 次郎', email: '', lineDestinations: [] }),
        expect.objectContaining({ name: '鈴木 花子', email: '', description: '会計', tags: ['2026年度'], lineDestinations: [] }),
      ]),
    });
  });

  it('refuses an email address another Contact already holds, on creation and on edit, and says whose it is', async () => {
    fixture = createTestApp();
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '西田 悠人', email: 'yuto@example.com' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string } };
    const duplicate = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '別の人', email: 'Yuto@Example.com' },
    ), fixture.environment);
    const third = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '三人目' },
    ), fixture.environment);
    const thirdBody = await third.json() as { data: { id: string } };
    const edited = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${thirdBody.data.id}`,
      { email: 'yuto@example.com' },
      'PATCH',
    ), fixture.environment);
    const unchanged = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}`,
      { email: 'yuto@example.com', name: '西田 悠人' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    expect([first.status, duplicate.status, third.status, edited.status, unchanged.status]).toEqual([201, 409, 201, 409, 200]);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: 'conflict', message: expect.stringContaining('西田 悠人') as unknown as string } });
    await expect(edited.json()).resolves.toMatchObject({ error: { code: 'conflict' } });
    const roster = (await listed.json() as { data: Array<{ name: string }> }).data;
    expect(roster.map((contact) => contact.name).sort()).toEqual(['三人目', '西田 悠人']);
  });

  it('removes a Contact, returns its LINE handle to the pool, and leaves a Task still waiting to move to Google Tasks holding its name', async () => {
    fixture = createTestApp();
    seedContact(fixture.account, { id: 'contact-1', name: '西田 悠人', email: 'yuto@example.com', lineDestinationId: 'U4776' });
    seedScheduledEvent(fixture.account, { id: 'event-1' });
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
    );
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
         assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '振り込む', '2026-08-20', 'contact-1', '西田 悠人', '振込する', 0, '2026-08-01', '2026-08-01')`,
    );
    const snapshotted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1/recipient-snapshots',
      { contactIds: ['contact-1'] },
    ), fixture.environment);

    const removed = await app.fetch(fixture.request('/api/organizations/organization-1/members/contact-1', { method: 'DELETE' }), fixture.environment);
    const again = await app.fetch(fixture.request('/api/organizations/organization-1/members/contact-1', { method: 'DELETE' }), fixture.environment);
    const handles = await app.fetch(fixture.request('/api/organizations/organization-1/line-destinations'), fixture.environment);
    const reused = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '西田 悠人', email: 'yuto@example.com' },
    ), fixture.environment);
    const roster = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    expect([snapshotted.status, removed.status, again.status, reused.status]).toEqual([201, 200, 404, 201]);
    await expect(removed.json()).resolves.toEqual({ data: { id: 'contact-1', removed: true } });
    await expect(roster.json()).resolves.toMatchObject({ data: [expect.objectContaining({ name: '西田 悠人', email: 'yuto@example.com' })] });
    await expect(handles.json()).resolves.toMatchObject({ data: [expect.objectContaining({ destinationId: 'U4776', contactId: null })] });
    // The name is what the Task's copy in Google Tasks says it was given to.
    expect(fixture.account.rows('SELECT assignee_name, google_task_id FROM tasks')).toEqual([{ assignee_name: '西田 悠人', google_task_id: null }]);
  });

  it('removes a hand-entered LINE handle together with the Contact that held it', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const contact = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '手動 太郎' },
    ), fixture.environment);
    const contactId = (await contact.json() as { data: { id: string } }).data.id;
    const attached = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${contactId}/line-destination`,
      { destinationId: 'Umanual00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    const removed = await app.fetch(fixture.request(`/api/organizations/organization-1/members/${contactId}`, { method: 'DELETE' }), fixture.environment);
    const handles = await app.fetch(fixture.request('/api/organizations/organization-1/line-destinations'), fixture.environment);

    expect([attached.status, removed.status]).toEqual([201, 200]);
    await expect(handles.json()).resolves.toEqual({ data: [] });
  });

  it('creates multiple Contacts without email and allows email to be edited later', async () => {
    fixture = createTestApp();
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'メール未設定 一郎' },
    ), fixture.environment);
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'メール未設定 二郎' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string; email: string } };
    const setEmail = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}`,
      { email: 'later@example.com' },
      'PATCH',
    ), fixture.environment);
    const clearEmail = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}`,
      { email: '' },
      'PATCH',
    ), fixture.environment);
    const listed = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect([first.status, second.status, setEmail.status, clearEmail.status]).toEqual([201, 201, 200, 200]);
    expect(firstBody.data.email).toBe('');
    await expect(listed.json()).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ name: 'メール未設定 一郎', email: '' }),
        expect.objectContaining({ name: 'メール未設定 二郎', email: '' }),
      ]),
    });
  });

  it('reports what needs the Account on Home from durable Account behavior', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1' });
    seedAutomationException(fixture.account, { id: 'exception-1' });

    const response = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );

    const body = await response.json() as { data: { attention: Array<{ kind: string; count: number }>; upcomingEvents: Array<{ id: string }> } };
    expect(body.data.attention).toContainEqual(expect.objectContaining({ kind: 'exception', count: 1 }));
    expect(body.data.upcomingEvents.map((event) => event.id)).toEqual(['event-1']);
  });
});

describe('Control-plane administration', () => {
  it('records one Owner recovery request per idempotency key', async () => {
    fixture = createTestApp();

    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recovery-requests',
      { idempotencyKey: 'receipt-1' },
    ), fixture.environment);
    const duplicate = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/recovery-requests',
      { idempotencyKey: 'receipt-1' },
    ), fixture.environment);

    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      data: { accountId: 'organization-1', idempotencyKey: 'receipt-1', state: 'requested' },
    });
    expect(duplicate.status).toBe(409);
  });

  const suspend = async (request: Request): Promise<Response> => app.fetch(request, (fixture as TestApp).environment);
  const accountStatus = (): string | undefined =>
    fixture?.control.row<{ status: string }>("SELECT status FROM organizations WHERE id = 'organization-1'")?.status;

  it('lets the Account’s owner suspend it, which closes its routes, and resume it while it is suspended', async () => {
    fixture = createTestApp();

    const suspended = await suspend(fixture.jsonRequest('/api/organizations/organization-1/suspension', { suspended: true }, 'PATCH'));
    const statusWhileSuspended = accountStatus();
    const closed = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);
    const resumed = await suspend(fixture.jsonRequest('/api/organizations/organization-1/suspension', { suspended: false }, 'PATCH'));
    const open = await app.fetch(fixture.request('/api/organizations/organization-1/members'), fixture.environment);

    expect(suspended.status).toBe(200);
    await expect(suspended.json()).resolves.toEqual({ data: { accountId: 'organization-1', status: 'suspended' } });
    expect(statusWhileSuspended).toBe('suspended');
    expect(closed.status).toBe(403);
    await expect(closed.json()).resolves.toMatchObject({ error: { code: 'account_unavailable' } });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toEqual({ data: { accountId: 'organization-1', status: 'active' } });
    expect(accountStatus()).toBe('active');
    expect(open.status).toBe(200);
  });

  it('refuses to suspend an Account for someone who does not own it, or for nobody, and refuses a request without a state', async () => {
    fixture = createTestApp();
    fixture.addAccount({ id: 'organization-2', bindingName: 'ORG_ORGANIZATION2' });
    seedAccountContact(fixture.control, { accountId: 'organization-2', identityId: 'identity-2', email: 'second@example.com', sessionId: 'session-2' });
    const body = JSON.stringify({ suspended: true });
    const path = 'https://app.example.com/api/organizations/organization-1/suspension';

    const stranger = await suspend(new Request(path, { method: 'PATCH', headers: { Cookie: 'mail_session=session-2', 'Content-Type': 'application/json' }, body }));
    const signedOut = await suspend(new Request(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }));
    const stateless = await suspend(fixture.jsonRequest('/api/organizations/organization-1/suspension', { suspended: 'yes' }, 'PATCH'));

    expect(stranger.status).toBe(403);
    await expect(stranger.json()).resolves.toMatchObject({ error: { code: 'no_access' } });
    expect(signedOut.status).toBe(401);
    expect(stateless.status).toBe(400);
    expect(accountStatus()).toBe('active');
  });
});

describe('Operational outcomes', () => {
  it('exposes Event changes, Delivery Records, and Exception transitions through operations interfaces', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1', status: 'draft' });
    seedDeliveryRecord(fixture.account, {
      id: 'delivery-1',
      eventId: 'event-1',
      destination: 'guest@example.com',
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    seedDeliveryRecord(fixture.account, {
      id: 'delivery-line',
      eventId: 'event-1',
      destination: 'Udelivery0000000000000000000000000',
      channel: 'line',
      createdAt: '2026-07-26T00:00:00.000Z',
    });
    seedAutomationException(fixture.account, { id: 'exception-1' });

    const event = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/events/event-1',
      { title: 'New title', status: 'scheduled', reason: 'Correction' },
      'PATCH',
    ), fixture.environment);
    const exception = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/operations/exceptions/exception-1',
      { action: 'resolve' },
      'PATCH',
    ), fixture.environment);
    const audit = await app.fetch(
      fixture.request('/api/organizations/organization-1/audit/deliveries'),
      fixture.environment,
    );
    const operations = await app.fetch(
      fixture.request('/api/organizations/organization-1/operations/exceptions'),
      fixture.environment,
    );
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );

    expect([event.status, exception.status, audit.status]).toEqual([200, 200, 200]);
    const auditBody = await audit.json();
    expect(auditBody).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ destination: 'guest@example.com', outcome: 'succeeded' }),
        expect.objectContaining({ destination: 'Udeli…', outcome: 'succeeded' }),
      ]),
    });
    expect(JSON.stringify(auditBody)).not.toContain('Udelivery0000000000000000000000000');
    await expect(operations.json()).resolves.toMatchObject({
      data: [{ id: 'exception-1', state: 'resolved' }],
    });
    const home = await dashboard.json() as { data: { attention: Array<{ kind: string }>; upcomingEvents: unknown[] } };
    expect(home.data.upcomingEvents).toHaveLength(1);
    expect(home.data.attention.map((condition) => condition.kind)).not.toContain('exception');
  });
});

describe('LINE destinations', () => {
  it('acknowledges a valid webhook without waiting for LINE profile lookup', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'U1234567890' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    let releaseProfile!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { releaseProfile = resolve; })));
    const background = backgroundExecution();
    const responsePromise = Promise.resolve(app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context));
    const outcome = await Promise.race([
      responsePromise.then(() => 'acknowledged'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    releaseProfile(new Response(JSON.stringify({ displayName: '山田 太郎' }), { status: 200 }));
    const response = await responsePromise;
    await background.settle();

    expect(outcome).toBe('acknowledged');
    expect(response.status).toBe(200);
  });

  it('captures a LINE display name and assigns the discovered ID to a Contact', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const profileFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      displayName: '山田 太郎',
    }), { status: 200 }));
    vi.stubGlobal('fetch', profileFetch);
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'U1234567890' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');

    const background = backgroundExecution();
    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{
      id: string;
      destinationId: string;
      source: string;
      contactId: string | null;
    }> };
    expect(destinationsBody.data[0]).toMatchObject({
      destinationId: 'U1234…',
      source: 'webhook',
      contactId: null,
    });
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      {
        name: '山田 太郎',
        email: 'taro@example.com',
        tags: ['ロータリー'],
        lineDestinationId: destinationsBody.data[0]?.id,
      },
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(webhook.status).toBe(200);
    expect(recipient.status).toBe(201);
    expect(profileFetch).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/profile/U1234567890',
      { headers: { Authorization: 'Bearer line-token' } },
    );
    await expect(roster.json()).resolves.toMatchObject({
      data: [{
        name: '山田 太郎',
        email: 'taro@example.com',
        tags: ['ロータリー'],
        lineDestinations: [{
          destinationId: 'U1234…',
          displayName: '山田 太郎',
          kind: 'user',
        }],
      }],
    });
  });

  it('verifies a webhook, discovers a destination, and consumes its Contact Link once', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'group', groupId: 'group-1' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    const background = backgroundExecution();
    const webhook = await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Guest', email: 'guest@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };
    const issued = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-links`,
      {},
    ), fixture.environment);
    const issuedBody = await issued.json() as { data: { token: string } };
    const linkPath = `/api/public/organizations/organization-1/line-links/${issuedBody.data.token}`;
    const consumed = await app.fetch(fixture.jsonRequest(linkPath, { destinationId: 'group-1' }), fixture.environment);
    const duplicate = await app.fetch(fixture.jsonRequest(linkPath, { destinationId: 'group-1' }), fixture.environment);

    await expect(webhook.json()).resolves.toMatchObject({ data: { discovered: 1 } });
    expect(recipient.status).toBe(201);
    expect(issued.status).toBe(201);
    await expect(consumed.json()).resolves.toMatchObject({
      data: { contactId: recipientBody.data.id, destinationId: 'group…' },
    });
    expect(duplicate.status).toBe(410);
  });

  it('lets an Owner manually attach, correct, and unlink a LINE ID without a webhook event', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '手動 太郎', email: 'manual@example.com' },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const attached = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Umanualtypo0000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const attachedBody = await attached.json() as { data: { id: string } };

    const corrected = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination`,
      { destinationId: 'Ucorrected0000000000000000000000', displayName: '手動 太郎' },
      'PUT',
    ), fixture.environment);
    const roster = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(attached.status).toBe(201);
    expect(corrected.status).toBe(201);
    await expect(roster.json()).resolves.toMatchObject({
      data: [{
        id: recipientBody.data.id,
        lineDestinations: [{
          destinationId: 'Ucorr…',
          displayName: '手動 太郎',
          kind: 'user',
          source: 'manual',
        }],
      }],
    });

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${attachedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    expect(unlinked.status).toBe(404);

    const correctedBody = await corrected.json() as { data: { id: string } };
    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${correctedBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/members'),
      fixture.environment,
    );

    expect(removed.status).toBe(200);
    await expect(afterRemoval.json()).resolves.toMatchObject({
      data: [{ id: recipientBody.data.id, lineDestinations: [] }],
    });
  });

  it('rejects a manually entered LINE ID that is already linked to a different member', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const first = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Contact One', email: 'one@example.com' },
    ), fixture.environment);
    const firstBody = await first.json() as { data: { id: string } };
    const second = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Contact Two', email: 'two@example.com' },
    ), fixture.environment);
    const secondBody = await second.json() as { data: { id: string } };
    await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${firstBody.data.id}/line-destination`,
      { destinationId: 'Ushared00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    const conflict = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${secondBody.data.id}/line-destination`,
      { destinationId: 'Ushared00000000000000000000000000' },
      'PUT',
    ), fixture.environment);

    expect(conflict.status).toBe(409);
  });

  it('keeps a webhook-discovered destination available for reassignment after it is unlinked', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const payload = JSON.stringify({ events: [{ source: { type: 'user', userId: 'Uwebhook0000000000000000000000000' } }] });
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('line-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload)),
    ).toString('base64');
    const background = backgroundExecution();
    await app.fetch(new Request(
      'https://app.example.com/api/public/organizations/organization-1/line/webhook',
      { method: 'POST', headers: { 'x-line-signature': signature }, body: payload },
    ), fixture.environment, background.context);
    await background.settle();
    const destinations = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );
    const destinationsBody = await destinations.json() as { data: Array<{ id: string }> };
    const recipient = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: 'Discovered', email: 'discovered@example.com', lineDestinationId: destinationsBody.data[0]?.id },
    ), fixture.environment);
    const recipientBody = await recipient.json() as { data: { id: string } };

    const unlinked = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/members/${recipientBody.data.id}/line-destination/${destinationsBody.data[0]?.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const stillDiscovered = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(unlinked.status).toBe(200);
    await expect(stillDiscovered.json()).resolves.toMatchObject({
      data: [{ id: destinationsBody.data[0]?.id, contactId: null, source: 'webhook' }],
    });
  });

  it('registers a bare LINE ID into the pending pool and lets it be removed before it is promoted', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });

    const registered = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upending00000000000000000000000000', displayName: '保留 太郎' },
      'POST',
    ), fixture.environment);
    const registeredBody = await registered.json() as { data: { id: string } };
    const pending = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(registered.status).toBe(201);
    await expect(pending.json()).resolves.toMatchObject({
      data: [{
        id: registeredBody.data.id,
        destinationId: 'Upend…',
        displayName: '保留 太郎',
        source: 'manual',
        status: 'discovered',
        contactId: null,
      }],
    });

    const removed = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/line-destinations/${registeredBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const afterRemoval = await app.fetch(
      fixture.request('/api/organizations/organization-1/line-destinations'),
      fixture.environment,
    );

    expect(removed.status).toBe(200);
    await expect(afterRemoval.json()).resolves.toMatchObject({ data: [] });
  });

  it('promotes a pending LINE contact to a full Contact and blocks removing a linked one', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const registered = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upromote0000000000000000000000000' },
      'POST',
    ), fixture.environment);
    const registeredBody = await registered.json() as { data: { id: string } };

    const promoted = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members',
      { name: '昇格 花子', lineDestinationId: registeredBody.data.id },
    ), fixture.environment);
    const blockedRemoval = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/line-destinations/${registeredBody.data.id}`,
      {},
      'DELETE',
    ), fixture.environment);
    const duplicateRegistration = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/line-destinations',
      { destinationId: 'Upromote0000000000000000000000000' },
      'POST',
    ), fixture.environment);

    expect(promoted.status).toBe(201);
    expect(blockedRemoval.status).toBe(409);
    expect(duplicateRegistration.status).toBe(409);
  });
});

