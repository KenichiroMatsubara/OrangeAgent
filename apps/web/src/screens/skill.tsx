import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  File as FileIcon,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useBlocker, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import {
  SKILL_INSTRUCTIONS_FILE,
  checkSkillDocument,
  readSkillDocument,
  readSkillFilePath,
  sizeLabel,
  skillDocumentRefusalText,
  skillFileText,
  type Skill,
  type SkillFile,
} from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import {
  NEW_SKILL_DOCUMENT,
  blobOf,
  bytesOf,
  folderName,
  isInstructionsFile,
  isWithin,
  mediaTypeOf,
  namedFolder,
  parentOf,
  readChosen,
  saveFile,
  skillFolders,
  unzipChosen,
  writeFolder,
  zipFolderOf,
  zipFolders,
  type ChosenFile,
  type FolderFile,
  type KeptReader,
} from '../folder';
import { pendingKey, usePendingOperations } from '../pending';
import { momentLabel } from '../time';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Banner, Chip } from '../ui/notice';
import { Note, Page, Section, Toolbar } from '../ui/page';
import styles from './skill.module.css';

export interface SkillData {
  /** Null while a new Skill is being written. */
  skill: Skill | null;
  /** The words of its SKILL.md, which name it and which the page checks as they are written; null when it is not text. */
  document: string | null;
}

/** The address of a Skill not yet saved. */
export const NEW_SKILL = 'new';

/**
 * Reads the one Skill and its SKILL.md, or none for a new one; its folder is
 * edited in place, so it is awaited. Every other file is read when it is opened.
 */
export const loader = async (args: LoaderFunctionArgs): Promise<SkillData> => {
  const skillId = args.params.skillId ?? '';
  if (skillId === NEW_SKILL) return { skill: null, document: NEW_SKILL_DOCUMENT };
  const accountId = await accountIdOf();
  const skill = (await api.skills(accountId)).find((candidate) => candidate.id === skillId);
  if (!skill) throw new Error('このスキルは見つかりませんでした。削除されたかもしれません。');
  const document = await api.skillFile(accountId, skill.id, SKILL_INSTRUCTIONS_FILE);
  return { skill, document: skillFileText(new Uint8Array(await document.arrayBuffer())) };
};

/** What is known of a file's words: still being read, read (null when it is not text), or not readable. */
type Opened = { state: 'loading' } | { state: 'read'; text: string | null } | { state: 'failed'; message: string };

/** What the right-hand pane shows: a file, a folder, or the form that adds one. */
type Selection =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'new'; what: 'file' | 'folder'; parent: string };

/** A folder of the tree: the folders and files directly in it. */
interface TreeFolder {
  path: string;
  name: string;
  folders: TreeFolder[];
  files: SkillFile[];
}

/** Images the browser shows as they are. */
const isImage = (mediaType: string): boolean => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(mediaType);

const baseName = (path: string): string => path.split('/').at(-1) ?? path;

const byName = (left: string, right: string): number => left.localeCompare(right, 'ja');

/**
 * The tree of the folder: every folder a file's path names, and every empty
 * folder made here, folders before files, the SKILL.md first of all.
 */
