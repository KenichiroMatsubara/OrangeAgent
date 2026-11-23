import { afterEach, describe, expect, it } from 'vitest';

import { activateSkill, createSkill, discardSkillFolders, moveSkillFiles, performSkillWrite, readSkillResource, removeSkillFile, runSkills, skillDirectory, skillFile, skillWriteCall, writeSkillFile, type SkillStore } from './skills';
import { TASK_SKILL } from './starter';
import { FileAnswer } from './turns';
import { accountDatabase } from './storage/database';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, type MemoryR2 } from '../test/seed';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const AT = '2026-07-25T00:00:00.000Z';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Makes a Skill from its SKILL.md and writes each other file into it, one at a time, as the スキル screen does. */
const folderOf = async (store: SkillStore, document: string, files: ReadonlyArray<[string, Uint8Array]> = []) => {
  let skill = await createSkill(store, bytes(document));
  for (const [path, content] of files) skill = await writeSkillFile(store, { skillId: skill.id, path, bytes: content });
  return skill;
};

/**
 * One Skill as migration 0064 leaves a Skill written before Agent Skills: its
 * name rewritten, its title the name it had, and its words still the rows of
 * its revision, with no directory yet.
 */
const seedRows = (db: TestD1Database, input: { id: string; name: string; title: string; description: string; instructions: string; files: Array<[string, string]> }): void => {
  db.execute(
    "INSERT INTO skills (id, account_id, name, title, description, instructions, revision, created_at, updated_at) VALUES (?, 'organization-1', ?, ?, ?, ?, 2, ?, ?)",
    input.id, input.name, input.title, input.description, input.instructions, AT, AT,
  );
  db.execute('INSERT INTO skill_revisions (skill_id, revision, instructions, created_at) VALUES (?, 1, ?, ?), (?, 2, ?, ?)', input.id, 'Old.', AT, input.id, input.instructions, AT);
  db.execute("INSERT INTO skill_files (skill_id, revision, path, content, created_at) VALUES (?, 1, 'old.md', 'Gone.', ?)", input.id, AT);
  for (const [path, content] of input.files) {
    db.execute('INSERT INTO skill_files (skill_id, revision, path, content, created_at) VALUES (?, 2, ?, ?, ?)', input.id, path, content, AT);
  }
};

const storeOf = (db: TestD1Database, r2: MemoryR2): SkillStore => ({ db: accountDatabase(db.binding), bucket: r2.bucket, accountId: 'organization-1' });

const WEEKLY = '---\nname: weekly-report\ndescription: 週の終わり。\nmetadata:\n  display-name: 週報\n---\n\nWrite it as examples/report.md shows.\n';

