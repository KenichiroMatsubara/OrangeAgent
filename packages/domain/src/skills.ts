import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * The file at the top of a Skill's folder that names it, says when it
 * applies, and holds its instructions, as Claude's Agent Skills write it.
 */
export const SKILL_INSTRUCTIONS_FILE = 'SKILL.md';

export type SkillFolderRefusal =
  | { reason: 'path'; path: string }
  | { reason: 'duplicate_path'; path: string }
  | { reason: 'no_instructions_file' };

export type SkillFolderResult<T> = { accepted: true; files: T[] } | ({ accepted: false } & SkillFolderRefusal);

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Reads the path a file is named by within its Skill: `/` separates folders,
 * a `\` is read as one, and empty segments are dropped. A segment `.` or `..`
 * names no file of the Skill, so the path is refused, as is a control
 * character. Returns null when the path cannot name a file.
 */
export const readSkillFilePath = (value: string): string | null => {
  if (CONTROL_CHARACTERS.test(value)) return null;
  const segments = value.replaceAll('\\', '/').split('/').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
};

/** Whether a path within a Skill's folder is its SKILL.md, at the top, however its case is written. */
export const isSkillInstructionsPath = (path: string): boolean => path.toLowerCase() === SKILL_INSTRUCTIONS_FILE.toLowerCase();

const byPath = (left: { path: string }, right: { path: string }): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

/**
 * Checks a Skill's folder as one set: a SKILL.md at its top and each path read
 * once, however many files it holds and however large each is. Returns the
 * files in path order, SKILL.md named as Claude's Agent Skills name it.
 */
export const checkSkillFolder = <T extends { path: string; size: number }>(files: readonly T[]): SkillFolderResult<T> => {
  const read: T[] = [];
  for (const file of files) {
    const named = readSkillFilePath(file.path);
    if (named === null) return { accepted: false, reason: 'path', path: file.path };
    const path = isSkillInstructionsPath(named) ? SKILL_INSTRUCTIONS_FILE : named;
    if (read.some((other) => other.path === path)) return { accepted: false, reason: 'duplicate_path', path };
    read.push({ ...file, path });
  }
  if (!read.some((file) => file.path === SKILL_INSTRUCTIONS_FILE)) return { accepted: false, reason: 'no_instructions_file' };
  return { accepted: true, files: read.sort(byPath) };
};

/** A size as the Account reads it. */
export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} MB`;
};

/** What the Account is told when a Skill's folder is refused. */
export const skillFolderRefusalText = (refusal: SkillFolderRefusal): string => {
  switch (refusal.reason) {
    case 'path': return `ファイル名「${refusal.path}」は使えません。制御文字や、「.」や「..」だけのフォルダを含まない名前にしてください。`;
    case 'duplicate_path': return `「${refusal.path}」という名前のファイルが二つあります。`;
    case 'no_instructions_file': return `フォルダのいちばん上に ${SKILL_INSTRUCTIONS_FILE} がありません。`;
  }
};

/** The media type each kind of file a Skill commonly carries is kept under, by its extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  xml: 'application/xml', xsd: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript', sql: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

/**
 * The media type a Skill's file is kept under: the one its extension names,
 * else the one it was given, else plain bytes. SKILL.md is always Markdown.
 */
export const skillFileType = (path: string, given?: string): string => {
  const extension = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase() ?? '';
  const named = MEDIA_TYPES[extension];
  if (named) return named;
  const stated = given?.split(';')[0]?.trim().toLowerCase() ?? '';
  return MEDIA_TYPE.test(stated) ? stated : 'application/octet-stream';
};

/** The words of a file when it is UTF-8 text, or null when it is some other kind of file. */
export const skillFileText = (bytes: Uint8Array): string | null => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text.replace(/^\uFEFF/u, '');
  } catch {
    return null;
  }
};

/**
 * What a SKILL.md says, as the Agent Skills specification (agentskills.io)
 * reads it: the Skill's name, which is its directory's, when it applies, its
 * instructions, and the string map `metadata`, where OrangeAgent keeps the
 * Skill's title in the words a person reads it by (`display-name`).
 */
export interface SkillDocument {
  name: string;
  description: string;
  /** The name a person reads, such as タスクの管理; the name itself when the Skill gives none. */
  title: string;
  instructions: string;
  metadata?: Readonly<Record<string, string>>;
}

/** What a SKILL.md read from a folder states; a field its front matter leaves out is null. */
export interface ReadSkillDocument {
  name: string | null;
  description: string | null;
  title: string | null;
  instructions: string;
  metadata: Readonly<Record<string, string>>;
}

export type SkillDocumentRefusal =
  | 'no_front_matter'
  | 'unreadable_front_matter'
  | 'no_name'
  | 'bad_name'
  | 'no_description'
  | 'long_description'
  | 'no_instructions';

