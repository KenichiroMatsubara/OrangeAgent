/**
 * tasks.mjs を、OrangeAgent のツールの答え方をまねた偽物に対して確かめます。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * The program as the Worker ships it, its text, imported as the module a
 * Dynamic Worker makes of it. Every other import of the file is its text.
 */
const program = await import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(readFileSync(new URL('./tasks.mjs', import.meta.url), 'utf8'))}`) as typeof import('./tasks.mjs');
const { Tasks, ToolError, makeKey, mcpCall, normalize, noticeOf, notesOf, parseNotes, reminderText, renderNotes } = program;
type Tasks = InstanceType<typeof Tasks>;

type Row = Record<string, unknown>;
type View = { id: string; listId: string; title: string; notes: string; due: string | null; status: string; completedAt: string | null; updatedAt: string | null; url: string | null };
type Task = Awaited<ReturnType<Tasks['search']>>[number];

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const CONTACTS = [
  { id: 'c1', name: '山田 太郎', email: 'yamada@example.com', state: 'active', channels: ['line'] },
  { id: 'c2', name: '佐藤花子', email: 'sato@example.com', state: 'active', channels: [] },
  { id: 'c3', name: '鈴木', email: '', state: 'active', channels: ['line'] },
  { id: 'c4', name: '鈴木', email: '', state: 'active', channels: ['discord'] },
];

/**
 * tasks.search / tasks.create / tasks.update / query_contacts を、Worker と同じ形の JSON 文字列で答えます。
 * planned なら、自動化のように書き込みを計画するだけで、Google ToDo は変わりません。
 */
class OrangeAgent {
  readonly lists = [{ id: 'L1', name: 'OrangeAgent' }, { id: 'L2', name: '私の ToDo' }];
  readonly tasks: View[] = [];
  readonly calls: Array<[string, Row]> = [];

  constructor(readonly planned = false) {}

  add(task: Partial<View>): View {
    const view: View = { id: `t${this.tasks.length + 1}`, listId: 'L1', title: '', notes: '', due: null, status: 'open', completedAt: null, updatedAt: null, url: null, ...task };
    this.tasks.push(view);
    return view;
  }

  call = async (name: string, args: Row): Promise<string> => {
    this.calls.push([name, args]);
    if (name === 'query_contacts') return JSON.stringify(CONTACTS);
    if (name === 'tasks.search') {
      const phrase = text(args.text).toLowerCase();
      const found = this.tasks.filter((task) => (!args.status || task.status === args.status)
        && (!args.from || (task.due ?? '') >= text(args.from))
        && (!args.to || (task.due ?? '9999') <= text(args.to))
        && (!phrase || task.title.toLowerCase().includes(phrase) || task.notes.toLowerCase().includes(phrase)));
      return JSON.stringify({ lists: this.lists, tasks: found });
    }
    if (this.planned) return JSON.stringify({ status: 'planned' });
    if (name === 'tasks.create') {
      const view = this.add({ title: text(args.title), notes: text(args.notes), due: (args.due as string | null) ?? null, listId: text(args.listId, 'L1') });
      return JSON.stringify({ created: true, task: view });
    }
    if (name === 'tasks.update') {
      const view = this.tasks.find((task) => task.id === args.taskId);
      if (!view) return JSON.stringify({ isError: true, message: `Task ${String(args.taskId)} is not in task list ${String(args.listId)}.` });
      for (const field of ['title', 'notes', 'due', 'status'] as const) if (field in args) (view as Row)[field] = args[field];
      return JSON.stringify({ updated: true, task: view });
    }
    return JSON.stringify({ isError: true, message: `${name} is not one of the tools you were given.` });
  };

  writes(): Array<[string, Row]> {
    return this.calls.filter(([name]) => name === 'tasks.create' || name === 'tasks.update');
  }
}

describe('the notes', () => {
  it('writes the details, then one line per field in a fixed order', () => {
    const notes = renderNotes('19 時から。会費 3,000 円', { 鍵: 'k1', 担当: '山田 太郎', 備考: ['一つ目', '二つ目'], 予定: '' });
    expect(notes).toBe('19 時から。会費 3,000 円\n\n担当: 山田 太郎\n鍵: k1\n備考: 一つ目\n備考: 二つ目');
  });

  it('reads every field line and keeps every other line as the details', () => {
    const parsed = parseNotes('会場の予約\n担当：山田 太郎\n人が足した一行\n\n予定: 例会（12/5）\n備考: a\n備考: b\n取りやめ: 中止');
    expect(parsed.body).toBe('会場の予約\n人が足した一行');
    expect(parsed.fields).toMatchObject({ 担当: '山田 太郎', 予定: '例会（12/5）', 備考: ['a', 'b'], 取りやめ: '中止' });
  });

  it('reads back what it wrote', () => {
    const task = { body: '内容', assignee: '佐藤花子', event: '総会（6/1）', mail: '総会のご案内', key: 'abc', remarks: ['電話で確認'], completedOn: '', cancelReason: '' };
    expect(parseNotes(notesOf(task)).fields).toMatchObject({ 担当: '佐藤花子', 予定: '総会（6/1）', 元メール: '総会のご案内', 鍵: 'abc', 備考: ['電話で確認'] });
  });

  it('makes one key for one mail and title however the title is spaced', async () => {
    expect(await makeKey('m1', '会場の予約')).toBe(await makeKey('m1', ' 会場の 予約 '));
    expect(await makeKey('m1', 'ＡＢＣ')).toBe(await makeKey('m1', 'abc'));
    expect(await makeKey('m1', '会場の予約')).not.toBe(await makeKey('m2', '会場の予約'));
    expect(normalize(' 山田　太郎 ')).toBe('山田太郎');
  });

  it('makes the key tasks.py made, so a Task written before keeps its key', async () => {
    // hashlib.sha256('m1\n会場の予約'.encode()).hexdigest()[:12]
    expect(await makeKey('m1', '会場の予約')).toBe('265b545fa199');
  });
});

describe('upsert', () => {
  it('creates a task in the form the notes are read in', async () => {
    const orangeagent = new OrangeAgent();
    const [result] = await new Tasks(orangeagent.call).upsert([{
      title: '会場の予約', due: '2026-12-01', body: '公民館に電話', assignee: '山田太郎', event: '例会（12/5）', mail: '例会のご案内', mailId: 'm1',
    }]);
    expect(result?.result).toBe('created');
    const [[name, args] = ['', {}]] = orangeagent.writes();
    expect(name).toBe('tasks.create');
    expect(args.due).toBe('2026-12-01');
    expect(args).not.toHaveProperty('listId');
    const key = await makeKey('m1', '会場の予約');
    // The assignee is written as the Contact is named, whatever spacing the caller used.
    expect(args.notes).toBe(`公民館に電話\n\n担当: 山田 太郎\n予定: 例会（12/5）\n元メール: 例会のご案内\n鍵: ${key}`);
  });

  it('changes the open task of the same key instead of making another', async () => {
    const orangeagent = new OrangeAgent();
    const key = await makeKey('m1', '会場の予約');
    orangeagent.add({ title: '会場の予約', due: '2026-12-01', notes: `公民館に電話\n人が足した一行\n\n鍵: ${key}` });
    const [result] = await new Tasks(orangeagent.call).upsert([{ title: '会場の 予約', due: '2026-12-03', mailId: 'm1', assignee: '佐藤花子' }]);
    expect(result?.result).toBe('updated');
    const [[name, args] = ['', {}]] = orangeagent.writes();
    expect(name).toBe('tasks.update');
    expect(args.due).toBe('2026-12-03');
    // A title written differently is not written back, and what a person added stays.
    expect(args).not.toHaveProperty('title');
    expect(args.notes).toBe(`公民館に電話\n人が足した一行\n\n担当: 佐藤花子\n鍵: ${key}`);
  });

  it('says unchanged when the same mail is read again', async () => {
    const orangeagent = new OrangeAgent();
    const item = { title: '会場の予約', due: '2026-12-01', mailId: 'm1', assignee: '山田 太郎' };
    await new Tasks(orangeagent.call).upsert([item]);
    const [again] = await new Tasks(orangeagent.call).upsert([item]);
    expect(again?.result).toBe('unchanged');
    expect(orangeagent.tasks).toHaveLength(1);
  });

  it('changes nothing when the task of the same key is done or cancelled', async () => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会費の振込', status: 'completed', notes: `鍵: ${await makeKey('m1', '会費の振込')}` });
    const [result] = await new Tasks(orangeagent.call).upsert([{ title: '会費の振込', due: '2026-12-01', mailId: 'm1' }]);
    expect(result?.result).toBe('closed');
    expect(orangeagent.writes()).toEqual([]);
  });

  it('refuses an assignee it cannot name as exactly one contact, and writes nothing', async () => {
    const orangeagent = new OrangeAgent();
    const [missing, ambiguous] = await new Tasks(orangeagent.call).upsert([
      { title: 'a', mailId: 'm1', assignee: '田中' },
      { title: 'b', mailId: 'm1', assignee: '鈴木' },
    ]);
    expect(missing).toMatchObject({ result: 'refused', reason: expect.stringContaining('連絡先にいません') });
    expect(ambiguous).toMatchObject({ result: 'refused', reason: expect.stringContaining('2 人') });
    expect(orangeagent.writes()).toEqual([]);
  });

  it('refuses a due day it cannot read', async () => {
    const [result] = await new Tasks(new OrangeAgent().call).upsert([{ title: 'a', due: '12/1' }]);
    expect(result?.result).toBe('refused');
  });

  it('plans each key once in an Automation whose writes are applied later', async () => {
    const orangeagent = new OrangeAgent(true);
    const tasks = new Tasks(orangeagent.call);
    const [first, again] = await tasks.upsert([{ title: '会場の予約', mailId: 'm1' }, { title: '会場の予約', mailId: 'm1' }]);
    const [later] = await tasks.upsert([{ title: '会場の予約', mailId: 'm1' }]);
    expect([first?.result, again?.result, later?.result]).toEqual(['planned', 'duplicate', 'duplicate']);
    expect(orangeagent.writes()).toHaveLength(1);
  });

  it('reports a tool refusal as that item refused', async () => {
    const refusing = async (name: string) => name === 'tasks.search'
      ? { isError: true, message: 'The Automation Inbox’s Google grant does not reach Google Tasks yet.' }
      : JSON.stringify(CONTACTS);
    const [result] = await new Tasks(refusing).upsert([{ title: 'a' }]);
    expect(result).toMatchObject({ result: 'refused', reason: expect.stringContaining('does not reach Google Tasks') });
  });
});

describe('search', () => {
  const seeded = (): OrangeAgent => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会場の予約', notes: '担当: 山田 太郎\n予定: 例会（12/5）' });
    orangeagent.add({ title: '案内の発送', notes: '担当: 佐藤花子' });
    orangeagent.add({ title: '名札の用意', status: 'completed', notes: '担当: 山田 太郎\n取りやめ: 例会が中止' });
    orangeagent.add({ title: '会費の振込', status: 'completed', notes: '担当: 山田 太郎' });
    orangeagent.add({ title: '牛乳', listId: 'L2' });
    orangeagent.add({ title: '椅子の手配' });
    return orangeagent;
  };
  const titles = async (filters: Parameters<Tasks['search']>[0] = {}): Promise<string[]> =>
    (await new Tasks(seeded().call).search(filters)).map((task) => task.title);

  it('reads only the OrangeAgent list unless asked for every list', async () => {
    expect(await titles()).not.toContain('牛乳');
    expect(await titles({ allLists: true })).toContain('牛乳');
  });

  it('finds by assignee exactly, whatever the spacing', async () => {
    expect(await titles({ assignee: '山田太郎', status: 'open' })).toEqual(['会場の予約']);
    expect(await titles({ assignee: '' })).toEqual(['椅子の手配']);
  });

  it('tells a cancelled task from a completed one', async () => {
    expect(await titles({ status: 'cancelled' })).toEqual(['名札の用意']);
    expect(await titles({ status: 'completed' })).toEqual(['会費の振込']);
  });

  it('finds by event', async () => {
    expect(await titles({ event: '例会' })).toEqual(['会場の予約']);
  });
});

describe('writing', () => {
  it('cancels as completed with the reason, and completes with a remark', async () => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会場の予約', notes: '公民館\n\n担当: 山田 太郎' });
    orangeagent.add({ title: '会費の振込' });
    const tasks = new Tasks(orangeagent.call);
    const [reserve, fee] = await tasks.search() as [Task, Task];
    expect((await tasks.cancel(reserve, '例会が中止')).result).toBe('updated');
    expect((await tasks.complete(fee, '入金を確認')).result).toBe('updated');
    expect(orangeagent.tasks[0]).toMatchObject({ status: 'completed', notes: '公民館\n\n担当: 山田 太郎\n取りやめ: 例会が中止' });
    expect(orangeagent.tasks[1]?.notes).toBe('備考: 入金を確認');
    const cancelled = await tasks.search({ status: 'cancelled' });
    expect(cancelled.map((task) => task.title)).toEqual(['会場の予約']);
    expect((await tasks.search({ status: 'completed' })).map((task) => task.title)).toEqual(['会費の振込']);
    // A closed task is not written again.
    expect((await tasks.cancel(cancelled[0] as Task, '重ねて')).result).toBe('closed');
  });

  it('updates only what was named', async () => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会場の予約', due: '2026-12-01', notes: '公民館\n\n担当: 山田 太郎\n備考: 一つ目' });
    const tasks = new Tasks(orangeagent.call);
    const [task] = await tasks.search() as [Task];
    await tasks.update(task, { due: '2026-12-02', remark: '二つ目' });
    const [[, args] = ['', {}]] = orangeagent.writes();
    expect(args).toEqual({ listId: 'L1', taskId: 't1', due: '2026-12-02', notes: '公民館\n\n担当: 山田 太郎\n備考: 一つ目\n備考: 二つ目' });
  });
});

describe('reminders', () => {
  it('gathers each assignee’s due tasks into one message', async () => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会場の予約', due: '2026-12-08', notes: '公民館に電話\n\n担当: 山田 太郎' });
    orangeagent.add({ title: '名簿の確認', due: '2026-12-01', notes: '担当: 山田 太郎' });
    orangeagent.add({ title: '案内の発送', due: '2026-11-30', notes: '担当: 佐藤花子' });
    orangeagent.add({ title: '椅子の手配', due: '2026-12-01' });
    orangeagent.add({ title: '受付の準備', due: '2026-12-04', notes: '担当: 鈴木' });
    orangeagent.add({ title: '来月の話', due: '2026-12-05', notes: '担当: 山田 太郎' });
    const answer = await new Tasks(orangeagent.call).reminders({ today: '2026-12-01', reportTo: '事務局' });
    const byName = Object.fromEntries(answer.messages.map((message) => [message.contact.name, message]));
    expect(Object.keys(byName).sort()).toEqual(['佐藤花子', '山田 太郎']);
    expect(byName['山田 太郎']?.text).toBe([
      '【タスクのお知らせ】',
      '・12/1(火) 名簿の確認（今日まで）',
      '・12/8(火) 会場の予約（あと 7 日）',
      '  公民館に電話',
      '終わったら 事務局 に知らせてください。',
    ].join('\n'));
    expect(byName['佐藤花子']?.text).toContain('期限を過ぎています');
    expect(answer.skipped.map((item) => [item.title, item.reason.slice(0, 4)]).sort()).toEqual([['受付の準備', '担当者「'], ['椅子の手配', '担当者が']]);
  });

  it('writes no field line into a message', () => {
    expect(reminderText([{ title: 'a', due: '2026-12-01', daysLeft: 3, body: '' }])).toBe('【タスクのお知らせ】\n・12/1(火) a（あと 3 日）');
  });
});

describe('noticeOf', () => {
  const found = async (): Promise<Task[]> => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '登録料の振込', due: '2026-11-13', status: 'completed', completedAt: '2026-11-20T13:30:00.000Z', notes: '熱田RACの口座へ 3 名分\n\n担当: 山田 太郎' });
    orangeagent.add({ title: '名札の用意', due: '2026-11-25', status: 'completed', notes: '担当: 山田 太郎\n取りやめ: 例会が中止' });
    orangeagent.add({ title: '会場の予約', due: '2026-11-25', notes: '公民館に電話\n\n担当: 山田 太郎' });
    return new Tasks(orangeagent.call).search({ allLists: true });
  };

  it('says a completed task was done on its day, not that its deadline passed', async () => {
    const [paid] = await found() as [Task];
    expect(noticeOf(paid, { today: '2026-11-22' })).toBe('【タスクのお知らせ】\n・11/13(金) 登録料の振込（完了: 11/20）\n  熱田RACの口座へ 3 名分');
  });

  it('says how long an open task has, and why a cancelled one was dropped, from the tasks search found', async () => {
    const [, dropped, open] = await found() as [Task, Task, Task];
    expect(noticeOf([dropped, open], { today: '2026-11-22', reportTo: '幹事' })).toBe([
      '【タスクのお知らせ】',
      '・11/25(水) 名札の用意（取りやめ: 例会が中止）',
      '・11/25(水) 会場の予約（あと 3 日）',
      '  公民館に電話',
      '終わったら 幹事 に知らせてください。',
    ].join('\n'));
  });

  it('refuses a task it was not handed by search', () => {
    expect(() => noticeOf({ title: '登録料の振込', body: '自分で書いた内容', due: '2026-11-13', confirmed: true } as never)).toThrow('t.search が返したタスク');
  });
});

describe('the MCP Server, reached with a Run Token from where the network is reached', () => {
  const serve = (orangeagent: OrangeAgent, seen: Array<{ authorization: string | null; body: Row }>) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(text(init.body)) as { id: number; params: { name: string; arguments: Row } };
      const authorization = new Headers(init.headers).get('Authorization');
      seen.push({ authorization, body });
      if (authorization !== 'Bearer run_secret') {
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This token is not recognised, or it has expired.' } }, { status: 401 });
      }
      const answered = await orangeagent.call(body.params.name, body.params.arguments);
      const failed = answered.startsWith('{') && Boolean((JSON.parse(answered) as Row).isError);
      const message = failed ? String((JSON.parse(answered) as Row).message) : null;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: failed, content: [{ type: 'text', text: message ?? answered }] } });
    });

  it('calls the tools through the MCP Server, with the token in the header alone', async () => {
    const orangeagent = new OrangeAgent();
    const seen: Array<{ authorization: string | null; body: Row }> = [];
    vi.stubGlobal('fetch', serve(orangeagent, seen));
    const [result] = await new Tasks(mcpCall('https://orangeagent.example/mcp', 'run_secret')).upsert([{ title: '会場の予約', assignee: '山田太郎', mailId: 'm1' }]);
    expect(result?.result).toBe('created');
    expect(orangeagent.calls.map(([name]) => name)).toEqual(['query_contacts', 'tasks.search', 'tasks.create']);
    expect(seen.every((entry) => entry.authorization === 'Bearer run_secret')).toBe(true);
    expect(seen.every((entry) => !JSON.stringify(entry.body).includes('run_secret'))).toBe(true);
    expect(seen.at(-1)?.body.method).toBe('tools/call');
  });

  it('raises what the server or the tool refused', async () => {
    vi.stubGlobal('fetch', serve(new OrangeAgent(), []));
    await expect(new Tasks(mcpCall('https://orangeagent.example/mcp', 'run_expired')).search()).rejects.toThrow(ToolError);
    await expect(new Tasks(mcpCall('https://orangeagent.example/mcp', 'run_expired')).search()).rejects.toThrow('not recognised');
    await expect(new Tasks(mcpCall('https://orangeagent.example/mcp', 'run_secret')).update({ id: 'missing', listId: 'L1', status: 'open', title: 'x' } as Task, { title: 'y' }))
      .rejects.toThrow('is not in task list');
  });
});

describe('the tools code.run lends', () => {
  it('are called through their call, as env.TOOLS is', async () => {
    const orangeagent = new OrangeAgent();
    orangeagent.add({ title: '会場の予約' });
    const tools = { call: (name: string, args: Row) => orangeagent.call(name, args) };
    expect((await new Tasks(tools).search()).map((task) => task.title)).toEqual(['会場の予約']);
  });
});
