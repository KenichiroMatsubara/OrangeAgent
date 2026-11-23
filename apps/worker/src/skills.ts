/**
 * The Skills a run thinks with, as the Agent Skills specification
 * (agentskills.io) has them (ADR 0203).
 *
 * A Skill is a directory: a SKILL.md at its top whose front matter names it
 * and says when it applies and whose body is its instructions, beside any
 * files those instructions point to — scripts, templates, references,
 * images. Its name is lowercase letters, digits, and hyphens, and is its
 * directory's name: it is kept in R2 at `skills/{account}/{name}/{path}`, one
 * object per file under its own media type, and is edited as a directory is,
 * a file at a time. D1 holds only the Skill's name, its title (the name a
 * person reads, `metadata.display-name`), its description, and which
 * directory is its; a run records the digest of every file it read.
 *
 * A run is told every Skill of the Account as a catalog of its name,
 * description, and location, and reads one with `activate_skill` when it
 * applies, and any file of it with `read_skill_resource`. An Automation's
 * named Skills are read in full from its start. `code.run` places a Skill's
 * directory at `/skills/<name>/` as it is, so a script it carries runs from
 * the path its SKILL.md gives.
 *
 * A Skill written before this was kept under its id, in the folder of its
 * revision, or as rows of D1; it is moved to its directory the first time
 * it is read, because a migration cannot write to R2.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  SKILL_INSTRUCTIONS_FILE,
  checkSkillDocument,
  checkSkillFolder,
  isSkillInstructionsPath,
  readSkillDocument,
  readSkillFilePath,
  skillDocumentRefusalText,
  skillFileText,
  skillFileType,
  skillFolderRefusalText,
  writeSkillDocument,
  type Skill,
  type SkillFile,
} from '@mail/domain';

import { now } from './clock';
import { encodeText, toArrayBuffer, toBase64 } from './encoding';
import { conflict, invalid, notFound } from './refusal';
import type { AccountDatabase } from './storage/database';
import { automationSkills, skillFiles, skillRevisions, skills } from './storage/account-schema';
import type { MailFile } from './providers';
import { INTAKE_SKILL_NAME, REMINDER_SKILL, REMINDER_SKILL_NAME, TASK_PROGRAM, TASK_PROGRAM_PATH, TASK_SKILL, TASK_SKILL_NAME } from './starter';
import { FileAnswer } from './turns';

/** Where one Account's Skills are named, and where their directories are kept. */
export interface SkillStore {
  db: AccountDatabase;
  bucket: R2Bucket;
  accountId: string;
}

/** One Skill a run was started with, and every file it read of it, by path, as the SHA-256 of the bytes it read. */
export interface SkillRead {
  id: string;
  revision: number;
  files: Record<string, string>;
}

/** What a run is told of the Account's Skills, and which of them it was started with. */
export interface RunSkills {
  instructions: string;
  read: SkillRead[];
}

/** A file of a Skill's directory, with the digest of its bytes, which a run records as what it read. */
interface KeptFile extends SkillFile {
  sha256: string;
}