const treeOf = (files: readonly SkillFile[], emptyFolders: readonly string[], rootName: string): TreeFolder => {
  const root: TreeFolder = { path: '', name: rootName, folders: [], files: [] };
  const folderAt = (path: string): TreeFolder => {
    let current = root;
    for (const segment of path.split('/').filter(Boolean)) {
      const childPath = current.path ? `${current.path}/${segment}` : segment;
      let child = current.folders.find((folder) => folder.path === childPath);
      if (!child) {
        child = { path: childPath, name: segment, folders: [], files: [] };
        current.folders.push(child);
      }
      current = child;
    }
    return current;
  };
  for (const folder of emptyFolders) folderAt(folder);
  for (const file of files) folderAt(parentOf(file.path)).files.push(file);
  const sort = (folder: TreeFolder): void => {
    folder.folders.sort((left, right) => byName(left.name, right.name));
    folder.files.sort((left, right) => Number(isInstructionsFile(right.path)) - Number(isInstructionsFile(left.path)) || byName(left.path, right.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
};

/** A hidden file input the screen's own buttons open. */
const Picker = ({ label, folder = false, single = false, accept, onChoose }: {
  label: string;
  folder?: boolean;
  /** One file only, of any kind. */
  single?: boolean;
  accept?: string;
  onChoose: (files: File[]) => void;
}) => <input
  ref={(input) => {
    // React types no folder picker; every browser this GUI supports reads this attribute.
    if (folder) input?.setAttribute('webkitdirectory', '');
  }}
  type="file"
  className="fc-sr-only"
  tabIndex={-1}
  multiple={!accept && !single}
  accept={accept}
  aria-label={label}
  data-picker={label}
  onChange={(event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...event.target.files ?? []];
    event.target.value = '';
    if (chosen.length) onChoose(chosen);
  }}
/>;

/** Opens the picker labelled so. */
const open = (label: string): void => document.querySelector<HTMLInputElement>(`input[data-picker="${label}"]`)?.click();

const UPLOAD_FILES = 'このフォルダにアップロードするファイル';
const UPLOAD_FOLDER = 'このフォルダにアップロードするフォルダ';
const REPLACE_FOLDER = 'スキルとして読み込むフォルダ';
const REPLACE_ZIP = 'スキルとして読み込む ZIP ファイル';
const REPLACE_FILE = 'このファイルと置き換えるファイル';

/** What kind of file the tree shows a file as. */
const FileGlyph = ({ file }: { file: SkillFile }) => {
  const { mediaType } = file;
  if (isImage(mediaType)) return <FileImage size={18} aria-hidden="true" />;
  if (mediaType.startsWith('text/') || ['application/json', 'application/yaml', 'application/xml', 'application/toml'].includes(mediaType)) return <FileText size={18} aria-hidden="true" />;
  return <FileIcon size={18} aria-hidden="true" />;
};

/** One folder of the tree and everything in it. */
const TreeBranch = ({ folder, depth, selection, closed, changed, onSelect, onToggle }: {
  folder: TreeFolder;
  depth: number;
  selection: Selection | null;
  closed: ReadonlySet<string>;
  changed: (path: string) => boolean;
  onSelect: (selection: Selection) => void;
  onToggle: (path: string) => void;
}) => {
  const isOpen = !closed.has(folder.path);
  const selected = selection?.kind === 'folder' && selection.path === folder.path;
  const indent = { paddingInlineStart: `${8 + depth * 18}px` };
  return <li>
    <div className={selected ? `${styles.node} ${styles.selected}` : styles.node} style={indent}>
      <button type="button" className={styles.toggle} aria-label={`${folder.name} を${isOpen ? '閉じる' : '開く'}`} aria-expanded={isOpen} onClick={() => onToggle(folder.path)}>
        {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button>
      <button type="button" className={styles.nodeButton} aria-current={selected || undefined} onClick={() => onSelect({ kind: 'folder', path: folder.path })}>
        {isOpen ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />}
        <span className={styles.nodeName}>{folder.name}/</span>
      </button>
    </div>
    {isOpen && <ul className={styles.branch}>
      {folder.folders.map((child) => <TreeBranch key={child.path} folder={child} depth={depth + 1} selection={selection} closed={closed} changed={changed} onSelect={onSelect} onToggle={onToggle} />)}
      {folder.files.map((file) => {
        const current = selection?.kind === 'file' && selection.path === file.path;
        return <li key={file.path}>
          <div className={current ? `${styles.node} ${styles.selected}` : styles.node} style={{ paddingInlineStart: `${8 + (depth + 1) * 18 + 24}px` }}>
            <button type="button" className={styles.nodeButton} aria-current={current || undefined} onClick={() => onSelect({ kind: 'file', path: file.path })}>
              <FileGlyph file={file} />
              <span className={styles.nodeName}>{baseName(file.path)}</span>
              {changed(file.path) && <span className={styles.dot} aria-label="未保存" />}
            </button>
          </div>
        </li>;
      })}
    </ul>}
  </li>;
};

/** Renames a file or a folder: its whole path within the Skill, so it can move to another folder too. */
const Rename = ({ path, label, onRename }: { path: string; label: string; onRename: (path: string) => string | null }) => {
  const [draft, setDraft] = useState(path);
  const [error, setError] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const refusal = onRename(draft);
    setError(refusal ?? '');
  };
  return <form className={styles.rename} onSubmit={submit}>
    <Field label={label} hint="「/」で区切るとフォルダの中に移せます。" error={error || undefined}>{(control) => <input {...control} value={draft} onChange={(change) => setDraft(change.target.value)} />}</Field>
    <Button type="submit" variant="secondary" small disabled={draft.trim() === path}>名前を変える</Button>
  </form>;
};

/** A press that asks for a second one before it removes anything. */
const RemoveButton = ({ label, confirm, onRemove }: { label: string; confirm: string; onRemove: () => void }) => {
  const [confirming, setConfirming] = useState(false);
  return confirming
    ? <Button variant="danger" small icon={<Trash2 size={18} aria-hidden="true" />} onClick={onRemove}>{confirm}</Button>
    : <Button variant="quiet" small icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setConfirming(true)}>{label}</Button>;
};

/** What a SKILL.md says, checked as it is written. */
const DocumentCheck = ({ content }: { content: string }) => {
  const checked = checkSkillDocument(content);
  if (!checked.accepted) return <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>{skillDocumentRefusalText(checked.reason)}</Banner>;
  return <dl className={styles.facts}>
    <div><dt>表示名（metadata.display-name）</dt><dd>{checked.title}</dd></div>
    <div><dt>名前（name・フォルダ名）</dt><dd>{checked.name}</dd></div>
    <div><dt>いつ使うか（description）</dt><dd>{checked.description}</dd></div>
  </dl>;
};

/**
 * One Skill as the directory it is: SKILL.md and the files beside it, of
 * whatever kind, in a tree on the left and the file or folder chosen on the
 * right, or one after the other on a phone. It is edited as a directory is: a
 * text file is edited as text and written when it is saved; a file is made,
 * uploaded, replaced, renamed, or deleted at once. A new Skill is made by
 * saving its SKILL.md.
 */
const SkillFolder = ({ skill: loaded, document }: SkillData) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [skill, setSkill] = useState<Skill | null>(loaded);
  const kept: KeptReader = (from) => {
    if (!skill) return Promise.reject(new Error('このファイルはまだ保存されていません。'));
    return api.skillFile(account.accountId, skill.id, from);
  };
  /** Words written here and not yet saved, by path. */
  const [drafts, setDrafts] = useState<Record<string, string>>(() => (loaded ? {} : { [SKILL_INSTRUCTIONS_FILE]: NEW_SKILL_DOCUMENT }));
  /** What was read of each saved file, by path. */
  const [opened, setOpened] = useState<Record<string, Opened>>(() => (loaded ? { [SKILL_INSTRUCTIONS_FILE]: { state: 'read', text: document } } : {}));
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>({ kind: 'file', path: SKILL_INSTRUCTIONS_FILE });
  const [view, setView] = useState<'tree' | 'pane'>('tree');
  const [notice, setNotice] = useState<{ tone: 'warn' | 'danger'; text: string } | null>(null);
  const leaving = useRef(false);
  const key = skill ? pendingKey.skillUpdate(skill.id) : pendingKey.skillCreate;
  const busy = operations.pending(key);
  const removing = skill ? operations.pending(pendingKey.skillDelete(skill.id)) : false;

  const dirty = Object.keys(drafts).length > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const files: SkillFile[] = skill?.files ?? [{ path: SKILL_INSTRUCTIONS_FILE, size: 0, mediaType: 'text/markdown' }];
  /** A file's words as far as they are known: written here, or read when it was opened. */
  const wordsOf = (path: string): string | null | undefined => {
    const draft = drafts[path];
    if (draft !== undefined) return draft;
    const known = opened[path];
    return known?.state === 'read' ? known.text : undefined;
  };
  const documentText = wordsOf(SKILL_INSTRUCTIONS_FILE);
  const statedName = readSkillDocument(documentText ?? '').name?.trim() ?? '';
  const rootName = folderName(skill?.name || statedName || '新しいスキル');
  const tree = treeOf(files, emptyFolders, rootName);
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const changed = (path: string): boolean => drafts[path] !== undefined;
  const currentFolder = selection?.kind === 'folder' ? selection.path
    : selection?.kind === 'file' ? parentOf(selection.path)
      : selection?.kind === 'new' ? selection.parent : '';

  /** Reads a file's words the first time it is opened, or learns that it is not text. */
  const read = (path: string): void => {
    if (!skill || drafts[path] !== undefined || opened[path]) return;
    setOpened((current) => ({ ...current, [path]: { state: 'loading' } }));
    void api.skillFile(account.accountId, skill.id, path).then(
      async (blob) => {
        const text = skillFileText(new Uint8Array(await blob.arrayBuffer()));
        setOpened((current) => ({ ...current, [path]: { state: 'read', text } }));
      },
      (cause: unknown) => setOpened((current) => ({ ...current, [path]: { state: 'failed', message: cause instanceof Error ? cause.message : 'ファイルを読めませんでした。' } })),
    );
  };
  const select = (next: Selection): void => {
    setSelection(next);
    setView('pane');
  };
  // The file chosen is read when it is opened, and again once a change has made what was read of it stale.
  useEffect(() => {
    if (selection?.kind === 'file') read(selection.path);
  });
  const toggle = (path: string): void => setClosed((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const write = (path: string, content: string): void => setDrafts((current) => ({ ...current, [path]: content }));
  /** Forgets what was read of files that changed, so they are read again when opened. */
  const forget = (paths: readonly string[]): void => setOpened((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !paths.includes(path))));
  /** Runs one change of the directory, keeping the Skill as the Worker answers it. */
  const change = (work: (skillId: string) => Promise<Skill | void>): void => {
    if (!skill) return;
    void operations.run(key, async () => {
      const updated = await work(skill.id);
      if (updated) setSkill(updated);
      await revalidator.revalidate();
    });
  };

  /** Reads a path typed here, or says why it cannot name a file of this Skill. */
  const typedPath = (value: string, parent: string): { path: string } | { refusal: string } => {
    const path = readSkillFilePath(parent ? `${parent}/${value}` : value);
    if (path === null) return { refusal: '使えない名前です。「.」や「..」だけのフォルダを含まない名前にしてください。' };
    if (isInstructionsFile(path)) return { refusal: `${SKILL_INSTRUCTIONS_FILE} はもうあります。` };
    return { path };
  };

  /** Writes every text file written here as it now reads; a new Skill is made from its SKILL.md. */
  const save = (): void => void operations.run(key, async () => {
    const written = drafts[SKILL_INSTRUCTIONS_FILE];
    if (written !== undefined) {
      const checked = checkSkillDocument(written);
      if (!checked.accepted) throw new Error(skillDocumentRefusalText(checked.reason));
    }
    if (!skill) {
      const created = await api.createSkill(account.accountId, new Blob([written ?? ''], { type: 'text/markdown' }));
      leaving.current = true;
      navigate(`../skills/${encodeURIComponent(created.id)}`, { replace: true });
      return;
    }
    let updated = skill;
    for (const [path, content] of Object.entries(drafts)) {
      const mediaType = files.find((file) => file.path === path)?.mediaType;
      updated = await api.writeSkillFile(account.accountId, skill.id, path, new Blob([content], mediaType ? { type: mediaType } : {}));
      setOpened((current) => ({ ...current, [path]: { state: 'read', text: content } }));
      setDrafts(({ [path]: _saved, ...rest }) => rest);
    }
    setSkill(updated);
    await revalidator.revalidate();
  });

  const skippedText = (lead: string, skipped: ReadonlyArray<{ path: string; reason: string }>): string =>
    `${lead}: ${skipped.map(({ path, reason }) => `${path}（${reason}）`).join('、')}`;
  /** Writes chosen files into the folder, each as its bytes; one of the same name is written over. */
  const upload = (chosen: readonly ChosenFile[]): void => {
    const { files: taken, skipped } = readChosen(chosen);
    setNotice(skipped.length ? { tone: 'warn', text: skippedText('置かなかったファイルがあります', skipped) } : null);
    change(async (skillId) => {
      let updated: Skill | undefined;
      for (const file of taken) updated = await api.writeSkillFile(account.accountId, skillId, file.path, await blobOf(file, kept));
      forget(taken.map((file) => file.path));
      return updated;
    });
  };
  const uploadFiles = (chosen: File[]): void => upload(chosen.map((file) => ({ path: currentFolder ? `${currentFolder}/${file.name}` : file.name, file })));
  const uploadFolder = (chosen: File[]): void => upload(chosen.map((file) => {
    const relative = file.webkitRelativePath || file.name;
    return { path: currentFolder ? `${currentFolder}/${relative}` : relative, file };
  }));
  const replaceFile = (path: string, chosen: File): void => change(async (skillId) => {
    const updated = await api.writeSkillFile(account.accountId, skillId, path, chosen);
    setDrafts(({ [path]: _replaced, ...rest }) => rest);
    forget([path]);
    return updated;
  });

  /** Copies one Skill folder read from elsewhere over this one. */
  const replaceWith = async (chosen: readonly ChosenFile[], fallback: string): Promise<void> => {
    const { files: taken, skipped } = readChosen(chosen);
    const { folders, outside } = skillFolders(taken);
    const [found] = folders;
    if (!found) {
      setNotice({ tone: 'danger', text: `${SKILL_INSTRUCTIONS_FILE} が入っていません。スキルのフォルダを選んでください。` });
      return;
    }
    if (folders.length > 1) {
      setNotice({ tone: 'danger', text: `スキルが ${folders.length} 個入っています。まとめて読み込むときは、スキルの一覧の「読み込む」から読み込んでください。` });
      return;
    }
    const named = await namedFolder(found, fallback);
    const left = [...skipped, ...outside.map((path) => ({ path, reason: 'スキルのフォルダの外にあります' }))];
    setNotice(left.length ? { tone: 'warn', text: skippedText('読み込まなかったファイルがあります', left) } : null);
    change(async () => {
      const updated = await writeFolder(account.accountId, skill, named.files);
      setDrafts({});
      setOpened({ [SKILL_INSTRUCTIONS_FILE]: { state: 'read', text: named.document } });
      setEmptyFolders([]);
      setSelection({ kind: 'file', path: SKILL_INSTRUCTIONS_FILE });
      return updated;
    });
  };
  const replaceFromFolder = (chosen: File[]): void => void replaceWith(chosen.map((file) => ({ path: file.webkitRelativePath || file.name, file })), rootName);
  const replaceFromZip = (chosen: File[]): void => {
    const [zip] = chosen;
    if (!zip) return;
    void unzipChosen(zip)
      .then((entries) => replaceWith(entries, zip.name.replace(/\.zip$/iu, '')))
      .catch((cause: unknown) => setNotice({ tone: 'danger', text: cause instanceof Error ? cause.message : 'ZIP ファイルを読めませんでした。' }));
  };

  /** The folder as it reads now, the words written here included. */
  const current = (): FolderFile[] => files.map((file) => {
    const draft = drafts[file.path];
    return draft === undefined ? { path: file.path, body: { kind: 'kept', from: file.path, size: file.size, mediaType: file.mediaType } } : { path: file.path, body: { kind: 'written', content: draft } };
  });
  const exportZip = (): void => void operations.run(`${key}:zip`, async () => {
    saveFile(zipFolders([await zipFolderOf(rootName, current(), kept)]), `${rootName}.zip`, 'application/zip');
  });
  const download = (path: string): void => void operations.run(`${key}:download`, async () => {
    const file = current().find((candidate) => candidate.path === path);
    if (file) saveFile(await bytesOf(file.body, kept), baseName(path), mediaTypeOf(file));
  });

  const create = (event: FormEvent, what: 'file' | 'folder', parent: string, value: string): void => {
    event.preventDefault();
    const typed = typedPath(value, parent);
    if ('refusal' in typed) {
      setNotice({ tone: 'danger', text: typed.refusal });
      return;
    }
    setNotice(null);
    setClosed((current_) => new Set([...current_].filter((path) => !isWithin(typed.path, path))));
    if (what === 'folder') {
      setEmptyFolders((current_) => [...new Set([...current_, typed.path])]);
      setSelection({ kind: 'folder', path: typed.path });
      return;
    }
    if (files.some((file) => file.path === typed.path)) {
      select({ kind: 'file', path: typed.path });
      return;
    }
    change(async (skillId) => {
      const updated = await api.writeSkillFile(account.accountId, skillId, typed.path, new Blob([]));
      setOpened((current_) => ({ ...current_, [typed.path]: { state: 'read', text: '' } }));
      setSelection({ kind: 'file', path: typed.path });
      return updated;
    });
  };

  /** Moves a file or a folder, and what was written of it here with it. */
  const move = (from: string, to: string, folder: boolean): void => change(async (skillId) => {
    const updated = await api.moveSkillFiles(account.accountId, skillId, { from, to });
    const moved = (path: string): string => (isWithin(path, from) ? `${to}${path.slice(from.length)}` : path);
    setDrafts((current_) => Object.fromEntries(Object.entries(current_).map(([path, content]) => [moved(path), content])));
    setOpened((current_) => Object.fromEntries(Object.entries(current_).map(([path, state]) => [moved(path), state])));
    setEmptyFolders((current_) => current_.map(moved));
    setSelection({ kind: folder ? 'folder' : 'file', path: to });
    return updated;
  });
  const renameFile = (path: string, value: string): string | null => {
    const typed = typedPath(value, '');
    if ('refusal' in typed) return typed.refusal;
    if (typed.path !== path && files.some((other) => other.path === typed.path)) return `「${typed.path}」はもうあります。`;
    if (typed.path !== path) move(path, typed.path, false);
    return null;
  };
  const renameFolder = (folder: string, value: string): string | null => {
    const typed = typedPath(value, '');
    if ('refusal' in typed) return typed.refusal;
    if (isWithin(typed.path, folder)) return typed.path === folder ? null : 'フォルダをその中には移せません。';
    if (!files.some((file) => isWithin(file.path, folder))) {
      setEmptyFolders((current_) => current_.map((path) => (isWithin(path, folder) ? `${typed.path}${path.slice(folder.length)}` : path)));
      setSelection({ kind: 'folder', path: typed.path });
      return null;
    }
    move(folder, typed.path, true);
    return null;
  };
  const removeFiles = (paths: readonly string[], then: Selection): void => change(async (skillId) => {
    let updated: Skill | undefined;
    for (const path of paths) updated = await api.removeSkillFile(account.accountId, skillId, path);
    setDrafts((current_) => Object.fromEntries(Object.entries(current_).filter(([path]) => !paths.includes(path))));
    forget(paths);
    setSelection(then);
    return updated;
  });
  const removeFolder = (folder: string): void => {
    setEmptyFolders((current_) => current_.filter((path) => !isWithin(path, folder)));
    const inside = files.filter((file) => isWithin(file.path, folder)).map((file) => file.path);
    if (inside.length) removeFiles(inside, { kind: 'folder', path: parentOf(folder) });
    else setSelection({ kind: 'folder', path: parentOf(folder) });
  };
  const remove = (): void => {
    if (!skill) return;
    void operations.run(pendingKey.skillDelete(skill.id), async () => {
      await api.removeSkill(account.accountId, skill.id);
      leaving.current = true;
      navigate('../skills', { replace: true });
    });
  };

  const selectedFile = selection?.kind === 'file' ? files.find((file) => file.path === selection.path) ?? null : null;
  const back = <button type="button" className={styles.backToTree} onClick={() => setView('tree')}><ArrowLeft size={18} aria-hidden="true" />フォルダに戻る</button>;

  const contents = (file: SkillFile): ReactNode => {
    const words = wordsOf(file.path);
    const state = drafts[file.path] === undefined ? opened[file.path] : undefined;
    if (state?.state === 'failed') return <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{state.message}</Banner>;
    if (words === undefined) return <Note>読み込んでいます…</Note>;
    if (words !== null) {
      return <Field label={`${file.path} の中身`}>{(control) => <textarea
        {...control}
        className={`${control.className} ${styles.editor}`}
        value={words}
        spellCheck={false}
        onChange={(event) => write(file.path, event.target.value)}
      />}</Field>;
    }
    return <>
      {isImage(file.mediaType) && skill && <img className={styles.preview} src={api.skillFileUrl(account.accountId, skill.id, file.path)} alt={file.path} />}
      <Note>テキストではないファイルです（{file.mediaType}）。そのまま置かれ、AI はこのファイルを開くと、ファイルそのものを受け取ります。</Note>
    </>;
  };

  const pane = ((): ReactNode => {
    if (selection?.kind === 'new') {
      return <NewEntry key={`${selection.what}:${selection.parent}`} what={selection.what} parent={selection.parent} rootName={rootName} onCreate={create} />;
    }
    if (selectedFile) {
      const isDocument = isInstructionsFile(selectedFile.path);
      return <div className={styles.paneBody}>
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}><FileGlyph file={selectedFile} />{rootName}/{selectedFile.path}</h2>
          <span className={styles.paneMeta}>{sizeLabel(selectedFile.size)}{changed(selectedFile.path) && <Chip tone="warn">未保存</Chip>}</span>
        </div>
        {isDocument && <Note>スキルの説明そのものです。先頭の「---」で挟んだ name: がスキルの名前、description: がいつ使うかで、その下がやり方です。AI はこのスキルを使うとき、やり方をそのまま読みます。</Note>}
        {contents(selectedFile)}
        {isDocument && documentText !== undefined && <DocumentCheck content={documentText ?? ''} />}
        {skill && <>
          <Toolbar>
            <Button variant="secondary" small icon={<Download size={18} aria-hidden="true" />} onClick={() => download(selectedFile.path)}>ダウンロード</Button>
            <Button variant="secondary" small icon={<RefreshCw size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(REPLACE_FILE)}>別のファイルに置き換える</Button>
          </Toolbar>
          <Picker label={REPLACE_FILE} single onChoose={([chosen]) => { if (chosen) replaceFile(selectedFile.path, chosen); }} />
          {!isDocument && <>
            <Rename key={selectedFile.path} path={selectedFile.path} label="ファイル名" onRename={(value) => renameFile(selectedFile.path, value)} />
            <Toolbar><RemoveButton key={selectedFile.path} label={`${baseName(selectedFile.path)} を削除`} confirm="本当に削除する" onRemove={() => removeFiles([selectedFile.path], { kind: 'folder', path: parentOf(selectedFile.path) })} /></Toolbar>
          </>}
        </>}
      </div>;
    }
    const folder = selection?.kind === 'folder' ? selection.path : '';
    const inside = files.filter((file) => !isInstructionsFile(file.path) && isWithin(file.path, folder));
    return <div className={styles.paneBody}>
      <div className={styles.paneHeader}>
        <h2 className={styles.paneTitle}><FolderOpen size={20} aria-hidden="true" />{rootName}/{folder && `${folder}/`}</h2>
        <span className={styles.paneMeta}>ファイル{inside.length}件</span>
      </div>
      {folder === ''
        ? <Note>{SKILL_INSTRUCTIONS_FILE} がスキルの名前・いつ使うか・やり方で、ほかのファイルは見本・雛形・スクリプト・画像・資料など、やり方から名前で指すファイルです。どんな種類のファイルでもそのまま置けます。AI は必要なときに名前で開いて読みます。</Note>
        : inside.length === 0 && <Note>空のフォルダは残りません。ファイルを作るかアップロードしてください。</Note>}
      {skill && <>
        <Toolbar>
          <Button variant="secondary" small icon={<FilePlus size={18} aria-hidden="true" />} onClick={() => setSelection({ kind: 'new', what: 'file', parent: folder })}>新しいファイル</Button>
          <Button variant="secondary" small icon={<FolderPlus size={18} aria-hidden="true" />} onClick={() => setSelection({ kind: 'new', what: 'folder', parent: folder })}>新しいフォルダ</Button>
          <Button variant="secondary" small icon={<Upload size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(UPLOAD_FILES)}>ファイルをアップロード</Button>
          <Button variant="secondary" small icon={<FolderUp size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(UPLOAD_FOLDER)}>フォルダをアップロード</Button>
        </Toolbar>
        {folder !== '' && <>
          <Rename key={folder} path={folder} label="フォルダ名" onRename={(value) => renameFolder(folder, value)} />
          <Toolbar><RemoveButton key={folder} label={`${baseName(folder)} フォルダを削除`} confirm={inside.length ? `中の${inside.length}件ごと削除する` : '本当に削除する'} onRemove={() => removeFolder(folder)} /></Toolbar>
        </>}
      </>}
    </div>;
  })();

  return <Page
    title={skill?.title || skill?.name || statedName || '新しいスキル'}
    lead={skill ? `${momentLabel(skill.updatedAt)}に更新。ファイルは作る・置く・名前を変える・削除するとすぐに、書いたテキストは保存したときに、そのまま書き換わります。` : 'SKILL.md に名前とやり方を書いて保存すると、スキルができます。ほかのファイルはそのあとで置けます。'}
    back={{ to: '../skills', label: 'スキル' }}
    actions={<Button busy={busy} disabled={removing || (skill !== null && !dirty)} icon={<Save size={18} aria-hidden="true" />} onClick={save}>{busy ? '保存しています…' : dirty || !skill ? '保存する' : '保存済み'}</Button>}
  >
    {blocker.state === 'blocked' && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />} action={<Toolbar>
      <Button variant="secondary" small onClick={() => blocker.reset()}>この画面に残る</Button>
      <Button variant="danger" small onClick={() => blocker.proceed()}>保存せずに移る</Button>
    </Toolbar>}>保存していない変更があります。</Banner>}
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {notice && <Banner tone={notice.tone} icon={<CircleAlert size={18} aria-hidden="true" />}>{notice.text}</Banner>}
    <div className={styles.explorer} data-view={view}>
      <nav className={styles.tree} aria-label="スキルのフォルダ">
        {skill && <div className={styles.treeTools}>
          <Button variant="quiet" small icon={<FilePlus size={18} aria-hidden="true" />} onClick={() => select({ kind: 'new', what: 'file', parent: currentFolder })}>ファイル</Button>
          <Button variant="quiet" small icon={<FolderPlus size={18} aria-hidden="true" />} onClick={() => select({ kind: 'new', what: 'folder', parent: currentFolder })}>フォルダ</Button>
          <Button variant="quiet" small icon={<Upload size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(UPLOAD_FILES)}>アップロード</Button>
        </div>}
        <ul className={styles.root}>
          <TreeBranch folder={tree} depth={0} selection={selection} closed={closed} changed={changed} onSelect={select} onToggle={toggle} />
        </ul>
        <p className={styles.usage}>ファイル {files.length} ・ {sizeLabel(bytes)}</p>
      </nav>
      <section className={styles.pane} aria-label="開いているファイル">
        {back}
        {pane}
      </section>
    </div>
    <Picker label={UPLOAD_FILES} onChoose={uploadFiles} />
    <Picker label={UPLOAD_FOLDER} folder onChoose={uploadFolder} />
    <Picker label={REPLACE_FOLDER} folder onChoose={replaceFromFolder} />
    <Picker label={REPLACE_ZIP} accept=".zip,application/zip" onChoose={replaceFromZip} />
    {skill && <Section title="フォルダごと" lead="Claude の Agent Skills と同じ形のフォルダ（SKILL.md とファイル）を、そのまま読み込んだり書き出したりできます。読み込むと、このスキルのファイルが読み込んだフォルダのとおりに書き換わります。">
      <Toolbar>
        <Button variant="secondary" small icon={<FolderOpen size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(REPLACE_FOLDER)}>フォルダから読み込む</Button>
        <Button variant="secondary" small icon={<Upload size={18} aria-hidden="true" />} disabled={busy} onClick={() => open(REPLACE_ZIP)}>ZIP から読み込む</Button>
        <Button variant="secondary" small icon={<Download size={18} aria-hidden="true" />} onClick={exportZip}>ZIP で書き出す</Button>
      </Toolbar>
      <Toolbar><RemoveButton label="このスキルを削除" confirm={removing ? '削除しています…' : '本当に削除する'} onRemove={remove} /></Toolbar>
    </Section>}
  </Page>;
};

