import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { zipFolders } from '../folder';
import { ACCOUNT_ID, skill } from './fixtures';
import { renderScreen } from './render';
import * as skills from './skills';

fakeApi();

const encoded = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const sent = async (blob: Blob | undefined): Promise<string> => new TextDecoder().decode(await blob?.arrayBuffer());
const document = (name: string, description: string, instructions: string, title?: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n${title ? `metadata:\n  display-name: ${title}\n` : ''}---\n\n${instructions}\n`;

describe('Skills screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.skills).mockResolvedValue([
      skill(),
      skill({
        id: 'skill-2', name: 'attendance-tally', title: '出欠の集計', description: '',
        files: [{ path: 'SKILL.md', size: 60, mediaType: 'text/markdown' }, { path: 'templates/a.md', size: 6, mediaType: 'text/markdown' }],
      }),
    ]);
    vi.mocked(api.skillFile).mockImplementation(async (_account, _skill, path) => new Blob([path]));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists each Skill as a folder that opens on its own page, and says when one has no description', async () => {
    renderScreen('skills', skills);

    expect((await screen.findByRole('link', { name: 'Morning checkを開く' })).getAttribute('href')).toBe(`/skills/prompt-1`);
    const counted = screen.getByRole('link', { name: '出欠の集計を開く' });
    expect(counted.textContent).toContain('いつ使うかが書かれていません');
    expect(counted.textContent).toContain('ファイル2件');
    expect(screen.getByRole('link', { name: '追加' }).getAttribute('href')).toBe(`/skills/new`);
  });

  it('writes every Skill out as one ZIP file, a folder for each', async () => {
    const saved: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { saved.push(blob); return 'blob:skills'; }, revokeObjectURL: () => undefined }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderScreen('skills', skills);

    await user.click(await screen.findByRole('button', { name: 'すべて ZIP で書き出す' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const entries = unzipSync(new Uint8Array(await saved[0]!.arrayBuffer()));
    // Each Skill's folder is named as the Skill is (Agent Skills).
    expect(Object.keys(entries).sort()).toEqual(['attendance-tally/SKILL.md', 'attendance-tally/templates/a.md', 'morning-check/SKILL.md']);
    expect(new TextDecoder().decode(entries['attendance-tally/templates/a.md'])).toBe('templates/a.md');
    expect(api.skillFile).toHaveBeenCalledWith(ACCOUNT_ID, 'skill-2', 'templates/a.md');
  });

  it('reads a ZIP file of Skill folders, says which it makes and which it writes over, then writes each file as its bytes', async () => {
    vi.mocked(api.createSkill).mockResolvedValue(skill({ id: 'skill-3' }));
    vi.mocked(api.writeSkillFile).mockImplementation(async (_account, id) => skill({ id }));
    const user = userEvent.setup();
    renderScreen('skills', skills);
    const zip = zipFolders([
      { folder: '週報', files: [{ path: 'SKILL.md', bytes: encoded(document('weekly-report', '週の終わりに。', '書く。', '週報')) }, { path: 'examples/report.md', bytes: encoded('例会') }] },
      { folder: '出欠の集計', files: [{ path: 'SKILL.md', bytes: encoded(document('attendance-tally', '出欠の返事が届いたとき。', '未回答の人を一覧にする。', '出欠の集計')) }, { path: 'templates/a.md', bytes: encoded('新しい雛形') }] },
    ]);

    await user.click(await screen.findByRole('button', { name: 'フォルダから読み込む' }));
    const sheet = await screen.findByRole('dialog', { name: 'スキルを読み込む' });
    await user.upload(within(sheet).getByLabelText('読み込むスキルの ZIP ファイル'), new File([zip], 'skills.zip', { type: 'application/zip' }));

    const found = await within(sheet).findByRole('list', { name: '読み込むスキル' });
    expect(within(found).getByText('週報').closest('li')?.textContent).toContain('新しく作ります');
    expect(within(found).getByText('出欠の集計').closest('li')?.textContent).toContain('書き換えます');
    expect(within(sheet).getByText('出欠の集計: 同じ名前のスキルのファイルを、このフォルダのとおりに書き換えます。')).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: '2件のスキルを読み込む' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await expect(sent(vi.mocked(api.createSkill).mock.calls[0]?.[1])).resolves.toBe(document('weekly-report', '週の終わりに。', '書く。', '週報'));
    const writes = await Promise.all(vi.mocked(api.writeSkillFile).mock.calls.map(async ([, id, path, blob]) => [id, path, await sent(blob)]));
    expect(writes).toHaveLength(3);
    expect(writes).toEqual(expect.arrayContaining([
      ['skill-3', 'examples/report.md', '例会'],
      ['skill-2', 'SKILL.md', document('attendance-tally', '出欠の返事が届いたとき。', '未回答の人を一覧にする。', '出欠の集計')],
      ['skill-2', 'templates/a.md', '新しい雛形'],
    ]));
  });

  it('says in full, where it can be read and copied, which file a refused import stopped at, what was sent, and why', async () => {
    vi.mocked(api.createSkill).mockRejectedValue(new Error('SKILL.md の先頭に、「---」の行で挟んで name: と description: を書いてください。'));
    const user = userEvent.setup();
    renderScreen('skills', skills);
    const instructions = document('meeting-papers', 'さくら会 の例会の書類を作るときに使う。', '雛形の {{…}} を差し替える。', '例会書類');
    const zip = zipFolders([{ folder: '例会書類', files: [{ path: 'SKILL.md', bytes: encoded(instructions) }] }]);

    await user.click(await screen.findByRole('button', { name: 'フォルダから読み込む' }));
    const sheet = await screen.findByRole('dialog', { name: 'スキルを読み込む' });
    await user.upload(within(sheet).getByLabelText('読み込むスキルの ZIP ファイル'), new File([zip], 'skills.zip', { type: 'application/zip' }));
    await user.click(await within(sheet).findByRole('button', { name: '1件のスキルを読み込む' }));

    const refused = await within(sheet).findByRole('alert');
    expect(refused.textContent).toBe(`例会書類: SKILL.md をスキルにできませんでした。SKILL.md の先頭に、「---」の行で挟んで name: と description: を書いてください。送ったのは ${new TextEncoder().encode(instructions).byteLength} B です。`);
    expect(refused.closest('ul')).toBeNull();
    expect(within(within(sheet).getByRole('list', { name: '読み込むスキル' })).getByText('失敗しました')).toBeTruthy();
  });
});