describe('Skill directories', () => {
  it('keeps a Skill as the directory its name names in R2, every file as its own bytes and media type', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);

    const skill = await folderOf(store, WEEKLY, [
      ['/examples\\report.md', bytes('今週は…')],
      ['assets/logo.png', PNG],
      ['scripts/fill.py', bytes('print("hi")\n')],
    ]);

    expect(skill).toMatchObject({ name: 'weekly-report', title: '週報', description: '週の終わり。', files: [
      { path: 'SKILL.md', mediaType: 'text/markdown' },
      { path: 'assets/logo.png', size: PNG.byteLength, mediaType: 'image/png' },
      { path: 'examples/report.md', mediaType: 'text/markdown' },
      { path: 'scripts/fill.py', mediaType: 'text/x-python' },
    ] });
    expect(r2.keys().sort()).toEqual([
      'skills/organization-1/weekly-report/SKILL.md',
      'skills/organization-1/weekly-report/assets/logo.png',
      'skills/organization-1/weekly-report/examples/report.md',
      'skills/organization-1/weekly-report/scripts/fill.py',
    ]);
    expect(database.rows('SELECT name, title, directory FROM skills')).toEqual([{ name: 'weekly-report', title: '週報', directory: 'weekly-report' }]);
    await expect(skillFile(store, skill.id, 'assets/logo.png')).resolves.toEqual({ path: 'assets/logo.png', mediaType: 'image/png', bytes: PNG });
  });

  it('writes a file over itself, moves a file or a folder, and deletes a file, in the same directory', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    const skill = await folderOf(store, WEEKLY, [['logo.png', PNG], ['examples/a.md', bytes('a')], ['examples/b.md', bytes('b')]]);

    await writeSkillFile(store, { skillId: skill.id, path: 'examples/a.md', bytes: bytes('A') });
    await moveSkillFiles(store, { skillId: skill.id, from: 'logo.png', to: 'assets/logo.png' });
    await moveSkillFiles(store, { skillId: skill.id, from: 'examples', to: 'samples' });
    const removed = await removeSkillFile(store, { skillId: skill.id, path: 'samples/b.md' });

    expect(removed.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.png', 'samples/a.md']);
    expect(r2.keys()).toHaveLength(3);
    await expect(skillFile(store, skill.id, 'samples/a.md')).resolves.toMatchObject({ bytes: bytes('A') });
    await expect(moveSkillFiles(store, { skillId: skill.id, from: 'samples', to: 'samples/inner' })).rejects.toThrow('その中には');
    await expect(moveSkillFiles(store, { skillId: skill.id, from: 'samples/a.md', to: 'assets/logo.png' })).rejects.toThrow('もうあります');
    await expect(removeSkillFile(store, { skillId: skill.id, path: 'SKILL.md' })).rejects.toThrow('削除できません');
  });

  it('renames a Skill and moves its directory when its SKILL.md is written, and refuses a name the specification or another Skill forbids', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    await folderOf(store, '---\nname: attendance\ndescription: 出欠。\n---\n\nCount them.');
    const skill = await folderOf(store, WEEKLY, [['examples/report.md', bytes('今週は…')]]);
    const monthly = '---\nname: monthly-report\ndescription: 月の終わり。\nmetadata:\n  display-name: 月報\n---\n\nWrite it.';

    const renamed = await writeSkillFile(store, { skillId: skill.id, path: 'SKILL.md', bytes: bytes(monthly) });

    expect(renamed).toMatchObject({ name: 'monthly-report', title: '月報', description: '月の終わり。' });
    expect(r2.keys().filter((key) => key.includes('report')).sort()).toEqual(['skills/organization-1/monthly-report/SKILL.md', 'skills/organization-1/monthly-report/examples/report.md']);
    await expect(createSkill(store, bytes('Do it.'))).rejects.toThrow('name:');
    await expect(createSkill(store, bytes('---\nname: 週報\ndescription: x\n---\n\nAgain.'))).rejects.toThrow('英小文字');
    await expect(createSkill(store, bytes('---\nname: attendance\ndescription: x\n---\n\nAgain.'))).rejects.toThrow('もうあります');
    await expect(writeSkillFile(store, { skillId: skill.id, path: 'SKILL.md', bytes: bytes('---\nname: attendance\ndescription: x\n---\n\nAgain.') })).rejects.toThrow('もうあります');
    await expect(writeSkillFile(store, { skillId: skill.id, path: '../secret.md', bytes: bytes('x') })).rejects.toThrow('名前にできません');
    await expect(skillFile(store, skill.id, 'SKILL.md')).resolves.toMatchObject({ bytes: bytes(monthly) });
  });

  it('deletes every file a deleted Skill had', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    const skill = await folderOf(store, WEEKLY, [['logo.png', PNG]]);
    await discardSkillFolders(store, { id: skill.id, directory: 'weekly-report' });
    expect(r2.keys()).toEqual([]);
  });
});

describe('a Skill kept before Agent Skills', () => {
  it('is moved to its directory the first time it is read, once, stating its new name and its title', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    seedRows(database, { id: 'notice', name: 'weekly-report', title: '週報', description: '週の終わり。', instructions: 'スキル「出欠」を skill.read で読む。', files: [['examples/report.md', '今週は…']] });
    seedRows(database, { id: 'attendance', name: 'attendance', title: '出欠', description: '出欠の返事。', instructions: 'Count them.', files: [] });

    await runSkills(store, ['notice']);
    await runSkills(store, ['notice']);

    expect(r2.keys().sort()).toEqual(['skills/organization-1/weekly-report/SKILL.md', 'skills/organization-1/weekly-report/examples/report.md']);
    expect(r2.object('skills/organization-1/weekly-report/SKILL.md')).toBe('---\nname: weekly-report\ndescription: 週の終わり。\nmetadata:\n  display-name: 週報\n---\n\nスキル attendance（出欠）を activate_skill で読む。\n');
    expect(database.rows("SELECT directory FROM skills WHERE id = 'notice'")).toEqual([{ directory: 'weekly-report' }]);
  });

  it('loads the product’s タスクの管理 as it now must, keeping every step the Account added to it, and gives it tasks.mjs beside its tasks.py', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    const kept = [
      'タスクは Google ToDo に置きます。',
      '',
      '## 読み込み方',
      '',
      "    path = subprocess.run(\"find / -name '*__tasks.py'\", shell=True)",
      '',
      '## 使い方',
      '',
      '- 見本・過去の行事を例にした通知は reminder_text で作ります。通知文は自分で書きません。',
      '',
      '## コードを実行できないとき',
      '',
      'tasks.search を直接呼びます。',
    ].join('\n');
    seedRows(database, { id: 'tasks', name: 'task-management', title: 'タスクの管理', description: 'タスク。', instructions: kept, files: [['tasks.py', 'print(1)\n']] });

    const opened = await activateSkill(store, 'task-management') as { instructions: string; resources: string[] };

    expect(opened).toMatchObject({ name: 'task-management', title: 'タスクの管理', resources: ['scripts/tasks.mjs', 'scripts/tasks.py'] });
    // The Account's own words and rules stay; only how the program is loaded and called is the product's as it now is.
    expect(opened.instructions).toContain('タスクは Google ToDo に置きます。');
    expect(opened.instructions).toContain('- 見本・過去の行事を例にした通知は noticeOf で作ります。通知文は自分で書きません。');
    expect(opened.instructions).not.toContain('tasks.py');
    expect(opened.instructions).toContain("import { Tasks, noticeOf } from './skills/task-management/scripts/tasks.mjs';");
    expect(opened.instructions).not.toContain('tasks.search を直接呼びます。');
  });
});

