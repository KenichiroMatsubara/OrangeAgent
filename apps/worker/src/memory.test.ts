import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamedCompletion } from '../test/stream';
import type { Memory, MemoryDetail, MemoryList, MemorySearch } from '@mail/domain';

import { answerThread, openThreadRun } from './answer';
import { app } from './app';
import { addMemory, searchMemory } from './memory/answer';
import { findMemories } from './memory/search';
import { eraseMemory, listMemories, memoryDetail, reindexMemories, saveMemory, updateMemory, type MemoryStore } from './memory/store';
import { indexPendingMemories } from './memory/upkeep';
import { memoryVectorsOf } from './memory/vectors';
import { productionProviders } from './providers';
import { accountDatabase } from './storage/database';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { seedAccountRoute } from '../test/seed';
import { memoryBindings, type MemoryBindings } from '../test/memory';

const databases: TestD1Database[] = [];
let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
  fixture?.close();
  fixture = undefined;
});

/** One Account's Memory: its own D1, and the Vectorize namespace of `accountId` in `bindings`, or no index at all. */
const accountMemory = (bindings: MemoryBindings | null, accountId = 'organization-1'): { store: MemoryStore; database: TestD1Database } => {
  const database = createMigratedTestD1('organization');
  databases.push(database);
  const store: MemoryStore = { db: accountDatabase(database.binding), vectors: bindings ? memoryVectorsOf(bindings, accountId) : null, at: () => new Date('2026-11-04T01:00:00.000Z') };
  return { store, database };
};

const person = { kind: 'person', name: 'Owner' } as const;

