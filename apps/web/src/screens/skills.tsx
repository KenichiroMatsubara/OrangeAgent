import { CircleAlert, Download, Folder, FolderOpen, Plus, Upload } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { useLoaderData, useRevalidator } from 'react-router-dom';

import type { Skill } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { checkFolder, folderName, keptFolder, namedFolder, readChosen, saveFile, skillFolders, unzipChosen, writeFolder, zipFolderOf, zipFolders, type ChosenFile, type FolderFile, type FolderResult } from '../folder';
import { pendingKey, usePendingOperations } from '../pending';
import { Button, ButtonLink } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Check, CheckGroup } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner, Chip, Empty } from '../ui/notice';
import { Note, Page, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import { NEW_SKILL } from './skill';

export interface SkillsData {
  skills: Promise<Skill[]>;
}

/** Returns at once; the Skills fill in as they are read. */
export const loader = async (): Promise<SkillsData> => ({ skills: later(api.skills(await accountIdOf())) });

/**
 * Which Skills a rule or an Automation starts every run with, in the order
 * they were chosen. Every other Skill is still read when its description fits.
 */
export const SkillChecks = ({ skills, value, onChange, hint }: {
  skills: readonly Skill[];
  value: readonly string[];
  onChange: (skillIds: string[]) => void;
  hint?: string;
}) => skills.length === 0
  ? <Note>先に「スキル」の画面でスキルを作ってください。</Note>
  : <CheckGroup legend="使うスキル" showLegend>
    {hint && <Note>{hint}</Note>}
    {skills.map((skill) => <Check
      key={skill.id}
      label={skill.title}
      sub={skill.description || undefined}
      checked={value.includes(skill.id)}
      onChange={(checked) => onChange(checked ? [...value.filter((id) => id !== skill.id), skill.id] : value.filter((id) => id !== skill.id))}
    />)}
  </CheckGroup>;

/** One Skill folder found among what the Account chose, and what reading it in would do. */
interface Found {
  folder: string;
  files: FolderFile[];
  read: FolderResult;
  /** The Skill of the same name it replaces, if one exists. */
  existing: Skill | null;
  /** 'done' once read in, or why it could not be. */
  outcome: string | null;
}

/**
 * What reading one folder in comes to: a word or two for its chip, the
 * sentence that explains it, shown whole where it can be read and copied, and
 * whether 読み込む writes it.
 */
const plan = (found: Found): { state: string; tone: 'neutral' | 'brand' | 'muted' | 'danger'; detail: string | null; reads: boolean } => {
  if (found.outcome === 'done') return { state: '読み込みました', tone: 'muted', detail: null, reads: false };
  if (found.outcome) return { state: '失敗しました', tone: 'danger', detail: found.outcome, reads: true };
  if (!found.read.accepted) return { state: '読み込めません', tone: 'danger', detail: found.read.message, reads: false };
  if (!found.existing) return { state: '新しく作ります', tone: 'brand', detail: null, reads: true };
  return { state: '書き換えます', tone: 'neutral', detail: '同じ名前のスキルのファイルを、このフォルダのとおりに書き換えます。', reads: true };
};

const FOLDERS = '読み込むスキルのフォルダ';
const ZIP = '読み込むスキルの ZIP ファイル';

/**
 * Reads one Skill folder or many — a folder, or a ZIP file such as this
 * screen writes — and says before anything is saved which Skills it makes
 * and which it replaces: a folder whose SKILL.md names a Skill this Account
 * already has is copied over that Skill's files.
 */
const SkillImport = ({ skills, onClose }: { skills: readonly Skill[]; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [found, setFound] = useState<Found[] | null>(null);
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);
  const busy = operations.pending(pendingKey.skillImport);

  const read = async (chosen: readonly ChosenFile[], fallback: string): Promise<void> => {
    const files = readChosen(chosen);
    const { folders, outside } = skillFolders(files.files);
    setFound(await Promise.all(folders.map(async (folder): Promise<Found> => {
      const named = await namedFolder(folder, fallback);
      const result = checkFolder(named.files, named.document);
      const existing = result.accepted ? skills.find((skill) => skill.name === result.name) ?? null : null;
      return { folder: folder.folder || fallback, files: named.files, read: result, existing, outcome: null };
    })));
    setSkipped([...files.skipped, ...outside.map((path) => ({ path, reason: 'スキルのフォルダの外にあります' }))]);
  };
  const choose = (event: ChangeEvent<HTMLInputElement>, zip: boolean): void => {
    const chosen = [...event.target.files ?? []];
    event.target.value = '';
    const [first] = chosen;
    if (!first) return;
    operations.setError('');
    if (!zip) {
      void read(chosen.map((file) => ({ path: file.webkitRelativePath || file.name, file })), 'skill');
      return;
    }
    void unzipChosen(first).then((entries) => read(entries, first.name.replace(/\.zip$/iu, ''))).catch((cause: unknown) => {
      operations.setError(cause instanceof Error ? cause.message : 'ZIP ファイルを読めませんでした。');
    });
  };

  const save = (): void => void operations.run(pendingKey.skillImport, async () => {
    const results = [...found ?? []];
    for (const [index, item] of results.entries()) {
      if (!plan(item).reads || !item.read.accepted) continue;
      try {
        await writeFolder(account.accountId, item.existing, item.files);
        results[index] = { ...item, outcome: 'done' };
      } catch (cause) {
        results[index] = { ...item, outcome: cause instanceof Error ? cause.message : '読み込めませんでした。' };
      }
    }
    setFound(results);
    await revalidator.revalidate();
    if (results.every((item) => !plan(item).reads)) onClose();
  });

  const reads = (found ?? []).filter((item) => plan(item).reads).length;
  return <Sheet title="スキルを読み込む" onClose={onClose}>
    <Note>Claude の Agent Skills と同じ形の、SKILL.md が入ったフォルダを読み込みます。中のファイルは種類を問わずそのまま置かれます。スキルのフォルダが一つでも、いくつも入ったフォルダでも、それを ZIP にしたファイルでも読めます。SKILL.md の name: と同じ名前のスキルがあれば、そのスキルのファイルがこのフォルダのとおりに書き換わります。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Toolbar>
      <Button variant="secondary" small icon={<FolderOpen size={18} aria-hidden="true" />} disabled={busy} onClick={() => document.querySelector<HTMLInputElement>(`input[aria-label="${FOLDERS}"]`)?.click()}>フォルダを選ぶ</Button>
      <Button variant="secondary" small icon={<Upload size={18} aria-hidden="true" />} disabled={busy} onClick={() => document.querySelector<HTMLInputElement>(`input[aria-label="${ZIP}"]`)?.click()}>ZIP ファイルを選ぶ</Button>
    </Toolbar>
    <input
      ref={(input) => input?.setAttribute('webkitdirectory', '')}
      type="file"
      className="fc-sr-only"
      tabIndex={-1}
      multiple
      aria-label={FOLDERS}
      onChange={(event) => choose(event, false)}
    />
    <input type="file" className="fc-sr-only" tabIndex={-1} accept=".zip,application/zip" aria-label={ZIP} onChange={(event) => choose(event, true)} />
    {found && (found.length === 0
      ? <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>SKILL.md の入ったフォルダが見つかりませんでした。</Banner>
      : <>
        <List label="読み込むスキル">{found.map((item) => {
          const { state, tone } = plan(item);
          return <Row
            key={item.folder}
            leading={<Folder size={20} aria-hidden="true" />}
            title={item.read.accepted ? item.read.title : item.folder}
            sub={`${item.folder}/ ・ ファイル${item.files.length}件`}
            aside={<Chip tone={tone}>{state}</Chip>}
            wrap
          />;
        })}</List>
        {found.map((item) => {
          const { detail, tone } = plan(item);
          return detail && <Banner key={item.folder} tone={tone === 'danger' ? 'danger' : 'info'} icon={<CircleAlert size={18} aria-hidden="true" />}>
            {`${item.folder}: ${detail}`}
          </Banner>;
        })}
      </>)}
    {skipped.length > 0 && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>
      読み込まないファイルがあります: {skipped.map(({ path, reason }) => `${path}（${reason}）`).join('、')}
    </Banner>}
    {found && found.length > 0 && <Button block busy={busy} disabled={reads === 0} onClick={save}>{busy ? '読み込んでいます…' : reads ? `${reads}件のスキルを読み込む` : '読み込むスキルはありません'}</Button>}
  </Sheet>;
};

/**
 * Skills are shared by every Automation, and any run may read one that
 * applies, so they are their own screen. Each is a folder, opened on its own
 * page; here they are listed, read in, and written out.
 */
const SkillsScreen = () => {
  const data = useLoaderData<SkillsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [importing, setImporting] = useState(false);
  /** Every Skill as a folder of one ZIP file, each file read as the bytes it is kept as. */
  const exportAll = (skills: readonly Skill[]): void => void operations.run(pendingKey.skillExport, async () => {
    const folders = await Promise.all(skills.map((skill) => zipFolderOf(folderName(skill.name), keptFolder(skill), (from) => api.skillFile(account.accountId, skill.id, from))));
    saveFile(zipFolders(folders), 'skills.zip', 'application/zip');
  });
  return <Page title="スキル" lead="AI に教える、この Account での仕事のやり方です。1 つのスキルは SKILL.md と見本などのファイルが入ったフォルダです。自動化は選んだスキルを必ず読み、ほかのスキルも「いつ使うか」に当てはまれば読みます。" back={{ to: '../more', label: 'その他' }} actions={<ButtonLink pill icon={<Plus size={18} aria-hidden="true" />} to={NEW_SKILL}>追加</ButtonLink>}>
    <Deferred value={data.skills} fallback={<SkeletonRows />}>{(skills) => <>
      {skills.length === 0
        ? <Empty title="スキルはまだありません" text="自動化を作る前に、ここでスキルを作るか、スキルのフォルダを読み込みます。" />
        : <List>{skills.map((skill) => <Row
          key={skill.id}
          to={skill.id}
          label={`${skill.title}を開く`}
          leading={<Folder size={20} aria-hidden="true" />}
          title={skill.title}
          sub={skill.description || 'いつ使うかが書かれていません。このスキルを選んだ自動化からしか使われません。'}
          aside={<span>ファイル{skill.files.length}件</span>}
        />)}</List>}
      <Toolbar>
        <Button variant="secondary" small icon={<FolderOpen size={18} aria-hidden="true" />} onClick={() => setImporting(true)}>フォルダから読み込む</Button>
        <Button variant="secondary" small icon={<Download size={18} aria-hidden="true" />} busy={operations.pending(pendingKey.skillExport)} disabled={skills.length === 0} onClick={() => exportAll(skills)}>すべて ZIP で書き出す</Button>
      </Toolbar>
      {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
      {importing && <SkillImport skills={skills} onClose={() => setImporting(false)} />}
    </>}</Deferred>
  </Page>;
};

export default SkillsScreen;