describe('the starting Skills, once タスクの管理’s program is a module', () => {
  const PYTHON_TASKS = [
    '---',
    'name: task-management',
    'description: タスクを扱うとき。読み書きする scripts/tasks.py とその決まりがここにあります。',
    'metadata:',
    '  display-name: タスクの管理',
    '---',
    '',
    'タスクは Google ToDo に置きます。',
    '',
    '## 読み込み方',
    '',
    'tasks.py は code.run で動かします。',
    '',
    '    import asyncio, json, os, sys',
    "    sys.path.insert(0, '/skills/task-management/scripts')",
    '',
    '## 最重要: 担当者・幹事・会計に送る通知文は、自分で書かない',
    '',
    '通知文は必ず tasks.reminder_text で作ります。',
    '',
    '## 使い方',
    '',
    "- 探す: await t.search(status=…, assignee=…, event=…, text=…, due_from=…, due_to=…)。どれも省けます。",
    "- 担当者に知らせる: await t.reminders(today='YYYY-MM-DD', days=(7, 3, 0, -1), report_to=None)。",
    '- 会計への通知は、会計の連絡先にだけ送ります。',
    '',
    '## 決まり',
    '',
    '- 完了にするのは、受領が確認されたときだけです。',
    '',
    '## コードを実行できないとき',
    '',
    'code.run が使えないときは、メモ欄を tasks.py と同じ形で書きます。',
  ].join('\n');

  it('reads タスクの管理 for its module, keeping the sections and the lines the Account added, and leaves its tasks.py as it was', async () => {
    database = createMigratedTestD1('organization');
    const r2 = createMemoryR2();
    const store = storeOf(database, r2);
    await folderOf(store, PYTHON_TASKS, [['scripts/tasks.py', bytes('print(1)\n')]]);

    const opened = await activateSkill(store, 'task-management') as { instructions: string; resources: string[]; description: string };
    const again = await activateSkill(store, 'task-management') as { instructions: string };

    expect(opened.resources).toEqual(['scripts/tasks.mjs', 'scripts/tasks.py']);
    expect(r2.object('skills/organization-1/task-management/scripts/tasks.py')).toBe('print(1)\n');
    expect(r2.object('skills/organization-1/task-management/scripts/tasks.mjs')).toContain('export const noticeOf');
    const { instructions } = opened;
    expect(instructions).not.toMatch(/tasks\.py|reminder_text|sys\.path|due_from/u);
    expect(instructions).toContain('## 最重要: 担当者・幹事・会計に送る通知文は、自分で書かない\n\n通知文は必ず noticeOf で作ります。');
    expect(instructions).toContain('- 完了にするのは、受領が確認されたときだけです。');
    expect(instructions).toContain("- 探す: await t.search({ status, assignee, event, text, dueFrom, dueTo })");
    expect(instructions).toContain('- 1 件や数件のタスクを知らせる文を作る: noticeOf(task, { today: \'YYYY-MM-DD\' })');
    expect(instructions).toContain('- 会計への通知は、会計の連絡先にだけ送ります。\n\n## 決まり');
    expect(instructions.indexOf('## 最重要')).toBeLessThan(instructions.indexOf('## 使い方'));
    expect(database.rows("SELECT description FROM skills WHERE name = 'task-management'")).toEqual([{ description: 'タスクを扱うとき。読み書きする scripts/tasks.mjs とその決まりがここにあります。' }]);
    expect(again.instructions).toBe(instructions);
  });

  it('reads タスクのリマインド\'s notice of Tasks named as the product’s, calling noticeOf with what search found', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());
    await folderOf(store, [
      '---', 'name: task-reminder', 'description: 知らせるとき。', '---', '',
      "読むのはスキル task-management（タスクの管理）の scripts/tasks.py です。",
      '',
      "1. await t.reminders(today='依頼に書かれた今日の日付（日本時間、YYYY-MM-DD）', days=(7, 1, 0), report_to='幹事') を呼びます。",
      '',
      '## 見本・過去の行事・タスクを指定して通知を送るとき',
      '',
      '- タスクの title、body、confirmed を書いた dict を tasks.reminder_text に渡します。',
      '',
      '## 送り先の決まり',
      '',
      '- 会計には LINE で送ります。',
    ].join('\n'));

    const { instructions } = await activateSkill(store, 'task-reminder') as { instructions: string };

    expect(instructions).toContain('scripts/tasks.mjs です。');
    expect(instructions).toContain("1. await t.reminders({ today: '依頼に書かれた今日の日付（日本時間、YYYY-MM-DD）', days: [7, 1, 0], reportTo: '幹事' }) を呼びます。");
    expect(instructions).toContain('返った 1 件（か、その配列）をそのまま noticeOf(task');
    expect(instructions).not.toContain('confirmed');
    expect(instructions).toContain('## 送り先の決まり\n\n- 会計には LINE で送ります。');
  });
});

