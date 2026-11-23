import { describe, expect, it } from 'vitest';

import {
  checkSkillDocument,
  checkSkillFolder,
  readSkillDocument,
  readSkillFilePath,
  skillFileText,
  skillFileType,
  skillFolderRefusalText,
  writeSkillDocument,
} from './skills';

describe('Skill files', () => {
  it('reads a path within the Skill, refusing one that names no file of it', () => {
    expect(readSkillFilePath(' /examples\\\\report.md ')).toBe('examples/report.md');
    expect(readSkillFilePath('examples//report.md')).toBe('examples/report.md');
    expect(readSkillFilePath('../secret.md')).toBeNull();
    expect(readSkillFilePath('examples/./report.md')).toBeNull();
    expect(readSkillFilePath('/')).toBeNull();
    expect(readSkillFilePath('a\nb.md')).toBeNull();
  });

  it('checks the folder as one set, SKILL.md named as Agent Skills name it, and returns it in path order', () => {
    expect(checkSkillFolder([{ path: 'templates/b.md', size: 1 }, { path: 'skill.md', size: 1 }, { path: '/a.png', size: 1 }]))
      .toEqual({ accepted: true, files: [{ path: 'SKILL.md', size: 1 }, { path: 'a.png', size: 1 }, { path: 'templates/b.md', size: 1 }] });
  });

  it('refuses a folder with no SKILL.md or a name used twice, and takes any number of files of any size', () => {
    expect(checkSkillFolder([{ path: 'a.md', size: 1 }])).toMatchObject({ accepted: false, reason: 'no_instructions_file' });
    expect(checkSkillFolder([{ path: 'SKILL.md', size: 1 }, { path: 'a.md', size: 0 }, { path: '/a.md', size: 0 }])).toMatchObject({ accepted: false, reason: 'duplicate_path', path: 'a.md' });
    expect(checkSkillFolder([{ path: 'SKILL.md', size: 1 }, { path: 'video.mp4', size: 500 * 1024 * 1024 }])).toMatchObject({ accepted: true });
    expect(checkSkillFolder(Array.from({ length: 1_000 }, (_, index) => ({ path: index ? `${index}.md` : 'SKILL.md', size: 0 })))).toMatchObject({ accepted: true });
    expect(skillFolderRefusalText({ reason: 'no_instructions_file' })).toContain('いちばん上');
  });

  it('keeps each file under the media type its extension names, else the one it was given', () => {
    expect(skillFileType('SKILL.md')).toBe('text/markdown');
    expect(skillFileType('scripts/fill.py')).toBe('text/x-python');
    expect(skillFileType('assets/logo.PNG')).toBe('image/png');
    expect(skillFileType('data.bin', 'application/x-thing; charset=x')).toBe('application/x-thing');
    expect(skillFileType('LICENSE', '')).toBe('application/octet-stream');
  });

  it('reads a file as text only when it is UTF-8 without a NUL', () => {
    expect(skillFileText(new TextEncoder().encode('\uFEFF見本'))).toBe('見本');
    expect(skillFileText(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toBeNull();
    expect(skillFileText(new TextEncoder().encode('a\u0000b'))).toBeNull();
  });
});

describe('SKILL.md', () => {
  it('reads what its front matter states as YAML, and the instructions below it', () => {
    expect(readSkillDocument('---\nname: weekly-report\ndescription: \'週の終わりに。\'\nlicense: MIT\nmetadata:\n  display-name: 週報\n---\n\n# 週報\n\n見本どおりに書く。\n'))
      .toEqual({ name: 'weekly-report', description: '週の終わりに。', title: '週報', instructions: '# 週報\n\n見本どおりに書く。', metadata: { 'display-name': '週報' } });
    expect(readSkillDocument('\uFEFF見本どおりに書く。')).toEqual({ name: null, description: null, title: null, instructions: '見本どおりに書く。', metadata: {} });
    // Front matter YAML cannot read is read as no front matter at all.
    expect(readSkillDocument('---\nname: [a\n---\nb').name).toBeNull();
  });

  it('reads a description written as a block or folded, as YAML does', () => {
    expect(readSkillDocument('---\nname: x\ndescription: >-\n  週の終わりに\n  まとめるとき。\n---\n本文').description).toBe('週の終わりに まとめるとき。');
    expect(readSkillDocument('---\nname: x\ndescription: |\n  一行目\n  二行目\n---\n本文').description).toBe('一行目\n二行目');
  });

  it('writes a Skill that reads back as the same Skill, its title kept as metadata.display-name', () => {
    const skill = { name: 'mail-intake', title: 'メールの取り込み', description: '届いたメールを読むとき。', instructions: '読む。' };
    expect(writeSkillDocument(skill)).toBe('---\nname: mail-intake\ndescription: 届いたメールを読むとき。\nmetadata:\n  display-name: メールの取り込み\n---\n\n読む。\n');
    for (const written of [skill, { name: 'yes', title: 'yes', description: 'a: b #c\n"d"', instructions: '---\n本文' }]) {
      const read = readSkillDocument(writeSkillDocument(written));
      expect({ name: read.name, title: read.title ?? read.name, description: read.description, instructions: read.instructions }).toEqual(written);
    }
  });

  it('refuses a SKILL.md the Agent Skills specification does not allow, saying what to change', () => {
    expect(checkSkillDocument('読む。')).toEqual({ accepted: false, reason: 'no_front_matter' });
    expect(checkSkillDocument('---\nname: [x\n---\n読む。')).toEqual({ accepted: false, reason: 'unreadable_front_matter' });
    expect(checkSkillDocument('---\ndescription: x\n---\n読む。')).toEqual({ accepted: false, reason: 'no_name' });
    for (const name of ['メールの取り込み', 'Mail', '-mail', 'mail-', 'mail--intake', 'a'.repeat(65)]) {
      expect(checkSkillDocument(`---\nname: ${name}\ndescription: x\n---\n読む。`)).toEqual({ accepted: false, reason: 'bad_name' });
    }
    expect(checkSkillDocument('---\nname: x\n---\n読む。')).toEqual({ accepted: false, reason: 'no_description' });
    expect(checkSkillDocument(`---\nname: x\ndescription: ${'a'.repeat(1025)}\n---\n読む。`)).toEqual({ accepted: false, reason: 'long_description' });
    expect(checkSkillDocument('---\nname: x\ndescription: y\n---\n')).toEqual({ accepted: false, reason: 'no_instructions' });
    expect(checkSkillDocument('---\nname: x\ndescription: y\n---\n読む。')).toEqual({ accepted: true, name: 'x', title: 'x', description: 'y', instructions: '読む。', metadata: {} });
  });
});