describe('the Memory', () => {
  it('keeps what Operator Chat\'s AI keeps as its own, linked to no conversation', async () => {
    const { store, database } = accountMemory(null);

    const { memory } = await saveMemory(store, { content: '定例は木曜15時', author: { kind: 'chat' } });

    expect(memory.author).toEqual({ kind: 'chat', name: '', conversationId: null });
    expect(database.rows('SELECT author_kind, conversation_id, turn_id FROM memories')).toEqual([{ author_kind: 'chat', conversation_id: null, turn_id: null }]);
    expect(database.rows('SELECT source FROM memory_episodes')).toEqual([{ source: 'chat' }]);
    expect(database.rows('SELECT actor_kind FROM memory_changes')).toEqual([{ actor_kind: 'chat' }]);
    expect(database.rows('SELECT * FROM memory_uses')).toEqual([]);
  });

  it('keeps a memory in D1 first, on an Episode of its words, and indexes its meaning without its words', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);

    expect(await addMemory(store, '田中さんへの連絡は LINE で', person)).toMatch(/^Kept: 田中さんへの連絡は LINE で \(id [0-9a-f-]+\)$/u);

    const [memory] = await listMemories(store);
    expect(memory).toMatchObject({ content: '田中さんへの連絡は LINE で', author: { kind: 'person', name: 'Owner', conversationId: null }, status: 'active', kind: 'fact', provenance: 'member' });
    expect(database.rows('SELECT source, member_name, content, state FROM memory_episodes')).toEqual([{ source: 'person', member_name: 'Owner', content: '田中さんへの連絡は LINE で', state: 'committed' }]);
    expect(database.row('SELECT evidence_start, evidence_end, indexed_at FROM memories')).toEqual({ evidence_start: 0, evidence_end: 16, indexed_at: '2026-11-04T01:00:00.000Z' });
    expect(database.rows<{ term: string }>('SELECT term FROM memory_terms').map(({ term }) => term)).toEqual(expect.arrayContaining(['line', '田中', '連絡']));
    expect(database.rows('SELECT actor_kind, actor_name, action FROM memory_changes')).toEqual([{ actor_kind: 'member', actor_name: 'Owner', action: 'add' }]);
    expect(bindings.vectors.get('organization-1')?.get(memory?.id ?? '')?.metadata).toEqual({ kind: 'fact' });
  });

  it('does not keep the same words twice, however they are spaced or written', async () => {
    const { store } = accountMemory(memoryBindings());

    await addMemory(store, '会議は毎週月曜', person);
    expect(await addMemory(store, '  会議は 毎週月曜 ', { kind: 'cli', name: '田中' })).toMatch(/^Already kept, so not kept again: 会議は毎週月曜/u);
    expect(await addMemory(store, '会議は毎週ＭＯＮ', person)).toMatch(/^Kept/u);

    expect(await listMemories(store)).toHaveLength(2);
  });

  it('answers with each memory it is certain of, when and from whom it was kept and how it matched', async () => {
    const { store } = accountMemory(memoryBindings());
    await addMemory(store, '会議資料は A4 縦で作る', person);
    await addMemory(store, '田中さんへの連絡は LINE で送る', { kind: 'cli', name: '山田' });

    const answer = await searchMemory(store, '田中さんへの連絡方法');
    expect(answer).toMatch(/^Certain memories: 1\n1\. 田中さんへの連絡は LINE で送る\n {3}kept 2026-11-04 10:00 \(Asia\/Tokyo\); the CLI of 山田 kept it; matched by meaning 0\.\d\d, words 0\.\d\d; id /u);
  });

  it('says it holds no certain memory rather than return the nearest guess', async () => {
    const { store } = accountMemory(memoryBindings());
    await addMemory(store, '田中さんへの連絡は LINE で', person);

    expect(await searchMemory(store, 'まったく別の話')).toBe('No certain memory about this. Do not answer from a guess: say the Memory does not hold it, or ask.');
    expect(await findMemories(store, { query: 'まったく別の話' })).toEqual([]);
  });

  it('finds a memory by its words where its meaning cannot be read', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);
    bindings.failNextUpsert();

    await addMemory(store, '請求書は月末にまとめて送る', person);
    expect(database.row('SELECT indexed_at FROM memories')).toEqual({ indexed_at: null });

    const unbound: MemoryStore = { ...store, vectors: null };
    expect((await findMemories(unbound, { query: '請求書は月末' })).map(({ row, similarity }) => ({ content: row.content, similarity })))
      .toEqual([{ content: '請求書は月末にまとめて送る', similarity: null }]);
  });

  it('indexes, in the background, every active memory not yet indexed, and finds one before its keywords are built', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);
    // As migration 0050 leaves a memory kept before Episodes: no keywords, no vector.
    database.execute("INSERT INTO memory_episodes (id, source, content, content_hash, state, received_at) VALUES ('legacy-old', 'legacy', '例会は第2土曜', 'legacy:old', 'committed', '2026-11-01')");
    database.execute("INSERT INTO memories (id, content, author_kind, created_at, updated_at, episode_id, evidence_start, evidence_end) VALUES ('old', '例会は第2土曜', 'chat', '2026-11-01', '2026-11-01', 'legacy-old', 0, 7)");

    expect((await findMemories({ ...store, vectors: null }, { query: '例会は第2土曜' })).map(({ row }) => row.id)).toEqual(['old']);

    expect(await reindexMemories(store)).toEqual({ indexed: 1, remaining: false });
    expect(database.row('SELECT indexed_at FROM memories')).toEqual({ indexed_at: '2026-11-04T01:00:00.000Z' });
    expect(database.rows('SELECT term FROM memory_terms').length).toBeGreaterThan(0);
    expect(bindings.vectors.get('organization-1')?.get('old')?.metadata).toEqual({ kind: 'fact' });
    expect(await reindexMemories(store)).toEqual({ indexed: 0, remaining: false });
  });

  it('returns at most 10 memories', async () => {
    const { store } = accountMemory(memoryBindings());
    for (let index = 0; index < 12; index += 1) await addMemory(store, `会議は毎週月曜 ${index}`, person);

    expect(await findMemories(store, { query: '会議は毎週月曜' })).toHaveLength(10);
  });

  it('never finds a memory of another Account', async () => {
    const bindings = memoryBindings();
    await addMemory(accountMemory(bindings, 'organization-2').store, '田中さんへの連絡は LINE で', person);

    expect(await findMemories(accountMemory(bindings, 'organization-1').store, { query: '田中さんへの連絡は LINE で' })).toEqual([]);
  });

  it('finds only what D1 holds as active, whatever Vectorize still offers', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);
    await addMemory(store, '会議は毎週月曜', person);
    database.execute("UPDATE memories SET status = 'superseded'");

    expect(await findMemories(store, { query: '会議は毎週月曜' })).toEqual([]);
    database.execute('DELETE FROM memories');
    expect(await findMemories(store, { query: '会議は毎週月曜' })).toEqual([]);
  });

  it('corrects a memory with the member’s own words, keeping the words before in its history', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);
    const { memory } = await saveMemory(store, { content: '会議は毎週月曜', author: { kind: 'cli', name: '田中' } });

    expect(await updateMemory(store, { id: memory.id, content: '会議は毎週火曜', editor: 'Owner' })).toMatchObject({ content: '会議は毎週火曜', editedBy: 'Owner', provenance: 'member' });

    const detail = await memoryDetail(store, memory.id) as MemoryDetail;
    expect(detail.episode).toMatchObject({ source: 'person', memberName: 'Owner', content: '会議は毎週火曜', evidence: { start: 0, end: 7 } });
    expect(detail.changes.map(({ actor, action }) => `${actor.kind}:${actor.name}:${action}`)).toEqual(['cli:田中:add', 'member:Owner:correct']);
    expect((await findMemories(store, { query: '会議は毎週火曜' }))[0]?.row.id).toBe(memory.id);
    expect(await findMemories(store, { query: '毎週月曜' })).toEqual([]);
    expect(database.rows('SELECT content FROM memory_episodes ORDER BY received_at, content')).toHaveLength(2);
    expect(await updateMemory(store, { id: 'missing', content: '何か', editor: 'Owner' })).toBeNull();
  });

  it('erases a memory for good: its row, vector, and words, in every Episode it rested on and in its history', async () => {
    const bindings = memoryBindings();
    const { store, database } = accountMemory(bindings);
    const { memory } = await saveMemory(store, { content: '暗証番号は1234', author: person });
    await updateMemory(store, { id: memory.id, content: '暗証番号は5678', editor: 'Owner' });

    expect(await eraseMemory(store, { id: memory.id, actor: 'Owner' })).toBe(true);

    expect(await listMemories(store)).toEqual([]);
    expect(bindings.vectors.get('organization-1')?.size).toBe(0);
    expect(database.rows('SELECT content FROM memory_episodes ORDER BY content')).toEqual([{ content: '■■■■■■■■■' }, { content: '■■■■■■■■■' }]);
    expect(database.rows('SELECT action, detail FROM memory_changes ORDER BY id')).toEqual([
      { action: 'add', detail: null }, { action: 'correct', detail: null }, { action: 'erase', detail: null },
    ]);
    expect(JSON.stringify(database.rows('SELECT * FROM memory_changes'))).not.toMatch(/1234|5678/u);
    expect(await eraseMemory(store, { id: memory.id, actor: 'Owner' })).toBe(false);

    const again = await saveMemory(store, { content: '暗証番号は5678', author: person });
    expect(again.duplicate).toBe(false);
    expect((await memoryDetail(store, again.memory.id))?.episode?.content).toBe('暗証番号は5678');
  });
});