export type SkillDocumentResult = ({ accepted: true } & SkillDocument) | { accepted: false; reason: SkillDocumentRefusal };

/** The key of `metadata` OrangeAgent keeps a Skill's title under. */
export const SKILL_TITLE_KEY = 'display-name';

/** The most characters a Skill's name and description may hold, as the specification sets them. */
export const SKILL_NAME_LIMIT = 64;
export const SKILL_DESCRIPTION_LIMIT = 1024;

/** A name the specification allows: lowercase letters, digits, and single hyphens, neither first nor last. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Whether a name is one a Skill may have, which is also its directory's. */
export const isSkillName = (name: string): boolean => name.length <= SKILL_NAME_LIMIT && SKILL_NAME.test(name);

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null);

/** The string map `metadata` holds, every value read as a string as the specification has it. */
const metadataOf = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const text = textOf(entry);
    return text === null ? [] : [[key, text]];
  }));
};

/** The front matter as YAML reads it, or null when it is not a mapping YAML can read. */
const frontMatterOf = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = parseYaml(text);
    if (value === null || value === undefined) return {};
    return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/**
 * Writes a Skill as its SKILL.md: front matter naming it, saying when it
 * applies, and keeping its title in `metadata`, then its instructions.
 */
export const writeSkillDocument = (skill: SkillDocument): string => {
  const metadata = { ...(skill.metadata ?? {}), ...(skill.title && skill.title !== skill.name ? { [SKILL_TITLE_KEY]: skill.title } : {}) };
  const front = stringifyYaml({ name: skill.name, description: skill.description, ...(Object.keys(metadata).length ? { metadata } : {}) }, { lineWidth: 0 });
  return `---\n${front}---\n\n${skill.instructions.trim()}\n`;
};

/**
 * Reads a SKILL.md: what its front matter states and the instructions below
 * it. Text with no front matter, or front matter YAML cannot read, is
 * instructions alone.
 */
export const readSkillDocument = (text: string): ReadSkillDocument => {
  const match = FRONT_MATTER.exec(text);
  const fields = match ? frontMatterOf(match[1] ?? '') : null;
  if (!match || !fields) return { name: null, description: null, title: null, instructions: text.replace(/^\uFEFF/u, '').trim(), metadata: {} };
  const metadata = metadataOf(fields.metadata);
  return {
    name: textOf(fields.name),
    description: textOf(fields.description),
    title: metadata[SKILL_TITLE_KEY] ?? null,
    instructions: text.slice(match[0].length).trim(),
    metadata,
  };
};

/** Reads a SKILL.md as a Skill the specification allows, or says what it lacks. */
export const checkSkillDocument = (text: string): SkillDocumentResult => {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { accepted: false, reason: 'no_front_matter' };
  if (!frontMatterOf(match[1] ?? '')) return { accepted: false, reason: 'unreadable_front_matter' };
  const read = readSkillDocument(text);
  const name = read.name ?? '';
  const description = read.description ?? '';
  if (!name) return { accepted: false, reason: 'no_name' };
  if (!isSkillName(name)) return { accepted: false, reason: 'bad_name' };
  if (!description) return { accepted: false, reason: 'no_description' };
  if (description.length > SKILL_DESCRIPTION_LIMIT) return { accepted: false, reason: 'long_description' };
  if (!read.instructions) return { accepted: false, reason: 'no_instructions' };
  return { accepted: true, name, description, title: read.title || name, instructions: read.instructions, metadata: read.metadata };
};

/** What the Account is told when a SKILL.md cannot be saved as a Skill. */
export const skillDocumentRefusalText = (reason: SkillDocumentRefusal): string => {
  switch (reason) {
    case 'no_front_matter': return `${SKILL_INSTRUCTIONS_FILE} の先頭に、「---」の行で挟んで name: と description: を書いてください。`;
    case 'unreadable_front_matter': return `${SKILL_INSTRUCTIONS_FILE} の先頭の「---」で挟んだ部分を YAML として読めません。書き方を確かめてください。`;
    case 'no_name': return `${SKILL_INSTRUCTIONS_FILE} の先頭に name: でスキルの名前を書いてください。`;
    case 'bad_name': return `name: は英小文字・数字・ハイフンで ${SKILL_NAME_LIMIT} 字以内にしてください（例: task-reminder）。画面に出す日本語の名前は metadata: の ${SKILL_TITLE_KEY}: に書きます。`;
    case 'no_description': return `${SKILL_INSTRUCTIONS_FILE} の先頭に description: で、どんなときに使うスキルかを書いてください。`;
    case 'long_description': return `description: は ${SKILL_DESCRIPTION_LIMIT} 字以内にしてください。`;
    case 'no_instructions': return `${SKILL_INSTRUCTIONS_FILE} の「---」の下に、やり方を書いてください。`;
  }
};