describe('a run’s Skills', () => {
  it('reads the Skills a run names in full, and tells it every Skill as a catalog of name, description, and location', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());
    await folderOf(store, WEEKLY, [['examples/report.md', bytes('今週は…')]]);
    const attendance = await folderOf(store, '---\nname: attendance\ndescription: 出欠の返事が届いたとき。\n---\n\nCount them.');
    const weekly = (await store.db.query.skills.findFirst({ where: (skills, { eq }) => eq(skills.name, 'weekly-report') }))!;

    const told = await runSkills(store, [weekly.id]);

    expect(told.instructions).toContain('# weekly-report（週報）\n\nThis Skill is already activated for this run.\n\nWrite it as examples/report.md shows.');
    expect(told.instructions).toContain('Files of the Skill weekly-report');
    expect(told.instructions).toContain('- examples/report.md');
    expect(told.instructions).toContain('<skill>\n<name>attendance</name>\n<description>出欠の返事が届いたとき。</description>\n<location>/skills/attendance/SKILL.md</location>\n</skill>');
    expect(told.read).toEqual([{ id: weekly.id, revision: 1, files: {
      'SKILL.md': expect.stringMatching(/^[0-9a-f]{64}$/u), 'examples/report.md': expect.stringMatching(/^[0-9a-f]{64}$/u),
    } }]);
    expect(attendance.name).toBe('attendance');
  });

  it('opens a Skill with activate_skill, by its name or its title, and reads its files with read_skill_resource', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());
    await folderOf(store, WEEKLY, [['examples/report.md', bytes('今週は…')], ['logo.png', PNG]]);

    await expect(activateSkill(store, 'weekly-report')).resolves.toMatchObject({
      name: 'weekly-report', title: '週報', location: '/skills/weekly-report/SKILL.md', instructions: 'Write it as examples/report.md shows.', resources: ['examples/report.md', 'logo.png'],
    });
    await expect(activateSkill(store, '週報')).resolves.toMatchObject({ name: 'weekly-report' });
    await expect(readSkillResource(store, 'weekly-report', '/examples\\report.md')).resolves.toEqual({ skill: 'weekly-report', path: 'examples/report.md', content: '今週は…' });
    const image = await readSkillResource(store, 'weekly-report', 'logo.png');
    expect(image).toBeInstanceOf(FileAnswer);
    expect((image as FileAnswer).files).toEqual([{ filename: 'logo.png', mediaType: 'image/png', bytes: PNG }]);
    await expect(readSkillResource(store, 'weekly-report', 'old.md')).resolves.toEqual({
      isError: true, message: 'The Skill weekly-report carries no file "old.md". Its files are: examples/report.md, logo.png.',
    });
    await expect(activateSkill(store, 'nothing')).resolves.toMatchObject({ isError: true });
  });

  it('hands code.run a Skill’s whole directory, every file at its own path', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());
    await folderOf(store, WEEKLY, [['scripts/fill.py', bytes('print(1)\n')]]);

    const directory = await skillDirectory(store, 'weekly-report');

    expect(directory?.name).toBe('weekly-report');
    expect(directory?.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/fill.py']);
    await expect(skillDirectory(store, 'nothing')).resolves.toBeNull();
  });
});

