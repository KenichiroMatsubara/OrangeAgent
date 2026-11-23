import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { zipFolders } from '../folder';
import { ACCOUNT_ID, skill } from './fixtures';
import { renderScreen } from './render';
import * as page from './skill';

fakeApi();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const DOCUMENT = '---\nname: weekly-report\ndescription: 週の終わりに。\nmetadata:\n  display-name: 週報\n---\n\nexamples/report.md の見本どおりに書く。\n';
const encoded = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** What 週報 keeps, file by file. */
const kept: Record<string, Uint8Array<ArrayBuffer>> = { 'SKILL.md': encoded(DOCUMENT), 'assets/logo.png': PNG, 'examples/report.md': encoded('今週は例会があります。') };

const weekly = skill({
  id: 'skill-2',
  name: 'weekly-report',
  title: '週報',
  description: '週の終わりに。',
  files: Object.entries(kept).map(([path, bytes]) => ({ path, size: bytes.byteLength, mediaType: path.endsWith('.png') ? 'image/png' : 'text/markdown' })),
});

/** 週報 as the Worker answers each change of its directory: the files it holds after the change. */
const serve = (): Map<string, Blob> => {
  const files = new Map<string, Blob>(Object.entries(kept).map(([path, bytes]) => [path, new Blob([bytes])]));
  const answer = () => skill({ ...weekly, files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, blob]) => ({ path, size: blob.size, mediaType: path.endsWith('.png') ? 'image/png' : 'text/markdown' })) });
  vi.mocked(api.writeSkillFile).mockImplementation(async (_account, _skill, path, blob) => { files.set(path, blob); return answer(); });
  vi.mocked(api.removeSkillFile).mockImplementation(async (_account, _skill, path) => { files.delete(path); return answer(); });
  vi.mocked(api.moveSkillFiles).mockImplementation(async (_account, _skill, { from, to }) => {
    for (const [path, blob] of [...files.entries()]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      files.delete(path);
      files.set(`${to}${path.slice(from.length)}`, blob);
    }
    return answer();
  });
  return files;
};

/** The words of a file as it was sent: its bytes, read as text. */
const sent = async (blob: Blob | undefined): Promise<string> => new TextDecoder().decode(await blob?.arrayBuffer());

const open = (id: string) => renderScreen('skills/:skillId', page, `/skills/${id}`);

const tree = () => screen.getByRole('navigation', { name: 'スキルのフォルダ' });

const inFolder = (path: string, content: BlobPart): File => {
  const file = new File([content], path.split('/').at(-1) ?? path);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};

