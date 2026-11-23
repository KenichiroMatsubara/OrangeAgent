/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { THREAD_ACCOUNT_HEADER, THREAD_HEADER, THREAD_MEMBER_HEADER, threadObjectName } from './threads';
import { ACCOUNT, completion, MODEL, MODEL_URL, OWNER, seedAccount, seedThread, type ModelReply } from '../test/runtime';

const HEARTBEAT_MS = 30_000;

/** A conversation's object, reached as the Worker's routes reach it, for the member who owns the Account. */
const objectOf = (threadId: string) => {
  const namespace = env.CHAT_THREADS!;
  const stub = namespace.get(namespace.idFromName(threadObjectName({ accountId: ACCOUNT, threadId })));
  const headers = { [THREAD_ACCOUNT_HEADER]: ACCOUNT, [THREAD_HEADER]: threadId, [THREAD_MEMBER_HEADER]: OWNER.identityId ?? '' };
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await stub.fetch(`https://chat-thread.internal${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { stub, headers, post };
};

/**
 * Serves the AI Connection's model at the global `fetch` the Worker reads at
 * every call: each request it is asked is answered by the next reply, once
 * the test lets it.
 */
const model = (...replies: ModelReply[]) => {
  const asked: unknown[] = [];
  let release: () => void = () => undefined;
  let held = Promise.resolve();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== MODEL_URL) return new Response(null, { status: 404 });
    asked.push(JSON.parse(String(init?.body)));
    await held;
    const reply = replies.shift();
    if (!reply) throw new Error('The model was asked more often than the test said it would be.');
    return completion(reply);
  });
  return {
    asked,
    /** Makes the model wait before it answers, until `release` is called. */
    hold: () => {
      held = new Promise((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
};

const alarmOf = (stub: DurableObjectStub) => runInDurableObject(stub, (_object, state) => state.storage.getAlarm());

const runOf = async (database: D1Database): Promise<{ status: string } | null> =>
  database.prepare("SELECT status FROM runs WHERE trigger = 'chat' ORDER BY started_at DESC LIMIT 1").first<{ status: string }>();

describe('a conversation\'s Durable Object in the Workers runtime', () => {
  it('wakes every 30 seconds while an answer is written, and stops once it is written', async () => {
    const database = await seedAccount();
    const threadId = await seedThread(database);
    const { stub, post } = objectOf(threadId);
    const answered = model({ text: '今日は予定がありません。' });
    answered.hold();

    const started = Date.now();
    await expect(post('/dispatch', { request: '今日の予定は？', model: MODEL, by: OWNER, files: [], delivery: 'steer' })).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(answered.asked).toHaveLength(1));

    expect(await alarmOf(stub)).toBeGreaterThanOrEqual(started + HEARTBEAT_MS);
    // Woken while the model still writes, it sets the next heartbeat.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).not.toBeNull();

    answered.release();
    await vi.waitFor(async () => expect(await runOf(database)).toEqual({ status: 'completed' }));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).toBeNull();
  });

  it('takes up the answer an object was writing when it went away, once its heartbeat wakes it, and completes it', async () => {
    const database = await seedAccount();
    const threadId = await seedThread(database);
    const { stub, post } = objectOf(threadId);
    // The object that goes away may still be answered after it went away, so either request may take either reply.
    const answered = model({ text: '続きです。' }, { text: '続きです。' });
    answered.hold();

    await post('/dispatch', { request: '今日の予定は？', model: MODEL, by: OWNER, files: [], delivery: 'steer' });
    await vi.waitFor(() => expect(answered.asked).toHaveLength(1));
    // The runtime ends the object as it ends one whose isolate goes away: what it was doing ends with it.
    await runInDurableObject(stub, (_object, state) => state.abort('The isolate went away.')).catch(() => undefined);
    // A stub that saw its object reset is refused from then on, so the object is reached anew, as the Worker reaches it per request.
    const { stub: woken } = objectOf(threadId);

    // Nothing writes the answer any longer; the heartbeat opens the conversation again, which takes it up from where it was kept.
    expect(await runOf(database)).toEqual({ status: 'planning' });
    expect(await runDurableObjectAlarm(woken)).toBe(true);
    await vi.waitFor(() => expect(answered.asked.length).toBeGreaterThanOrEqual(2));
    answered.release();
    await vi.waitFor(async () => expect(await runOf(database)).toEqual({ status: 'completed' }));
    const notice = await database.prepare("SELECT payload FROM chat_events WHERE thread_id = ? AND payload LIKE '%止まる前のところから続けます%'").bind(threadId).first();
    expect(notice).not.toBeNull();
    await runDurableObjectAlarm(woken);
    expect(await alarmOf(woken)).toBeNull();
  });

  it('waits for approval with no heartbeat, and resumes the answer after the object went away', async () => {
    const database = await seedAccount();
    const threadId = await seedThread(database);
    const { stub, post } = objectOf(threadId);
    const answered = model(
      { call: { id: 'call-1', name: 'skill.write', arguments: { name: 'greetings', path: 'SKILL.md', content: '---\nname: greetings\ndescription: 挨拶の書き方\n---\n丁寧に書く。' } } },
      { text: 'Skill を作りました。' },
    );
    await post('/mode', { mode: 'ask', by: OWNER });

    await post('/dispatch', { request: '挨拶の Skill を作って', model: MODEL, by: OWNER, files: [], delivery: 'steer' });
    const pause = await vi.waitFor(async () => {
      const row = await database.prepare('SELECT id, tool FROM chat_pauses WHERE thread_id = ?').bind(threadId).first<{ id: string; tool: string }>();
      expect(row).not.toBeNull();
      return row!;
    });
    expect(pause.tool).toBe('skill.write');
    // The heartbeat that was set when the answer started wakes it once and is not set again.
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(stub)).toBeNull();
    expect(await runOf(database)).toEqual({ status: 'planning' });

    await evictDurableObject(stub);
    await expect(post('/respond', { requestId: pause.id, decision: 'accept', by: OWNER })).resolves.toEqual({ accepted: true });

    await vi.waitFor(async () => expect(await runOf(database)).toEqual({ status: 'completed' }));
    expect(answered.asked).toHaveLength(2);
    expect(await database.prepare("SELECT name FROM skills WHERE name = 'greetings'").first()).toEqual({ name: 'greetings' });
  });

  it('keeps a screen\'s socket through hibernation, and sends it what the conversation does after', async () => {
    const database = await seedAccount();
    const threadId = await seedThread(database);
    const { stub, headers, post } = objectOf(threadId);
    model({ text: 'おはようございます。' });
    const connected = await stub.fetch('https://chat-thread.internal/connect?afterSequence=0', { headers: { ...headers, Upgrade: 'websocket' } });
    const socket = connected.webSocket!;
    const frames: string[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(String(event.data));
    });
    socket.accept();
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));

    await evictDurableObject(stub, { webSockets: 'hibernate' });
    const before = frames.length;
    await post('/dispatch', { request: 'おはよう', model: MODEL, by: OWNER, files: [], delivery: 'steer' });

    await vi.waitFor(() => expect(frames.slice(before).some((frame) => frame.includes('おはようございます。'))).toBe(true));
    expect(await runInDurableObject(stub, (_object, state) => state.getWebSockets().length)).toBe(1);
    socket.close(1000, 'done');
  });
});