describe('the Memory’s background upkeep', () => {
  it('indexes each active Account’s pending memories, and goes on past an Account it cannot open', async () => {
    const bindings = memoryBindings();
    fixture = await createAutomationTestApp();
    Object.assign(fixture.environment, { AI: bindings.AI, MEMORY_INDEX: bindings.MEMORY_INDEX });
    seedAccountRoute(fixture.control, { id: 'organization-0', bindingName: 'ORG_UNBOUND', databaseId: 'database-0' });
    fixture.account.execute("INSERT INTO memories (id, content, author_kind, created_at, updated_at) VALUES ('old', '例会は第2土曜', 'chat', '2026-11-01', '2026-11-01')");
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await indexPendingMemories(fixture.environment)).toBe(1);

    expect(fixture.account.row<{ indexed_at: string | null }>('SELECT indexed_at FROM memories')?.indexed_at).not.toBeNull();
    expect(bindings.vectors.get('organization-1')?.has('old')).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('memory_upkeep_skipped'));
    logged.mockRestore();
  });
});

describe('the 記憶 screen', () => {
  const memoryPath = '/api/organizations/organization-1/memories';

  const withMemory = async (bindings: MemoryBindings): Promise<TestApp> => {
    const made = await createAutomationTestApp();
    Object.assign(made.environment, { AI: bindings.AI, MEMORY_INDEX: bindings.MEMORY_INDEX });
    return made;
  };

  it('adds, lists, searches, changes, and deletes memories as the member signed in', async () => {
    fixture = await withMemory(memoryBindings());

    const added = await app.fetch(fixture.jsonRequest(memoryPath, { content: '田中さんへの連絡は LINE で' }), fixture.environment);
    expect(added.status).toBe(201);
    const memory = (await added.json() as { data: Memory }).data;
    expect(memory.author).toEqual({ kind: 'person', name: 'Owner', conversationId: null });

    const listed = (await (await app.fetch(fixture.request(memoryPath), fixture.environment)).json() as { data: MemoryList }).data;
    expect(listed).toEqual({ memories: [memory] });

    const searched = (await (await app.fetch(fixture.jsonRequest(`${memoryPath}/search`, { query: '田中さんへの連絡は LINE で送る' }), fixture.environment)).json() as { data: MemorySearch }).data;
    expect(searched.hits[0]?.memory.id).toBe(memory.id);
    expect(searched.hits[0]?.similarity).toBeGreaterThan(0.5);
    expect(searched.hits[0]?.keywords).toBeGreaterThan(0.6);

    const detail = (await (await app.fetch(fixture.request(`${memoryPath}/${memory.id}`), fixture.environment)).json() as { data: MemoryDetail }).data;
    expect(detail).toMatchObject({ memory: { id: memory.id }, episode: { source: 'person', memberName: 'Owner', content: '田中さんへの連絡は LINE で' }, changes: [{ actor: { kind: 'member', name: 'Owner' }, action: 'add' }] });

    const changed = await app.fetch(fixture.jsonRequest(`${memoryPath}/${memory.id}`, { content: '田中さんへの連絡はメールで' }, 'PUT'), fixture.environment);
    expect((await changed.json() as { data: Memory }).data).toMatchObject({ content: '田中さんへの連絡はメールで', editedBy: 'Owner' });

    expect((await app.fetch(fixture.jsonRequest(`${memoryPath}/${memory.id}`, {}, 'DELETE'), fixture.environment)).status).toBe(200);
    expect((await app.fetch(fixture.jsonRequest(`${memoryPath}/${memory.id}`, {}, 'DELETE'), fixture.environment)).status).toBe(404);
    expect((await app.fetch(fixture.request(`${memoryPath}/${memory.id}`), fixture.environment)).status).toBe(404);
  });

  it('refuses an empty memory and an empty search', async () => {
    fixture = await withMemory(memoryBindings());

    expect((await app.fetch(fixture.jsonRequest(memoryPath, { content: ' ' }), fixture.environment)).status).toBe(400);
    expect((await app.fetch(fixture.jsonRequest(`${memoryPath}/search`, { query: '' }), fixture.environment)).status).toBe(400);
  });
});

