import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FORMER_TASK_LIST_NAME, TASK_LIST_NAME, createTask, hasTasksToMove, moveTasksToGoogle, searchTasks, taskWriteCall, updateTask } from './tasks';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { memoryGoogle, type MemoryGoogle } from '../test/providers';
import { TemporaryFailure } from './temporary';

let database: TestD1Database;
let google: MemoryGoogle;

const session = () => ({ google, accessToken: 'token' });

beforeEach(() => {
  database = createMigratedTestD1('organization');
  google = memoryGoogle();
});

afterEach(() => database.close());

const CREATED_AT = '2026-07-01T00:00:00.000Z';

/** One Task as OrangeAgent kept it before Tasks moved to Google Tasks. */
const keep = (task: {
  id: string;
  title: string;
  deadline?: string | null;
  description?: string;
  assigneeName?: string;
  remarks?: string;
  status?: 'open' | 'completed' | 'cancelled';
  completedAt?: string | null;
  sourceMessageSubject?: string;
  scheduledEventTitle?: string | null;
  createdAt?: string;
}): void => database.execute(
  `INSERT INTO tasks (id, organization_id, source_message_subject, scheduled_event_title, title, deadline, assignee_name, description, remarks, status, completed, completed_at, created_at, updated_at)
   VALUES (?, 'organization-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  task.id, task.sourceMessageSubject ?? '', task.scheduledEventTitle ?? null, task.title, task.deadline ?? null, task.assigneeName ?? '未割り当て',
  task.description ?? '', task.remarks ?? '', task.status ?? 'open', task.status === 'completed' ? 1 : 0, task.completedAt ?? null,
  task.createdAt ?? CREATED_AT, task.createdAt ?? CREATED_AT,
);

const moved = () => database.rows<{ id: string; google_task_id: string | null }>('SELECT id, google_task_id FROM tasks ORDER BY id');

describe('moving the Tasks OrangeAgent kept into Google Tasks', () => {
  it('copies each Task into the list named OrangeAgent with what Google Tasks has no field for written in its notes, and records the task it became', async () => {
    keep({
      id: 'task-1', title: '参加費を振り込む', deadline: '2026-08-20', description: '指定口座へ 3,000 円。17時まで。', assigneeName: '山田 太郎',
      remarks: '明日振り込みます', sourceMessageSubject: '総会のご案内', scheduledEventTitle: '秋季総会',
    });
    keep({ id: 'task-2', title: '名簿を整える', createdAt: '2026-07-02T00:00:00.000Z' });

    await expect(moveTasksToGoogle({ database: database.binding, session: session() })).resolves.toEqual({ moved: 2 });

    const list = google.tasks.lists.find(({ title }) => title === TASK_LIST_NAME);
    expect(list).toBeTruthy();
    expect(google.tasks.held.map(({ listId, title, notes, due, status }) => ({ listId, title, notes, due, status }))).toEqual([
      {
        listId: list!.id, title: '参加費を振り込む', due: '2026-08-20T00:00:00.000Z', status: 'needsAction',
        notes: '指定口座へ 3,000 円。17時まで。\n\n担当: 山田 太郎\n予定: 秋季総会\n元メール: 総会のご案内\n備考: 明日振り込みます',
      },
      { listId: list!.id, title: '名簿を整える', notes: undefined, due: undefined, status: 'needsAction' },
    ]);
    expect(moved()).toEqual([
      { id: 'task-1', google_task_id: google.tasks.held[0]!.id },
      { id: 'task-2', google_task_id: google.tasks.held[1]!.id },
    ]);
    await expect(hasTasksToMove(database.binding)).resolves.toBe(false);
  });

  it('copies a completed Task completed, and a cancelled one completed with a line saying it was cancelled', async () => {
    keep({ id: 'done', title: '報告書を出す', deadline: '2026-06-30', status: 'completed', completedAt: '2026-06-29T03:00:00.000Z' });
    keep({ id: 'dropped', title: '会場を押さえる', status: 'cancelled', assigneeName: '佐藤 花子', createdAt: '2026-07-02T00:00:00.000Z' });

    await moveTasksToGoogle({ database: database.binding, session: session() });

    expect(google.tasks.held.map(({ title, notes, status }) => ({ title, notes, status }))).toEqual([
      { title: '報告書を出す', notes: '完了日: 2026-06-29', status: 'completed' },
      { title: '会場を押さえる', notes: '担当: 佐藤 花子\n取りやめ: 必要がなくなり、取りやめになりました。', status: 'completed' },
    ]);
  });

  it('copies a share at a time, oldest first, and nothing once every Task is in Google Tasks', async () => {
    for (const day of [3, 1, 2]) keep({ id: `task-${day}`, title: `仕事 ${day}`, createdAt: `2026-07-0${day}T00:00:00.000Z` });

    await expect(moveTasksToGoogle({ database: database.binding, session: session(), batch: 2 })).resolves.toEqual({ moved: 2 });
    expect(google.tasks.held.map(({ title }) => title)).toEqual(['仕事 1', '仕事 2']);
    await expect(hasTasksToMove(database.binding)).resolves.toBe(true);

    await expect(moveTasksToGoogle({ database: database.binding, session: session(), batch: 2 })).resolves.toEqual({ moved: 1 });
    await expect(moveTasksToGoogle({ database: database.binding, session: session(), batch: 2 })).resolves.toEqual({ moved: 0 });
    expect(google.tasks.held.map(({ title }) => title)).toEqual(['仕事 1', '仕事 2', '仕事 3']);
    expect(google.tasks.lists.filter(({ title }) => title === TASK_LIST_NAME)).toHaveLength(1);
  });

  it('renames the list still called FlareChat and keeps putting Tasks in it, rather than making another', async () => {
    google.tasks.lists.push({ id: 'list-former', title: FORMER_TASK_LIST_NAME });
    keep({ id: 'task-1', title: '名簿を整える' });

    await expect(moveTasksToGoogle({ database: database.binding, session: session() })).resolves.toEqual({ moved: 1 });

    expect(google.tasks.lists.find(({ id }) => id === 'list-former')?.title).toBe(TASK_LIST_NAME);
    expect(google.tasks.lists.filter(({ title }) => title === TASK_LIST_NAME)).toHaveLength(1);
    expect(google.tasks.held.map(({ listId }) => listId)).toEqual(['list-former']);
  });

  it('takes the copy already in Google Tasks rather than making a second, when the copy was made but never recorded', async () => {
    keep({ id: 'task-1', title: '振り込む', deadline: '2026-08-20', assigneeName: '山田 太郎' });
    keep({ id: 'task-2', title: '振り込む', deadline: '2026-08-20', assigneeName: '山田 太郎', createdAt: '2026-07-02T00:00:00.000Z' });
    await moveTasksToGoogle({ database: database.binding, session: session(), batch: 1 });
    // The copy of task-1 was made, and the Worker stopped before recording it.
    database.execute("UPDATE tasks SET google_task_id = NULL WHERE id = 'task-1'");

    await moveTasksToGoogle({ database: database.binding, session: session() });

    // Two Tasks that read the same are two Tasks: the first takes the copy there, the second is copied.
    expect(google.tasks.held).toHaveLength(2);
    const ids = moved().map((row) => row.google_task_id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual(google.tasks.held.map(({ id }) => id).sort());
  });

  it('keeps what it copied when Google fails part way, and copies the rest the next time', async () => {
    keep({ id: 'task-1', title: '一つめ' });
    keep({ id: 'task-2', title: '二つめ', createdAt: '2026-07-02T00:00:00.000Z' });
    await moveTasksToGoogle({ database: database.binding, session: session(), batch: 1 });
    google.failNext('createTask', new TemporaryFailure('Google answered 503.', 503, null, 'unknown'));

    await expect(moveTasksToGoogle({ database: database.binding, session: session() })).rejects.toThrow('503');
    expect(moved().map((row) => row.google_task_id !== null)).toEqual([true, false]);

    await expect(moveTasksToGoogle({ database: database.binding, session: session() })).resolves.toEqual({ moved: 1 });
    expect(google.tasks.held.map(({ title }) => title)).toEqual(['一つめ', '二つめ']);
  });
});

describe('Tasks in Google Tasks', () => {
  it('reads a write the one way, refusing what Google Tasks cannot hold and a reopening', () => {
    expect(taskWriteCall('tasks.create', { title: ' 振り込む ', due: null })).toEqual({ title: '振り込む', notes: '', due: null });
    expect(() => taskWriteCall('tasks.create', { title: '振り込む' })).toThrow('requires due');
    expect(() => taskWriteCall('tasks.create', { title: '振り込む', due: '2026-08-20T17:00:00+09:00' })).toThrow('YYYY-MM-DD');
    expect(() => taskWriteCall('tasks.create', { title: '', due: null })).toThrow('requires a title');
    expect(() => taskWriteCall('tasks.update', { listId: 'list-1', taskId: 'task-1', status: 'open' })).toThrow('Only a person reopens a Task');
    expect(() => taskWriteCall('tasks.update', { listId: 'list-1', taskId: 'task-1' })).toThrow('at least one');
    expect(() => taskWriteCall('tasks.update', { taskId: 'task-1', status: 'completed' })).toThrow('listId');
    expect(taskWriteCall('tasks.update', { listId: 'list-1', taskId: 'task-1', due: null, notes: ' 担当: 山田 ' }))
      .toEqual({ listId: 'list-1', taskId: 'task-1', due: null, notes: '担当: 山田' });
  });

  it('finds a Task by its due day or a phrase of its notes, in whichever list it is', async () => {
    const created = await createTask(session(), taskWriteCall('tasks.create', { title: '振り込む', due: '2026-08-20', notes: '担当: 山田 太郎' })) as { task: { id: string; listId: string } };
    await createTask(session(), taskWriteCall('tasks.create', { title: '牛乳を買う', due: null, listId: 'list-default' }));
    const at = Date.parse('2026-08-01T00:00:00.000Z');

    await expect(searchTasks(session(), { from: '2026-08-20', to: '2026-08-20' }, at)).resolves.toMatchObject({ tasks: [{ id: created.task.id, due: '2026-08-20', status: 'open' }] });
    await expect(searchTasks(session(), { from: '2026-08-21' }, at)).resolves.toMatchObject({ tasks: [] });
    await expect(searchTasks(session(), { text: '山田' }, at)).resolves.toMatchObject({ tasks: [{ title: '振り込む', notes: '担当: 山田 太郎' }] });
    await expect(searchTasks(session(), {}, at)).resolves.toMatchObject({
      lists: [{ id: 'list-default', name: 'マイタスク' }, { id: created.task.listId, name: TASK_LIST_NAME }],
      tasks: [{ title: '振り込む' }, { title: '牛乳を買う', listId: 'list-default', due: null }],
    });
    await expect(searchTasks(session(), { listId: 'nowhere' }, at)).resolves.toMatchObject({ isError: true });
    await expect(searchTasks(session(), { from: 'tomorrow' }, at)).resolves.toMatchObject({ isError: true });
  });

  it('changes only what a change names, clears a due day, and answers a Task that is not there', async () => {
    const { task } = await createTask(session(), taskWriteCall('tasks.create', { title: '振り込む', due: '2026-08-20', notes: '担当: 山田 太郎' })) as { task: { id: string; listId: string } };

    await expect(updateTask(session(), taskWriteCall('tasks.update', { listId: task.listId, taskId: task.id, due: null, status: 'completed' })))
      .resolves.toMatchObject({ updated: true, task: { title: '振り込む', notes: '担当: 山田 太郎', due: null, status: 'completed' } });
    await expect(updateTask(session(), taskWriteCall('tasks.update', { listId: task.listId, taskId: 'gone', title: '別の題名' })))
      .resolves.toMatchObject({ isError: true, message: expect.stringContaining('tasks.search') });
  });
});