/** The form that names a new file or folder inside the folder it was asked from. */
const NewEntry = ({ what, parent, rootName, onCreate }: {
  what: 'file' | 'folder';
  parent: string;
  rootName: string;
  onCreate: (event: FormEvent, what: 'file' | 'folder', parent: string, name: string) => void;
}) => {
  const [name, setName] = useState('');
  return <form className={styles.paneBody} onSubmit={(event) => onCreate(event, what, parent, name)}>
    <div className={styles.paneHeader}>
      <h2 className={styles.paneTitle}>{what === 'file' ? <FilePlus size={20} aria-hidden="true" /> : <FolderPlus size={20} aria-hidden="true" />}{what === 'file' ? '新しいファイル' : '新しいフォルダ'}</h2>
    </div>
    <Note>{rootName}/{parent && `${parent}/`} の中に作ります。</Note>
    <Field label={what === 'file' ? 'ファイル名' : 'フォルダ名'} hint={what === 'file' ? '例: report.md、examples/report.md' : '例: examples'}>{(control) => <input {...control} value={name} autoFocus onChange={(change) => setName(change.target.value)} />}</Field>
    <Toolbar><Button type="submit" small disabled={!name.trim()}>作る</Button></Toolbar>
  </form>;
};

const SkillScreen = () => {
  const { skill, document } = useLoaderData<SkillData>();
  return <SkillFolder key={skill?.id ?? NEW_SKILL} skill={skill} document={document} />;
};

export default SkillScreen;