/** One file to be written into a directory. */
interface FolderFile {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

interface SkillRow {
  id: string;
  name: string;
  title: string;
  description: string;
  revision: number;
  directory: string | null;
}

const SKILL_ROW = { id: skills.id, name: skills.name, title: skills.title, description: skills.description, revision: skills.revision, directory: skills.directory };

/** Where a code.run container finds a Skill's directory. */
export const skillLocation = (name: string): string => `/skills/${name}/${SKILL_INSTRUCTIONS_FILE}`;

const directoryPrefix = (store: SkillStore, directory: string): string => `skills/${store.accountId}/${directory}/`;
/** Where a Skill written before ADR 0203 kept its folders: under its id. */
const legacyPrefix = (store: SkillStore, skillId: string): string => `skills/${store.accountId}/${skillId}/`;

const digest = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const byPath = (left: { path: string }, right: { path: string }): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

/** Every object under a prefix, as R2 lists them a page at a time. */
const listed = async (store: SkillStore, prefix: string): Promise<R2Object[]> => {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.bucket.list({ prefix, include: ['httpMetadata', 'customMetadata'], ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
};

/** Removes every object under a prefix. */
const discard = async (store: SkillStore, prefix: string): Promise<void> => {
  const keys = (await listed(store, prefix)).map((object) => object.key);
  for (let start = 0; start < keys.length; start += 1000) await store.bucket.delete(keys.slice(start, start + 1000));
};

/** Writes one file at a prefix as its bytes, under its media type and with the digest a run records. */
const putAt = async (store: SkillStore, prefix: string, file: FolderFile): Promise<void> => {
  await store.bucket.put(`${prefix}${file.path}`, file.bytes, {
    httpMetadata: { contentType: file.mediaType },
    customMetadata: { sha256: await digest(file.bytes) },
  });
};

/** Every file under a prefix, in path order. */
const filesAt = async (store: SkillStore, prefix: string): Promise<KeptFile[]> =>
  (await listed(store, prefix)).map((object) => {
    const path = object.key.slice(prefix.length);
    return { path, size: object.size, mediaType: object.httpMetadata?.contentType ?? skillFileType(path), sha256: object.customMetadata?.sha256 ?? '' };
  }).sort(byPath);

const bytesAt = async (store: SkillStore, prefix: string, path: string): Promise<Uint8Array | null> => {
  const object = await store.bucket.get(`${prefix}${path}`);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
};

/**
 * The files of a Skill written before ADR 0203: the folder its current
 * revision names, or, for a revision kept as rows, its words written as a
 * SKILL.md and its text files.
 */
const legacyFiles = async (store: SkillStore, skill: SkillRow): Promise<FolderFile[]> => {
  const row = await store.db.select({ folder: skillRevisions.folder, instructions: skillRevisions.instructions }).from(skillRevisions)
    .where(and(eq(skillRevisions.skillId, skill.id), eq(skillRevisions.revision, skill.revision))).get();
  if (row?.folder) {
    const prefix = `${legacyPrefix(store, skill.id)}${row.folder}/`;
    const files: FolderFile[] = [];
    for (const file of await filesAt(store, prefix)) {
      const bytes = await bytesAt(store, prefix, file.path);
      if (bytes) files.push({ path: file.path, bytes, mediaType: file.mediaType });
    }
    return files;
  }
  const texts = await store.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles)
    .where(and(eq(skillFiles.skillId, skill.id), eq(skillFiles.revision, skill.revision))).all();
  return [
    { path: SKILL_INSTRUCTIONS_FILE, bytes: encodeText(writeSkillDocument({ name: skill.name, title: skill.title, description: skill.description, instructions: row?.instructions ?? '' })), mediaType: skillFileType(SKILL_INSTRUCTIONS_FILE) },
    ...texts.map((file) => ({ path: file.path, bytes: encodeText(file.content), mediaType: skillFileType(file.path) })),
  ];
};

/** One section of a SKILL.md's instructions, from its heading to the next heading of its level or above, or null when it has none so titled. */
const sectionOf = (text: string, title: string): { start: number; end: number } | null => {
  const heading = new RegExp(`^(#{1,6})[ \\t]+${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[ \\t]*$`, 'mu').exec(text);
  if (!heading) return null;
  const level = heading[1]?.length ?? 2;
  const after = heading.index + heading[0].length;
  const next = new RegExp(`^#{1,${level}}[ \\t]`, 'mu').exec(text.slice(after));
  return { start: heading.index, end: next ? after + next.index : text.length };
};

/** The words of one section of a product's Skill, or null when it has none so titled. */
const productSection = (source: string, title: string): string | null => {
  const found = sectionOf(source, title);
  return found ? source.slice(found.start, found.end).trimEnd() : null;
};

/**
 * A SKILL.md's instructions with each section titled so replaced by the
 * product's, every other word the Account wrote staying. `keeping` reads the
 * section the Account kept and says which of its lines to keep below the
 * product's words. A section the instructions lack is added at their end
 * when `adding` says so.
 */
const withSections = (instructions: string, source: string, titles: readonly string[], options: { adding?: readonly string[]; keeping?: (title: string, kept: string) => string[] } = {}): string => {
  let text = instructions.trimEnd();
  for (const title of titles) {
    const words = productSection(source, title);
    if (!words) continue;
    const kept = sectionOf(text, title);
    if (!kept) {
      if (options.adding?.includes(title)) text = `${text}\n\n${words}`;
      continue;
    }
    const lines = options.keeping?.(title, text.slice(kept.start, kept.end)) ?? [];
    const section = lines.length ? `${words}\n${lines.join('\n')}` : words;
    text = `${text.slice(0, kept.start)}${section}\n\n${text.slice(kept.end).trimStart()}`.trimEnd();
  }
  return text;
};

/** The sections of タスクの管理 that say how tasks.py is loaded, which ADR 0203 changed, and nothing else of it. */
const LOADING_SECTIONS = ['読み込み方', 'コードを実行できないとき'];

/**
 * タスクの管理 as the Account kept it, with only the sections that loaded
 * tasks.py from Claude's sandbox, which no run holds any longer, replaced by
 * the product's sections as they now are, so every step and rule the
 * Account added to it stays. One whose sections cannot be found has the
 * product's loading section added after it.
 */
const upgradedTaskSkill = (instructions: string): string => {
  const found = LOADING_SECTIONS.some((title) => sectionOf(instructions, title));
  return withSections(instructions, TASK_SKILL, LOADING_SECTIONS, found ? {} : { adding: ['読み込み方'] });
};

/**
 * The Skills that call タスクの管理's program, whose words a run reads as they
 * now must when it moved to JavaScript. A function, not a Set built as the
 * module loads: starter.ts reaches this module through its own imports, and
 * the one that loads first sees the other's names still undefined.
 */
const isProgramSkill = (name: string): boolean => name === TASK_SKILL_NAME || name === REMINDER_SKILL_NAME || name === INTAKE_SKILL_NAME;

/** The program as it was, before it was a module a Dynamic Worker imports. */
const PYTHON_PROGRAM = 'tasks.py';
const PYTHON_PROGRAM_PATH = `scripts/${PYTHON_PROGRAM}`;

/** The sections of タスクの管理 that describe its program, which are the product's as they now are. */
const PROGRAM_SECTIONS = ['読み込み方', '使い方', 'コードを実行できないとき'];

/** The lines the product wrote in タスクの管理's 使い方 while it was Python, told apart from what an Account added there. */
const FORMER_USAGE = ['- 探す:', '- 登録する:', '- 変える:', '- 完了:', '- 担当者に知らせる:', '- 担当者の名前は連絡先と照合されます', '- ツールが断ったとき'];

/** The section of タスクのリマインド that sends a notice of Tasks named, which is the product's as it now is. */
const NAMED_NOTICE = '見本・過去の行事・タスクを指定して通知を送るとき';

/** The words of the starting Skills that called the Python program, as they now are for its module. */
const JAVASCRIPT_WORDS: ReadonlyArray<[RegExp, string | ((...parts: string[]) => string)]> = [
  [/(?:tasks\.)?reminder_text/gu, 'noticeOf'],
  [/t\.reminders\(today=('[^']*'), days=\(([^)]*)\), report_to=([^)]*?)\)/gu, (_, today = '', days = '', to = '') => `t.reminders({ today: ${today}, days: [${days}], reportTo: ${to.replace(/\bNone\b/gu, 'null')} })`],
  [/t\.search\(event='([^']*)'\)/gu, (_, event = '') => `t.search({ event: '${event}' })`],
  [/t\.search\(all_lists=True\)/gu, 't.search({ allLists: true })'],
  [/なければ None）/gu, 'なければ null）'],
  [/tasks\.py/gu, 'tasks.mjs'],
];

const inJavaScript = (text: string): string =>
  JAVASCRIPT_WORDS.reduce((words, [pattern, written]) => words.replace(pattern, written as (substring: string, ...parts: string[]) => string), text);

/** The lines an Account added to 使い方, below the product's: every line but the product's own, and the blank ones. */
const addedUsage = (title: string, kept: string): string[] => title !== '使い方' ? [] : kept.split('\n').slice(1)
  .filter((line) => line.trim() && !FORMER_USAGE.some((former) => line.startsWith(former)));

/**
 * A starting Skill's instructions as they now are for the program's module:
 * タスクの管理's sections on its program are the product's, keeping any line
 * an Account added to 使い方; タスクのリマインド's notice of Tasks named is
 * the product's, added when it has none; and the calls written for Python
 * read as JavaScript's, every other word the Account wrote staying.
 */
export const javaScriptInstructions = (name: string, instructions: string): string => {
  const sectioned = name === TASK_SKILL_NAME
    ? withSections(instructions, TASK_SKILL, PROGRAM_SECTIONS, { adding: ['読み込み方'], keeping: addedUsage })
    : name === REMINDER_SKILL_NAME ? withSections(instructions, REMINDER_SKILL, [NAMED_NOTICE], { adding: [NAMED_NOTICE] }) : instructions;
  return inJavaScript(sectioned);
};

/**
 * The instructions of a Skill written before ADR 0203, read as they now
 * must be: another Skill is opened with activate_skill and named by its new
 * name, and タスクの管理 loads tasks.py as it now must (`upgradedTaskSkill`).
 */
const upgradedInstructions = (skill: SkillRow, instructions: string, renamed: ReadonlyArray<{ title: string; name: string }>): string => {
  const loaded = skill.name === TASK_SKILL_NAME && instructions.includes('__tasks.py') ? upgradedTaskSkill(instructions) : instructions;
  let text = loaded.replaceAll('skill.read', 'activate_skill');
  for (const { title, name } of renamed) text = text.replaceAll(`スキル「${title}」`, `スキル ${name}（${title}）`);
  return text;
};

/** Where a file of a Skill written before ADR 0203 goes in its directory: the product's tasks.py among its scripts. */
const upgradedPath = (skill: SkillRow, path: string): string =>
  skill.name === TASK_SKILL_NAME && path === 'tasks.py' ? 'scripts/tasks.py' : path;

/**
 * Moves a Skill written before ADR 0203 to its directory: every file is
 * written under `skills/{account}/{name}/`, its SKILL.md stating its new name
 * and its title, and the directory is recorded. The files it was kept as are
 * left as they are.
 */
const moveIn = async (store: SkillStore, skill: SkillRow): Promise<string> => {
  const files = await legacyFiles(store, skill);
  const renamed = (await store.db.select({ title: skills.title, name: skills.name }).from(skills).all())
    .filter((row) => row.title && row.title !== row.name);
  const prefix = directoryPrefix(store, skill.name);
  for (const file of files) {
    if (!isSkillInstructionsPath(file.path)) {
      await putAt(store, prefix, { ...file, path: upgradedPath(skill, file.path) });
      continue;
    }
    const read = readSkillDocument(skillFileText(file.bytes) ?? '');
    const document = writeSkillDocument({
      name: skill.name,
      title: skill.title || read.title || skill.name,
      description: skill.description || read.description || skill.title,
      instructions: upgradedInstructions(skill, read.instructions, renamed),
      metadata: read.metadata,
    });
    await putAt(store, prefix, { path: SKILL_INSTRUCTIONS_FILE, bytes: encodeText(document), mediaType: skillFileType(SKILL_INSTRUCTIONS_FILE) });
  }
  await store.db.update(skills).set({ directory: skill.name }).where(and(eq(skills.id, skill.id), isNull(skills.directory))).run();
  return skill.name;
};

/** The directory a Skill's files are in, moving a Skill written before ADR 0203 there first. */
const directoryOf = async (store: SkillStore, skill: SkillRow): Promise<string> => skill.directory ?? moveIn(store, skill);

/**
 * Moves a starting Skill that called the Python program to its module, the
 * first time it is read after the program became one: its SKILL.md is
 * rewritten as `javaScriptInstructions` has it, and タスクの管理 is given
 * `scripts/tasks.mjs` beside the tasks.py it kept, which stays as it was.
 * A Skill that names tasks.py nowhere, and holds tasks.mjs where it holds
 * tasks.py, is left as it is.
 */
const movedToJavaScript = async (store: SkillStore, skill: SkillRow, prefix: string, files: KeptFile[]): Promise<KeptFile[]> => {
  if (!isProgramSkill(skill.name)) return files;
  const bytes = await bytesAt(store, prefix, SKILL_INSTRUCTIONS_FILE);
  const text = bytes ? skillFileText(bytes) : null;
  if (text === null) return files;
  const lacking = skill.name === TASK_SKILL_NAME && files.some((file) => file.path === PYTHON_PROGRAM_PATH) && !files.some((file) => file.path === TASK_PROGRAM_PATH);
  if (!text.includes(PYTHON_PROGRAM) && !lacking) return files;
  const read = readSkillDocument(text);
  const description = inJavaScript(read.description ?? skill.description);
  const document = writeSkillDocument({
    name: skill.name,
    title: read.title || skill.title || skill.name,
    description,
    instructions: javaScriptInstructions(skill.name, read.instructions),
    metadata: read.metadata,
  });
  if (skill.name === TASK_SKILL_NAME && !files.some((file) => file.path === TASK_PROGRAM_PATH)) {
    await putAt(store, prefix, { path: TASK_PROGRAM_PATH, bytes: encodeText(TASK_PROGRAM), mediaType: skillFileType(TASK_PROGRAM_PATH) });
  }
  await putAt(store, prefix, { path: SKILL_INSTRUCTIONS_FILE, bytes: encodeText(document), mediaType: skillFileType(SKILL_INSTRUCTIONS_FILE) });
  if (description !== skill.description) await store.db.update(skills).set({ description }).where(eq(skills.id, skill.id)).run();
  return filesAt(store, prefix);
};

/** A Skill's directory and every file in it. */
const opened = async (store: SkillStore, skill: SkillRow): Promise<{ prefix: string; files: KeptFile[] }> => {
  const prefix = directoryPrefix(store, await directoryOf(store, skill));
  return { prefix, files: await movedToJavaScript(store, skill, prefix, await filesAt(store, prefix)) };
};

const otherPaths = (files: readonly SkillFile[]): string[] => files.map((file) => file.path).filter((path) => path !== SKILL_INSTRUCTIONS_FILE);

/** The instructions a directory's SKILL.md holds below its front matter. */
const instructionsAt = async (store: SkillStore, prefix: string): Promise<string> => {
  const bytes = await bytesAt(store, prefix, SKILL_INSTRUCTIONS_FILE);
  return readSkillDocument(bytes ? skillFileText(bytes) ?? '' : '').instructions;
};

const view = (row: typeof skills.$inferSelect, files: readonly KeptFile[]): Skill => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  title: row.title || row.name,
  description: row.description,
  files: files.map(({ path, size, mediaType }) => ({ path, size, mediaType })),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const rowOf = async (store: SkillStore, skillId: string): Promise<typeof skills.$inferSelect> => {
  const row = await store.db.select().from(skills).where(eq(skills.id, skillId)).get();
  if (!row) throw notFound('Skill was not found.');
  return row;
};

/** Every Skill of the Account, each as its directory holds it. */
export const listSkills = async (store: SkillStore): Promise<Skill[]> => {
  const rows = await store.db.select().from(skills).orderBy(asc(skills.name)).all();
  return Promise.all(rows.map(async (row) => view(row, (await opened(store, row)).files)));
};

/** One Skill as its directory holds it. */
export const skillOf = async (store: SkillStore, skillId: string): Promise<Skill> => {
  const row = await rowOf(store, skillId);
  return view(row, (await opened(store, row)).files);
};

/** One file of a Skill's directory, as it is kept. */
export const skillFile = async (store: SkillStore, skillId: string, path: string): Promise<{ path: string; mediaType: string; bytes: Uint8Array }> => {
  const row = await rowOf(store, skillId);
  const named = readSkillFilePath(path);
  const { prefix, files } = await opened(store, row);
  const file = files.find((candidate) => candidate.path === named);
  const bytes = file ? await bytesAt(store, prefix, file.path) : null;
  if (!file || !bytes) throw notFound(`このスキルに「${path}」というファイルはありません。`);
  return { path: file.path, mediaType: file.mediaType, bytes };
};

/** What a SKILL.md states, or why it cannot be a Skill's. */
const statedBy = (bytes: Uint8Array): { name: string; title: string; description: string } => {
  const text = skillFileText(bytes);
  if (text === null) throw invalid(`${SKILL_INSTRUCTIONS_FILE} は UTF-8 のテキストにしてください。`);
  const stated = checkSkillDocument(text);
  if (!stated.accepted) throw invalid(skillDocumentRefusalText(stated.reason));
  return { name: stated.name, title: stated.title, description: stated.description };
};

const takenName = (name: string): ReturnType<typeof conflict> =>
  conflict(`「${name}」という名前のスキルがもうあります。SKILL.md の name: を変えてください。`);

/** Refuses a name another Skill of the Account already has, or the directory of one. */
const assertNameFree = async (store: SkillStore, name: string, skillId: string | null): Promise<void> => {
  const named = await store.db.select({ id: skills.id }).from(skills).where(eq(skills.name, name)).get();
  if (named && named.id !== skillId) throw takenName(name);
  const holding = await store.db.select({ id: skills.id }).from(skills).where(eq(skills.directory, name)).get();
  if (holding && holding.id !== skillId) throw takenName(name);
};

/** A file path sent to name a file of a Skill, or why it cannot be one. */
const pathOf = (value: string): string => {
  const path = readSkillFilePath(value);
  if (path === null) throw invalid(`「${value}」はスキルのファイルの名前にできません。「.」や「..」だけのフォルダを含まない名前にしてください。`);
  return path;
};

const touched = (store: SkillStore, skillId: string): Promise<unknown> =>
  store.db.update(skills).set({ updatedAt: now() }).where(eq(skills.id, skillId)).run();

/**
 * Makes a Skill from its SKILL.md, whose front matter names it and says when
 * it applies. Its directory takes its name. Every other file is written into
 * it afterwards, one at a time.
 */
export const createSkill = async (store: SkillStore, document: Uint8Array): Promise<Skill> => {
  const stated = statedBy(document);
  await assertNameFree(store, stated.name, null);
  const skillId = crypto.randomUUID();
  const prefix = directoryPrefix(store, stated.name);
  await putAt(store, prefix, { path: SKILL_INSTRUCTIONS_FILE, bytes: document, mediaType: skillFileType(SKILL_INSTRUCTIONS_FILE) });
  const timestamp = now();
  try {
    await store.db.insert(skills).values({
      id: skillId, accountId: store.accountId, name: stated.name, title: stated.title, description: stated.description,
      instructions: '', revision: 1, directory: stated.name, createdAt: timestamp, updatedAt: timestamp,
    }).run();
  } catch (error) {
    await discard(store, prefix);
    if (error instanceof Error && error.message.includes('skills.name')) throw takenName(stated.name);
    throw error;
  }
  return skillOf(store, skillId);
};

/**
 * Moves a renamed Skill's directory to its new name, a file at a time, each
 * written at its new key before it leaves its old one, so none is lost.
 */
const moveDirectory = async (store: SkillStore, from: string, to: string): Promise<void> => {
  const source = directoryPrefix(store, from);
  const target = directoryPrefix(store, to);
  for (const file of await filesAt(store, source)) {
    const bytes = await bytesAt(store, source, file.path);
    if (!bytes) continue;
    await putAt(store, target, { path: file.path, bytes, mediaType: file.mediaType });
    await store.bucket.delete(`${source}${file.path}`);
  }
};

/**
 * Writes one file of a Skill as the bytes sent, over whatever the file held:
 * a Skill is edited as its directory is, a file at a time. Writing SKILL.md
 * renames the Skill, and moves its directory to the new name, or changes its
 * title or when it applies, as its front matter says.
 */
export const writeSkillFile = async (store: SkillStore, input: { skillId: string; path: string; bytes: Uint8Array; mediaType?: string }): Promise<Skill> => {
  const path = pathOf(input.path);
  const row = await rowOf(store, input.skillId);
  const { prefix, files } = await opened(store, row);
  const file: FolderFile = { path, bytes: input.bytes, mediaType: skillFileType(path, input.mediaType) };
  const checked = checkSkillFolder([...files.filter((kept) => kept.path !== path), { path, size: input.bytes.byteLength }]);
  if (!checked.accepted) throw invalid(skillFolderRefusalText(checked));
  if (path !== SKILL_INSTRUCTIONS_FILE) {
    await putAt(store, prefix, file);
    await touched(store, row.id);
    return skillOf(store, row.id);
  }
  const stated = statedBy(input.bytes);
  await assertNameFree(store, stated.name, row.id);
  const directory = row.directory ?? row.name;
  if (stated.name !== directory) await moveDirectory(store, directory, stated.name);
  const before = await bytesAt(store, directoryPrefix(store, stated.name), SKILL_INSTRUCTIONS_FILE);
  await putAt(store, directoryPrefix(store, stated.name), file);
  try {
    await store.db.update(skills).set({ name: stated.name, title: stated.title, description: stated.description, directory: stated.name, updatedAt: now() }).where(eq(skills.id, row.id)).run();
  } catch (error) {
    // The index still names the Skill as before, so its directory and SKILL.md are put back.
    if (before) await putAt(store, directoryPrefix(store, stated.name), { ...file, bytes: before });
    if (stated.name !== directory) await moveDirectory(store, stated.name, directory);
    if (error instanceof Error && error.message.includes('skills.name')) throw takenName(stated.name);
    throw error;
  }
  return skillOf(store, row.id);
};

/** Deletes one file of a Skill. SKILL.md is the Skill itself and is not deleted. */
export const removeSkillFile = async (store: SkillStore, input: { skillId: string; path: string }): Promise<Skill> => {
  const path = pathOf(input.path);
  if (path === SKILL_INSTRUCTIONS_FILE) throw invalid(`${SKILL_INSTRUCTIONS_FILE} はスキルそのものなので削除できません。スキルごと削除してください。`);
  const row = await rowOf(store, input.skillId);
  const { prefix, files } = await opened(store, row);
  if (!files.some((file) => file.path === path)) throw notFound(`このスキルに「${path}」というファイルはありません。`);
  await store.bucket.delete(`${prefix}${path}`);
  await touched(store, row.id);
  return skillOf(store, row.id);
};

/**
 * Moves a file, or a folder and everything in it, to another path of the same
 * Skill, as renaming it does. Nothing already at a path it would take is
 * written over, and SKILL.md stays where it is.
 */
export const moveSkillFiles = async (store: SkillStore, input: { skillId: string; from: string; to: string }): Promise<Skill> => {
  const from = pathOf(input.from);
  const to = pathOf(input.to);
  const row = await rowOf(store, input.skillId);
  const { prefix, files } = await opened(store, row);
  if (from === to) return view(row, files);
  const moving = files.filter((file) => file.path === from || file.path.startsWith(`${from}/`));
  if (!moving.length) throw notFound(`このスキルに「${from}」はありません。`);
  if (moving.some((file) => file.path === SKILL_INSTRUCTIONS_FILE) || to === SKILL_INSTRUCTIONS_FILE) throw invalid(`${SKILL_INSTRUCTIONS_FILE} は動かせません。`);
  if (to.startsWith(`${from}/`)) throw invalid('フォルダをその中には移せません。');
  const moved = (path: string): string => `${to}${path.slice(from.length)}`;
  const staying = files.filter((file) => !moving.includes(file));
  const taken = moving.map((file) => moved(file.path)).find((path) => staying.some((file) => file.path === path));
  if (taken) throw conflict(`「${taken}」はもうあります。`);
  const checked = checkSkillFolder([...staying, ...moving.map((file) => ({ path: moved(file.path), size: file.size }))]);
  if (!checked.accepted) throw invalid(skillFolderRefusalText(checked));
  // One file at a time: each is written at its new path before it leaves its old one, so none is ever lost.
  for (const file of moving) {
    const bytes = await bytesAt(store, prefix, file.path);
    if (!bytes) continue;
    await putAt(store, prefix, { path: moved(file.path), bytes, mediaType: file.mediaType });
    await store.bucket.delete(`${prefix}${file.path}`);
  }
  await touched(store, row.id);
  return skillOf(store, row.id);
};

/** Removes every file a deleted Skill had: its directory, and the folders it was kept in before ADR 0203. */
export const discardSkillFolders = async (store: SkillStore, skill: { id: string; directory: string | null }): Promise<void> => {
  if (skill.directory) await discard(store, directoryPrefix(store, skill.directory));
  await discard(store, legacyPrefix(store, skill.id));
};

/** The Skills an Automation names, in the order its runs read them. */
export const automationSkillIds = async (db: AccountDatabase, automationId: string): Promise<string[]> =>
  (await db.select({ id: automationSkills.skillId }).from(automationSkills)
    .where(eq(automationSkills.automationId, automationId)).orderBy(asc(automationSkills.position)).all()).map(({ id }) => id);

const escaped = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** One Skill in the catalog a run is told, as the specification's integration guide lists it. */
const catalogEntry = (skill: SkillRow): string => [
  '<skill>',
  `<name>${escaped(skill.name)}</name>`,
  `<description>${escaped(skill.description.trim() || skill.title)}</description>`,
  `<location>${skillLocation(skill.name)}</location>`,
  '</skill>',
].join('\n');

/** What a run is told of the files beside a Skill's SKILL.md. */
const resourcesNote = (name: string, files: readonly KeptFile[]): string => {
  const paths = otherPaths(files);
  if (!paths.length) return '';
  return [
    `Files of the Skill ${name}, by their paths in its directory. Read one with read_skill_resource; to run a script or open a template, place the Skill with code.run (skills: ["${name}"]), where it is at /skills/${name}/ as it is.`,
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
};

/** How a run is told to use the catalog. */
const CATALOG_GUIDE = [
  'The Skills this Account holds are listed below. Each states how the Account wants a kind of work done.',
  'When the work matches a Skill\'s description, call activate_skill with its name before you act, and follow what it says. Read a file it points to with read_skill_resource, or place the Skill with code.run to run its scripts from their paths, relative to the Skill\'s directory.',
].join(' ');

/**
 * What a run is told: the Skills it names, in full and in order, then the
 * catalog of every Skill of the Account. A Skill it names that no longer
 * exists stops the run rather than leaving it to think without it.
 */
export const runSkills = async (store: SkillStore, skillIds: readonly string[]): Promise<RunSkills> => {
  const all = await store.db.select(SKILL_ROW).from(skills).orderBy(asc(skills.name)).all();
  const named = skillIds.flatMap((id) => all.filter((skill) => skill.id === id));
  if (named.length !== skillIds.length) throw new Error('A Skill this run names was not found.');
  const sections: string[] = [];
  const read: SkillRead[] = [];
  // One Skill's directory at a time.
  for (const skill of named) {
    const { prefix, files } = await opened(store, skill);
    read.push({ id: skill.id, revision: skill.revision, files: Object.fromEntries(files.map((file) => [file.path, file.sha256])) });
    sections.push([`# ${skill.name}（${skill.title || skill.name}）`, 'This Skill is already activated for this run.', await instructionsAt(store, prefix), resourcesNote(skill.name, files)].filter(Boolean).join('\n\n'));
  }
  const catalog = all.length ? [CATALOG_GUIDE, '<available_skills>', ...all.map(catalogEntry), '</available_skills>'].join('\n') : '';
  return { instructions: [...sections, catalog].filter(Boolean).join('\n\n'), read };
};

/** A Skill named as a run names it: by its name, or by the title a person reads. */
const skillNamed = async (store: SkillStore, wanted: string): Promise<SkillRow | null> =>
  await store.db.select(SKILL_ROW).from(skills).where(eq(skills.name, wanted)).get()
    ?? await store.db.select(SKILL_ROW).from(skills).where(eq(skills.title, wanted)).get()
    ?? null;

const unknownSkill = async (store: SkillStore, wanted: string): Promise<{ isError: true; message: string }> => {
  const names = (await store.db.select({ name: skills.name }).from(skills).orderBy(asc(skills.name)).all()).map((row) => row.name);
  return { isError: true, message: `No Skill is named ${JSON.stringify(wanted)}. This Account's Skills are: ${names.join(', ') || '(none)'}.` };
};

/** `activate_skill`: one Skill's instructions in full, with where it is and the files it carries. */
export const activateSkill = async (store: SkillStore, name: string): Promise<unknown> => {
  const wanted = name.trim();
  const skill = await skillNamed(store, wanted);
  if (!skill) return unknownSkill(store, wanted);
  const { prefix, files } = await opened(store, skill);
  return {
    name: skill.name,
    title: skill.title || skill.name,
    description: skill.description,
    location: skillLocation(skill.name),
    instructions: await instructionsAt(store, prefix),
    resources: otherPaths(files),
    ...(otherPaths(files).length ? { note: `Read a resource with read_skill_resource, or place this Skill with code.run (skills: ["${skill.name}"]) to run its scripts from /skills/${skill.name}/.` } : {}),
  };
};

/**
 * `read_skill_resource`: one file of a Skill, by its path in the Skill's
 * directory: its words when it is text, and otherwise the file itself,
 * handed over beside the answer as a mail's attachment is.
 */
export const readSkillResource = async (store: SkillStore, name: string, path: string): Promise<unknown> => {
  const wanted = name.trim();
  const skill = await skillNamed(store, wanted);
  if (!skill) return unknownSkill(store, wanted);
  const { prefix, files } = await opened(store, skill);
  const file = files.find((candidate) => candidate.path === readSkillFilePath(path));
  const bytes = file ? await bytesAt(store, prefix, file.path) : null;
  if (!file || !bytes) {
    return { isError: true, message: `The Skill ${skill.name} carries no file ${JSON.stringify(path.trim())}. Its files are: ${otherPaths(files).join(', ') || '(none)'}.` };
  }
  const text = skillFileText(bytes);
  if (text === null) {
    return new FileAnswer(
      { skill: skill.name, path: file.path, mediaType: file.mediaType, size: file.size, content: 'The file itself is handed to you beside this answer.' },
      [{ filename: file.path.split('/').at(-1) ?? file.path, mediaType: file.mediaType, bytes }],
    );
  }
  return { skill: skill.name, path: file.path, content: text };
};

/** Every file of a Skill's directory as its bytes, for code.run to place at `/skills/<name>/`; null when no Skill is so named. */
export const skillDirectory = async (store: SkillStore, name: string): Promise<{ name: string; files: Array<{ path: string; bytes: Uint8Array }> } | null> => {
  const skill = await skillNamed(store, name.trim());
  if (!skill) return null;
  const { prefix, files } = await opened(store, skill);
  const read: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const file of files) {
    const bytes = await bytesAt(store, prefix, file.path);
    if (bytes) read.push({ path: file.path, bytes });
  }
  return { name: skill.name, files: read };
};

/** A file of a published Skill, as an MCP prompt embeds it: its words when it is text, else its bytes as base64. */
export type PublishedFile = { path: string; mediaType: string; text: string } | { path: string; mediaType: string; blob: string };

/** A published Skill's SKILL.md instructions and its other files, read when an outside agent asks for the prompt. */
export const publishedSkill = async (store: SkillStore, skillId: string): Promise<{ instructions: string; files: PublishedFile[] }> => {
  const skill = await store.db.select(SKILL_ROW).from(skills).where(eq(skills.id, skillId)).get();
  if (!skill) throw notFound('Skill was not found.');
  const { prefix, files } = await opened(store, skill);
  const others = await Promise.all(files.filter((file) => file.path !== SKILL_INSTRUCTIONS_FILE).map(async (file): Promise<PublishedFile> => {
    const bytes = await bytesAt(store, prefix, file.path) ?? new Uint8Array();
    const text = skillFileText(bytes);
    // MCP's protocol embeds a resource that is not text as base64; it is the protocol's, not FlareChat's, encoding.
    return text === null ? { path: file.path, mediaType: file.mediaType, blob: toBase64(bytes) } : { path: file.path, mediaType: file.mediaType, text };
  }));
  return { instructions: await instructionsAt(store, prefix), files: others };
};

/** Reads the Skills an Automation is to start its runs with: at least one, each once, in order. */
export const skillIdsOf = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw invalid('Name at least one Skill by its id.');
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
};

/** Refuses Skills that are not this Account's. */
export const assertSkills = async (db: AccountDatabase, skillIds: readonly string[]): Promise<void> => {
  const found = await db.select({ id: skills.id }).from(skills).where(inArray(skills.id, [...skillIds])).all();
  if (found.length !== new Set(skillIds).size) throw conflict('Every Skill named must be one of this Account’s.');
};

/** The writes a run makes to the Account's Skills: a file written as text, a file the run holds put in, or a file deleted. */
export type SkillWriteName = 'skill.write' | 'skill.save_file' | 'skill.delete_file';

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Reads one Skill write's arguments, the same way whether it is performed now
 * or planned and performed later, refusing with a reason the model can correct.
 * A path is read as a Skill's file path is everywhere, and SKILL.md however its
 * case is written.
 */
export const skillWriteCall = (name: SkillWriteName, input: Record<string, unknown>): Record<string, unknown> => {
  const skill = trimmed(input.name);
  if (!skill) throw new Error(`${name} requires the Skill's name, as the catalog names it, or for a new Skill the name its SKILL.md states.`);
  const read = readSkillFilePath(trimmed(input.path));
  if (read === null) throw new Error(`${name} requires the path of a file of the Skill, such as SKILL.md or scripts/notice.py, with no "." or ".." folder.`);
  const path = isSkillInstructionsPath(read) ? SKILL_INSTRUCTIONS_FILE : read;
  switch (name) {
    case 'skill.write':
      if (typeof input.content !== 'string') throw new Error('skill.write requires the content the file is to hold, in full.');
      return { name: skill, path, content: input.content };
    case 'skill.save_file': {
      const filename = trimmed(input.filename).split('/').at(-1) ?? '';
      if (!filename) throw new Error('skill.save_file requires the filename of a file you wrote, as code.run named it.');
      return { name: skill, path, filename };
    }
    case 'skill.delete_file':
      if (path === SKILL_INSTRUCTIONS_FILE) throw new Error(`${SKILL_INSTRUCTIONS_FILE} is the Skill itself and is not deleted.`);
      return { name: skill, path };
  }
};

/** What a Skill holds after a write, as the run is told it. */
const written = (skill: Skill, change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...change, skill: skill.name, title: skill.title, description: skill.description, files: skill.files.map((file) => file.path) });

/**
 * Performs one Skill write, already read by `skillWriteCall`. A Skill is named
 * as the catalog names it; writing the SKILL.md of a name the Account does not
 * hold makes that Skill. `generated` reads the latest file the run wrote under
 * a name, for a run that holds such files.
 */
export const performSkillWrite = async (
  store: SkillStore,
  name: SkillWriteName,
  call: Record<string, unknown>,
  generated?: (filename: string) => Promise<MailFile | null>,
): Promise<unknown> => {
  const wanted = String(call.name);
  const path = String(call.path);
  const row = await skillNamed(store, wanted);
  if (!row) {
    if (name === 'skill.write' && path === SKILL_INSTRUCTIONS_FILE) return written(await createSkill(store, encodeText(String(call.content))), { created: true, path });
    const names = (await store.db.select({ name: skills.name }).from(skills).orderBy(asc(skills.name)).all()).map((skill) => skill.name);
    return {
      isError: true,
      message: `No Skill is named ${JSON.stringify(wanted)}. This Account's Skills are: ${names.join(', ') || '(none)'}. To make a new Skill, write its ${SKILL_INSTRUCTIONS_FILE} first.`,
    };
  }
  switch (name) {
    case 'skill.write':
      return written(await writeSkillFile(store, { skillId: row.id, path, bytes: encodeText(String(call.content)) }), { written: true, path });
    case 'skill.save_file': {
      if (!generated) return { isError: true, message: 'This run holds no files it wrote.' };
      const filename = String(call.filename);
      const file = await generated(filename);
      if (!file) return { isError: true, message: `${filename} is not a file you wrote in this conversation. Name one exactly as code.run named it.` };
      return written(await writeSkillFile(store, { skillId: row.id, path, bytes: file.bytes, mediaType: file.mediaType }), { written: true, path, from: filename });
    }
    case 'skill.delete_file':
      return written(await removeSkillFile(store, { skillId: row.id, path }), { deleted: true, path });
  }
};