describe('the Memory over the MCP Server and in Operator Chat', () => {
  const cli = (path: string, body: unknown, token?: string): Request => new Request(`https://app.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  const operatorToken = async (app_: TestApp): Promise<string> => {
    const shown = await app.fetch(app_.jsonRequest('/api/organizations/organization-1/login-codes', {}), app_.environment);
    const { code } = (await shown.json() as { data: { code: string } }).data;
    const exchanged = await app.fetch(cli('/api/public/organizations/organization-1/operator-tokens', { code }), app_.environment);
    return (await exchanged.json() as { data: { token: string } }).data.token;
  };

  const rpc = async (app_: TestApp, token: string, method: string, params?: Record<string, unknown>): Promise<{ result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }> =>
    (await app.fetch(cli('/api/public/organizations/organization-1/mcp', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, token), app_.environment)).json() as never;

  /** Answers one message of an Operator Chat conversation as its object does, with whatever the stubbed model says. */
  const answer = async (app_: TestApp, request: string): Promise<void> => {
    const database = app_.account.binding;
    const providers = productionProviders();
    const runId = await openThreadRun({ env: app_.environment, providers, database, accountId: 'organization-1' });
    const ended = await answerThread({
      env: app_.environment, providers, database,
      answer: {
        accountId: 'organization-1', threadId: 'thread-1', runId, request, model: '', history: [], files: [],
        signal: new AbortController().signal, mode: () => 'unrestricted', steer: async () => [],
      },
      sink: { event: () => undefined, file: () => undefined, notice: () => undefined, usage: () => undefined },
    });
    expect(ended).toEqual({ kind: 'completed' });
  };

  it('offers a member’s CLI memory.search and memory.add, and keeps what it keeps under the member’s name', async () => {
    const bindings = memoryBindings();
    fixture = await createAutomationTestApp();
    Object.assign(fixture.environment, { AI: bindings.AI, MEMORY_INDEX: bindings.MEMORY_INDEX });
    const token = await operatorToken(fixture);

    const listed = await rpc(fixture, token, 'tools/list');
    const tools = listed.result.tools?.filter(({ name }) => name.startsWith('memory.')) as Array<{ name: string; description: string; inputSchema: unknown }>;
    expect(tools.map(({ name }) => name)).toEqual(['memory.search', 'memory.add']);
    expect(listed.result.tools?.map(({ name }) => name)).not.toEqual(expect.arrayContaining(['searchMCPMemory']));
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { content: { type: 'string' } }, required: ['content'] });
    expect(tools[0]?.inputSchema).toMatchObject({ properties: { query: { type: 'string' } }, required: ['query'] });

    const saved = await rpc(fixture, token, 'tools/call', { name: 'memory.add', arguments: { content: '請求書は月末にまとめて送る' } });
    expect(saved.result).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringMatching(/^Kept: 請求書は月末にまとめて送る/u) }] });
    expect(fixture.account.rows('SELECT author_kind, author_name FROM memories')).toEqual([{ author_kind: 'cli', author_name: 'Owner' }]);
    expect(fixture.account.rows('SELECT source, member_name FROM memory_episodes')).toEqual([{ source: 'cli', member_name: 'Owner' }]);

    const found = await rpc(fixture, token, 'tools/call', { name: 'memory.search', arguments: { query: '請求書は月末に送る' } });
    expect(found.result.content?.[0]?.text).toMatch(/^Certain memories: 1\n1\. 請求書は月末にまとめて送る\n/u);
  });

  it('tells a member’s CLI what Operator Chat is told, keeping memories unasked among it', async () => {
    fixture = await createAutomationTestApp();
    const token = await operatorToken(fixture);
    const opened = await app.fetch(cli('/api/public/organizations/organization-1/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } }, token), fixture.environment);
    const { instructions } = (await opened.json() as { result: { instructions?: string } }).result;
    expect(instructions).toContain('keep it with memory.add at once');
    expect(instructions).toContain('search it with memory.search');

    expect((await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'ai-key', provider: 'openrouter', model: 'test-model' }, 'PUT'), fixture.environment)).status).toBe(200);
    let system = '';
    let asked = '';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: unknown }> };
      // OpenRouter's model list, read for the most the model reads, carries no messages.
      if (body.messages) {
        const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : '';
        system = text(body.messages.find((message) => message.role === 'system')?.content);
        asked = text(body.messages.at(-1)?.content);
      }
      return streamedCompletion({ model: 'test-model', choices: [{ message: { content: 'はい。' } }], usage: { total_tokens: 5 } });
    });
    await answer(fixture, 'こんにちは');

    // Operator Chat is told the same, with only what its own entrance has, its screen and where the time is told, before the Skills.
    const entrance = ['Markdown is rendered.', 'Run code with code.run', 'To turn a Word', 'Every file code.run writes', 'A file a tool handed you', 'Save a file to Google Drive', 'web.search reads'];
    expect(system.split('\n').filter((line) => !entrance.some((start) => line.startsWith(start))).join('\n')).toBe(instructions);
    // The time goes with the member's message, so the instructions stay the same from one message to the next,
    // and after the member's words, so the first words the model reads in it are theirs and it answers in their language.
    expect(asked).toMatch(/^こんにちは\n\n\[OrangeAgent: it is now .+ in Asia\/Tokyo\.\]$/u);
  });

  it('keeps what Operator Chat’s AI keeps as its own, naming no conversation', async () => {
    const bindings = memoryBindings();
    fixture = await createAutomationTestApp();
    Object.assign(fixture.environment, { AI: bindings.AI, MEMORY_INDEX: bindings.MEMORY_INDEX });
    expect((await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/connections/ai', { apiKey: 'ai-key', provider: 'openrouter', model: 'test-model' }, 'PUT'), fixture.environment)).status).toBe(200);
    const answers = [
      { content: '', toolCalls: [{ name: 'memory.add', arguments: JSON.stringify({ content: '朝のお知らせは7時に送る' }) }] },
      { content: '覚えました。' },
    ];
    let index = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      // OpenRouter's model list, read for the most the model reads, is no answer.
      if (String(url).endsWith('/models')) return Response.json({ data: [] });
      const reply = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return streamedCompletion({
        model: 'test-model',
        choices: [{ message: { content: reply?.content ?? '', tool_calls: (reply?.toolCalls ?? []).map((call, position) => ({ id: `call-${position}`, function: call })) } }],
        usage: { total_tokens: 5 },
      });
    });
    await answer(fixture, '朝のお知らせは7時に送るって覚えておいて');

    expect(fixture.account.rows('SELECT content, author_kind, conversation_id, turn_id FROM memories')).toEqual([
      { content: '朝のお知らせは7時に送る', author_kind: 'chat', conversation_id: null, turn_id: null },
    ]);
    expect(fixture.account.rows('SELECT * FROM memory_uses')).toEqual([]);
  });
});
