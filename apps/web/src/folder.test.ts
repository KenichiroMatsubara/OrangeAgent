// @vitest-environment node
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { blobOf, checkFolder, folderName, namedFolder, readChosen, skillFolders, unzipChosen, zipFolderOf, zipFolders, type FolderFile } from './folder';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const written = (path: string, content: string): FolderFile => ({ path, body: { kind: 'written', content } });

describe('Skill folder', () => {
  it('reads a folder as the Skill its SKILL.md states, or says why it cannot be saved as one', () => {
    const document = '---\nname: weekly-report\ndescription: 週の終わりに。\nmetadata:\n  display-name: 週報\n---\n\n見本どおりに書く。\n';

    expect(checkFolder([written('SKILL.md', document), written('examples/report.md', '例会')], document)).toEqual({ accepted: true, name: 'weekly-report', title: '週報', description: '週の終わりに。' });
    // A name is lowercase letters, digits, and hyphens, as Agent Skills have it; the words a person reads go in display-name.
    const japanese = '---\nname: 週報\ndescription: 週の終わりに。\n---\n\n書く。\n';
    expect(checkFolder([written('SKILL.md', japanese)], japanese)).toMatchObject({ accepted: false, message: expect.stringContaining('display-name') });
    expect(checkFolder([written('a.md', 'x')], null)).toEqual({ accepted: false, message: 'フォルダのいちばん上に SKILL.md がありません。' });
    expect(checkFolder([written('SKILL.md', '---\nname: \n---\n書く。')], '---\nname: \n---\n書く。')).toMatchObject({ accepted: false, message: expect.stringContaining('name:') });
  });

  it('takes every kind and size of file as it is, passing over what a system leaves in a folder', () => {
    const logo = new Blob([PNG]);
    const video = { size: 500 * 1024 * 1024 } as Blob;
    const read = readChosen([
      { path: 'weekly/SKILL.md', file: new Blob(['書く。']) },
      { path: 'weekly/logo.png', file: logo },
      { path: 'weekly/video.mp4', file: video },
      { path: 'weekly/.git/config', file: new Blob(['x']) },
      { path: '__MACOSX/weekly/._SKILL.md', file: new Blob(['x']) },
    ]);

    expect(read.files.map((file) => file.path)).toEqual(['weekly/SKILL.md', 'weekly/logo.png', 'weekly/video.mp4']);
    expect(read.files[1]?.body).toEqual({ kind: 'read', blob: logo });
    expect(read.skipped).toEqual([]);
  });

  it('finds every Skill folder, a SKILL.md inside one being one of its files, and names a file in none', () => {
    const { folders, outside } = skillFolders([
      written('all/README.md', ''),
      written('all/weekly/SKILL.md', 'a'),
      written('all/weekly/nested/SKILL.md', 'b'),
      written('all/reminder/SKILL.md', 'c'),
      written('all/reminder/templates/notice.md', 'd'),
    ]);

    expect(folders.map(({ folder, files }) => ({ folder, paths: files.map((file) => file.path) }))).toEqual([
      { folder: 'all/reminder', paths: ['SKILL.md', 'templates/notice.md'] },
      { folder: 'all/weekly', paths: ['SKILL.md', 'nested/SKILL.md'] },
    ]);
    expect(outside).toEqual(['all/README.md']);
    expect(skillFolders([written('SKILL.md', 'a')]).folders[0]?.folder).toBe('');
  });

  it('names a Skill after its folder when its SKILL.md names none, and a folder no Skill can be named after as its title', async () => {
    const named = await namedFolder({ folder: 'skills/weekly-report', files: [{ path: 'SKILL.md', body: { kind: 'read', blob: new Blob(['書く。']) } }] }, 'fallback');
    const japanese = await namedFolder({ folder: 'skills/週報', files: [{ path: 'SKILL.md', body: { kind: 'read', blob: new Blob(['書く。']) } }] }, 'fallback');

    expect(named.document).toBe('---\nname: weekly-report\ndescription: ""\nmetadata:\n  display-name: weekly-report\n---\n\n書く。\n'.replace('metadata:\n  display-name: weekly-report\n', ''));
    expect(named.files).toEqual([written('SKILL.md', named.document ?? '')]);
    expect(japanese.document).toMatch(/^---\nname: skill-[0-9a-f]{12}\ndescription: ""\nmetadata:\n {2}display-name: 週報\n---\n\n書く。\n$/u);
  });

  it('sends a file as its bytes, under the media type it is kept under', async () => {
    const header = await blobOf({ path: 'header.png', body: { kind: 'read', blob: new Blob([PNG]) } }, async () => new Blob());
    const notes = await blobOf(written('notes.md', '日本語'), async () => new Blob());
    const logo = await blobOf({ path: 'assets/logo.png', body: { kind: 'kept', from: 'assets/logo.png', size: 6, mediaType: 'image/png' } }, async () => new Blob([PNG]));

    expect([header.type, notes.type, logo.type]).toEqual(['image/png', 'text/markdown', 'image/png']);
    expect(new Uint8Array(await header.arrayBuffer())).toEqual(PNG);
    expect(new TextDecoder().decode(await notes.arrayBuffer())).toBe('日本語');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG);
  });

  it('writes folders as one ZIP file, every file as its bytes, that reads back as the same folders', async () => {
    const zip = zipFolders([
      await zipFolderOf('a-b', [written('SKILL.md', 'one'), written('x/y.md', '日本語'), { path: 'logo.png', body: { kind: 'kept', from: 'logo.png', size: 6, mediaType: 'image/png' } }], async () => new Blob([PNG])),
      await zipFolderOf('a-b', [written('SKILL.md', 'two')], async () => new Blob()),
    ]);

    expect(Object.keys(unzipSync(zip))).toEqual(['a-b/SKILL.md', 'a-b/x/y.md', 'a-b/logo.png', 'a-b (2)/SKILL.md']);
    expect(strFromU8(unzipSync(zip)['a-b/x/y.md'] ?? new Uint8Array())).toBe('日本語');
    expect(unzipSync(zip)['a-b/logo.png']).toEqual(PNG);
    const { folders } = skillFolders(readChosen(await unzipChosen(new Blob([zip]))).files);
    expect(folders.map((folder) => folder.folder)).toEqual(['a-b', 'a-b (2)']);
  });

  it('refuses a file that is not a ZIP file', async () => {
    await expect(unzipChosen(new Blob(['not a zip']))).rejects.toThrow('ZIP ファイルとして読めませんでした。');
  });

  it('makes a folder name every system accepts', () => {
    expect(folderName('出欠: 集計/週次')).toBe('出欠- 集計-週次');
    expect(folderName('..')).toBe('skill');
  });
});