describe('a run that changes a Skill', () => {
  it('writes a text file, puts in a file it wrote, and deletes a file, by the Skill’s name, so the next run reads the change', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());
    await folderOf(store, '---\nname: meeting-papers\ndescription: 例会の次第と案内。\nmetadata:\n  display-name: 例会書類\n---\n\n時候の挨拶は references/greetings.md から選ぶ。\n', [
      ['references/greetings.md', bytes('10月下旬: 紅葉の候\n')],
      ['templates/notice.docx', PNG],
      ['old.md', bytes('使わない')],
    ]);
    const written = bytes('DOCX');
    const generated = async (filename: string) => (filename === 'notice.docx' ? { filename, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: written } : null);

    const call = skillWriteCall('skill.write', { name: ' meeting-papers ', path: 'references/greetings.md', content: '10月下旬: 秋冷の候\n' });
    expect(await performSkillWrite(store, 'skill.write', call)).toMatchObject({ written: true, skill: 'meeting-papers', title: '例会書類', path: 'references/greetings.md' });
    expect(await performSkillWrite(store, 'skill.save_file', skillWriteCall('skill.save_file', { name: '例会書類', path: 'templates/notice.docx', filename: 'out/notice.docx' }), generated))
      .toMatchObject({ written: true, path: 'templates/notice.docx', from: 'notice.docx' });
    expect(await performSkillWrite(store, 'skill.delete_file', skillWriteCall('skill.delete_file', { name: 'meeting-papers', path: 'old.md' })))
      .toMatchObject({ deleted: true, files: ['SKILL.md', 'references/greetings.md', 'templates/notice.docx'] });

    expect(await readSkillResource(store, 'meeting-papers', 'references/greetings.md')).toEqual({ skill: 'meeting-papers', path: 'references/greetings.md', content: '10月下旬: 秋冷の候\n' });
    const skill = await store.db.query.skills.findFirst();
    expect((await skillFile(store, skill?.id ?? '', 'templates/notice.docx')).bytes).toEqual(written);
  });

  it('makes a Skill from its SKILL.md, renames one when its SKILL.md says so, and refuses what it cannot write', async () => {
    database = createMigratedTestD1('organization');
    const store = storeOf(database, createMemoryR2());

    expect(await performSkillWrite(store, 'skill.write', skillWriteCall('skill.write', { name: 'minutes', path: 'skill.md', content: '---\nname: minutes\ndescription: 会議のあと。\n---\n\n要点を三行で。\n' })))
      .toMatchObject({ created: true, skill: 'minutes', path: 'SKILL.md' });
    expect(await performSkillWrite(store, 'skill.write', skillWriteCall('skill.write', { name: 'minutes', path: 'SKILL.md', content: '---\nname: meeting-record\ndescription: 会議のあと。\n---\n\n要点を五行で。\n' })))
      .toMatchObject({ written: true, skill: 'meeting-record' });

    expect(await performSkillWrite(store, 'skill.write', skillWriteCall('skill.write', { name: 'minutes', path: 'notes.md', content: 'x' })))
      .toMatchObject({ isError: true, message: expect.stringContaining('meeting-record') });
    expect(await performSkillWrite(store, 'skill.save_file', skillWriteCall('skill.save_file', { name: 'meeting-record', path: 'a.docx', filename: 'a.docx' })))
      .toMatchObject({ isError: true, message: 'This run holds no files it wrote.' });
    await expect(performSkillWrite(store, 'skill.write', skillWriteCall('skill.write', { name: 'meeting-record', path: 'SKILL.md', content: 'no front matter' }))).rejects.toThrow();
    expect(() => skillWriteCall('skill.delete_file', { name: 'meeting-record', path: 'Skill.md' })).toThrow('SKILL.md is the Skill itself');
    expect(() => skillWriteCall('skill.write', { name: 'meeting-record', path: '../x.md', content: 'x' })).toThrow('requires the path');
    expect(() => skillWriteCall('skill.write', { name: 'meeting-record', path: 'x.md' })).toThrow('requires the content');
  });
});