describe('Skill folder screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.skills).mockResolvedValue([skill(), weekly]);
    vi.mocked(api.skillFile).mockImplementation(async (_account, _skill, path) => new Blob([kept[path] ?? new Uint8Array()]));
  });

  it('shows the Skill as its folder: SKILL.md with its front matter, and each file in its own folder', async () => {
    const user = userEvent.setup();
    open('skill-2');

    await screen.findByRole('heading', { name: '週報' });
    expect(within(tree()).getByRole('button', { name: 'weekly-report/' })).toBeTruthy();
    expect(within(tree()).getByRole('button', { name: 'examples/' })).toBeTruthy();
    expect(within(tree()).getByRole('button', { name: 'assets/' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'SKILL.md の中身' }) as HTMLTextAreaElement).value).toBe(DOCUMENT);

    await user.click(within(tree()).getByRole('button', { name: 'report.md' }));
    expect((await screen.findByRole('textbox', { name: 'examples/report.md の中身' }) as HTMLTextAreaElement).value).toBe('今週は例会があります。');
    expect(api.skillFile).toHaveBeenCalledWith(ACCOUNT_ID, 'skill-2', 'examples/report.md');
  });

  it('shows a file that is not text for what it is, kept as it is', async () => {
    const user = userEvent.setup();
    open('skill-2');

    await screen.findByRole('navigation', { name: 'スキルのフォルダ' });
    await user.click(within(tree()).getByRole('button', { name: 'logo.png' }));

    expect(await screen.findByText(/テキストではないファイルです（image\/png）/u)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'assets/logo.png の中身' })).toBeNull();
    expect(screen.getByRole('img', { name: 'assets/logo.png' })).toBeTruthy();
  });

  it('saves each text file written as its bytes, and makes a new file in a folder at once', async () => {
    const files = serve();
    const user = userEvent.setup();
    open('skill-2');

    const document = await screen.findByRole('textbox', { name: 'SKILL.md の中身' });
    await user.clear(document);
    await user.type(document, '---{enter}name: weekly-report{enter}description: 金曜に。{enter}---{enter}見本を読んでから書く。');
    expect(screen.getByText('金曜に。')).toBeTruthy();

    await user.click(within(tree()).getByRole('button', { name: 'report.md' }));
    await user.type(await screen.findByRole('textbox', { name: 'examples/report.md の中身' }), '追記。');
    expect(within(tree()).getByRole('button', { name: /report\.md/u }).querySelector('[aria-label="未保存"]')).toBeTruthy();

    await user.click(within(tree()).getByRole('button', { name: 'examples/' }));
    await user.click(screen.getByRole('button', { name: '新しいファイル' }));
    await user.type(screen.getByRole('textbox', { name: 'ファイル名' }), 'second.md');
    await user.click(screen.getByRole('button', { name: '作る' }));
    await waitFor(() => expect(files.has('examples/second.md')).toBe(true));
    await user.type(await screen.findByRole('textbox', { name: 'examples/second.md の中身' }), '二つ目の見本。');
    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByRole('button', { name: '保存済み' })).toBeTruthy();
    await expect(sent(files.get('SKILL.md'))).resolves.toBe('---\nname: weekly-report\ndescription: 金曜に。\n---\n見本を読んでから書く。');
    await expect(sent(files.get('examples/report.md'))).resolves.toBe('今週は例会があります。追記。');
    await expect(sent(files.get('examples/second.md'))).resolves.toBe('二つ目の見本。');
    expect(vi.mocked(api.writeSkillFile).mock.calls.map(([, , path]) => path)).toEqual(['examples/second.md', 'SKILL.md', 'examples/report.md', 'examples/second.md']);
  });

  it('refuses to save a SKILL.md that names no Skill, and says what it lacks', async () => {
    serve();
    const user = userEvent.setup();
    open('skill-2');

    const document = await screen.findByRole('textbox', { name: 'SKILL.md の中身' });
    await user.clear(document);
    await user.type(document, 'やり方だけ。');
    expect(screen.getByText(/「---」の行で挟んで/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.writeSkillFile).not.toHaveBeenCalled();
  });

  it('uploads files of any kind into the folder chosen, each written as the file it is', async () => {
    const files = serve();
    const user = userEvent.setup();
    open('skill-2');

    await screen.findByRole('navigation', { name: 'スキルのフォルダ' });
    await user.click(within(tree()).getByRole('button', { name: 'examples/' }));
    await user.upload(screen.getByLabelText('このフォルダにアップロードするファイル'), [
      new File(['名前,出欠'], 'answers.csv'),
      new File([PNG], 'chart.png', { type: 'image/png' }),
    ]);

    expect(await within(tree()).findByRole('button', { name: /^chart\.png/u })).toBeTruthy();
    expect(within(tree()).getByRole('button', { name: /^answers\.csv/u })).toBeTruthy();
    await expect(sent(files.get('examples/answers.csv'))).resolves.toBe('名前,出欠');
    expect(new Uint8Array(await files.get('examples/chart.png')!.arrayBuffer())).toEqual(PNG);
    expect(files.get('examples/chart.png')?.type).toBe('image/png');
  });

  it('renames a folder with every file in it, and deletes a file only after a second press', async () => {
    const files = serve();
    const user = userEvent.setup();
    open('skill-2');

    await screen.findByRole('navigation', { name: 'スキルのフォルダ' });
    await user.click(within(tree()).getByRole('button', { name: 'examples/' }));
    const name = screen.getByRole('textbox', { name: 'フォルダ名' });
    await user.clear(name);
    await user.type(name, 'samples');
    await user.click(screen.getByRole('button', { name: '名前を変える' }));
    expect(await within(tree()).findByRole('button', { name: 'samples/' })).toBeTruthy();
    expect(api.moveSkillFiles).toHaveBeenCalledWith(ACCOUNT_ID, 'skill-2', { from: 'examples', to: 'samples' });

    await user.click(within(tree()).getByRole('button', { name: /^report\.md/u }));
    await user.click(screen.getByRole('button', { name: 'report.md を削除' }));
    expect(api.removeSkillFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '本当に削除する' }));
    await waitFor(() => expect(within(tree()).queryByRole('button', { name: /^report\.md/u })).toBeNull());
    expect(api.removeSkillFile).toHaveBeenCalledWith(ACCOUNT_ID, 'skill-2', 'samples/report.md');
    expect([...files.keys()].sort()).toEqual(['SKILL.md', 'assets/logo.png']);
  });

  it('makes a new Skill from its SKILL.md and opens it', async () => {
    vi.mocked(api.createSkill).mockResolvedValue(skill({ id: 'skill-3', name: 'attendance-tally', title: '出欠の集計' }));
    const user = userEvent.setup();
    open(page.NEW_SKILL);

    const document = await screen.findByRole('textbox', { name: 'SKILL.md の中身' });
    await user.clear(document);
    await user.type(document, '---{enter}name: attendance-tally{enter}description: 出欠の返事が届いたとき。{enter}---{enter}未回答の人を一覧にする。');
    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(api.createSkill).toHaveBeenCalledTimes(1));
    const [account, blob] = vi.mocked(api.createSkill).mock.calls[0]!;
    expect(account).toBe(ACCOUNT_ID);
    await expect(sent(blob)).resolves.toBe('---\nname: attendance-tally\ndescription: 出欠の返事が届いたとき。\n---\n未回答の人を一覧にする。');
  });

  it('copies a Skill folder or a ZIP file read in over the Skill’s files', async () => {
    const files = serve();
    const user = userEvent.setup();
    open('skill-2');

    await user.upload(await screen.findByLabelText('スキルとして読み込むフォルダ'), [
      inFolder('weekly/SKILL.md', '---\nname: 週報\n---\n\n書く。'),
      inFolder('weekly/examples/report.md', '例会'),
      inFolder('weekly/.DS_Store', new Uint8Array([0x00])),
    ]);

    await waitFor(() => expect([...files.keys()].sort()).toEqual(['SKILL.md', 'examples/report.md']));
    await expect(sent(files.get('examples/report.md'))).resolves.toBe('例会');

    const zip = zipFolders([{ folder: '週報', files: [{ path: 'SKILL.md', bytes: encoded('---\nname: 週報\n---\n\n書く。') }, { path: 'templates/a.md', bytes: encoded('雛形') }, { path: 'logo.png', bytes: PNG }] }]);
    await user.upload(screen.getByLabelText('スキルとして読み込む ZIP ファイル'), new File([zip], '週報.zip', { type: 'application/zip' }));

    expect(await within(tree()).findByRole('button', { name: 'templates/' })).toBeTruthy();
    await waitFor(() => expect([...files.keys()].sort()).toEqual(['SKILL.md', 'logo.png', 'templates/a.md']));
    expect(new Uint8Array(await files.get('logo.png')!.arrayBuffer())).toEqual(PNG);
  });
});
