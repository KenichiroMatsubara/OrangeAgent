import { eq, sql } from 'drizzle-orm';
import type { Skill, SkillFileMove } from '@mail/domain';

import { toArrayBuffer } from '../encoding';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import { createSkill, discardSkillFolders, listSkills, moveSkillFiles, removeSkillFile, skillFile, writeSkillFile, type SkillStore } from '../skills';
import { automationRevisions, automationSkills, runs, skills } from '../storage/account-schema';
import { accountRoute, created, type AccountRequest, type Created } from './account';

export const skillRoutes = resource();

const storeOf = (request: AccountRequest<unknown>): SkillStore => ({ db: request.db, bucket: request.env.RECOVERY_RECEIPTS, accountId: request.accountId });

/** An image is shown in the browser; every other file is downloaded, so nothing a Skill carries runs as a page here. */
const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The file a request carries: its body, as the bytes it is, however large. */
const sentFile = async (request: AccountRequest<unknown>): Promise<Uint8Array> => new Uint8Array(await request.raw.arrayBuffer());

const pathOf = (request: AccountRequest<unknown>): string => request.query('path') ?? '';

skillRoutes.get('/organizations/:accountId/skills', accountRoute(async (request): Promise<Skill[]> => listSkills(storeOf(request))));

/** Makes a Skill from its SKILL.md, sent as the file it is. */
skillRoutes.post('/organizations/:accountId/skills', accountRoute<unknown>(async (request): Promise<Created<Skill>> =>
  created(await createSkill(storeOf(request), await sentFile(request))), { body: 'file' }));

/** One file of a Skill, as the bytes it is kept as. */
skillRoutes.get('/organizations/:accountId/skills/:skillId/file', accountRoute(async (request): Promise<Response> => {
  const file = await skillFile(storeOf(request), request.params.skillId ?? '', pathOf(request));
  const disposition = SHOWN.has(file.mediaType) ? 'inline' : 'attachment';
  return new Response(toArrayBuffer(file.bytes), {
    headers: {
      'Content-Type': file.mediaType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.path.split('/').at(-1) ?? file.path)}`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}));

/** Writes one file of a Skill as the body sent, under the media type it is sent as. */
skillRoutes.put('/organizations/:accountId/skills/:skillId/file', accountRoute<unknown>(async (request): Promise<Skill> => {
  const mediaType = request.header('content-type');
  return writeSkillFile(storeOf(request), {
    skillId: request.params.skillId ?? '', path: pathOf(request), bytes: await sentFile(request), ...(mediaType ? { mediaType } : {}),
  });
}, { body: 'file' }));

skillRoutes.delete('/organizations/:accountId/skills/:skillId/file', accountRoute(async (request): Promise<Skill> =>
  removeSkillFile(storeOf(request), { skillId: request.params.skillId ?? '', path: pathOf(request) })));

/** Moves a file, or a folder and everything in it, as renaming it does. */
skillRoutes.post('/organizations/:accountId/skills/:skillId/move', accountRoute<Partial<SkillFileMove>>(async (request): Promise<Skill> => {
  const { from, to } = request.body;
  if (typeof from !== 'string' || typeof to !== 'string') throw invalid('動かすファイルかフォルダ（from）と、その行き先（to）を指定してください。');
  return moveSkillFiles(storeOf(request), { skillId: request.params.skillId ?? '', from, to });
}));

/**
 * A Skill an Automation names cannot be deleted, because its runs would start
 * without it; neither can one a recorded run or Automation Revision names,
 * because the record names it as what caused the run's writes.
 */
skillRoutes.delete('/organizations/:accountId/skills/:skillId', accountRoute(async (request) => {
  const skillId = request.params.skillId ?? '';
  const db = request.db;
  const [named, ran, revised] = await Promise.all([
    db.select({ id: automationSkills.automationId }).from(automationSkills).where(eq(automationSkills.skillId, skillId)).limit(1).get(),
    db.select({ id: runs.id }).from(runs)
      .where(sql`exists (select 1 from json_each(${runs.skills}) where json_extract(json_each.value, '$.id') = ${skillId})`).limit(1).get(),
    db.select({ id: automationRevisions.automationId }).from(automationRevisions)
      .where(sql`exists (select 1 from json_each(${automationRevisions.skillIds}) where json_each.value = ${skillId})`).limit(1).get(),
  ]);
  if (named) throw conflict('このスキルを使っている自動化があります。そちらで外してから削除してください。');
  if (ran || revised) throw conflict('このスキルで動いた実行や自動化の版の記録が残っているため削除できません。使わなくなったら、自動化から外してください。');
  const removed = await db.delete(skills).where(eq(skills.id, skillId)).returning({ id: skills.id, directory: skills.directory }).get();
  if (!removed) throw notFound('Skill was not found.');
  await discardSkillFolders(storeOf(request), removed);
  return { id: skillId, removed: true };
}));
