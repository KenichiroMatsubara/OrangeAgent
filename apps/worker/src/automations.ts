/**
 * The Account's Automations as configuration: each read whole, created with
 * its first Automation Revision, and changed so that a new revision is kept
 * exactly when what its runs do changes.
 *
 * An Automation is when it runs, the Skills it runs, and the tools it may
 * call. Whom it tells is what its Skills say, so nothing here names a reader.
 * Automations a mail or the Morning started before migration 0042 stay in the
 * table, off, for the history their runs name, and are neither listed nor
 * changed.
 */

import {
  AUTOMATION_TOOLS,
  toolNamed,
  type Automation,
  type AutomationInput,
  type AutomationUpdate,
  type ExecutionMode,
  type SuppressionWindow,
} from '@mail/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { now } from './clock';
import { conflict, invalid, notFound } from './refusal';
import { nextScheduledRun, parseSchedule } from './schedule';
import { assertSkills, skillIdsOf } from './skills';
import type { AccountDatabase } from './storage/database';
import {
  EXECUTION_MODES,
  SUPPRESSION_WINDOWS,
  automationRevisions,
  automations,
  automationSkills,
  automationTools,
  events,
  runs,
} from './storage/account-schema';

type Row = typeof automations.$inferSelect;

/** Everything a revision records, in the shape it is compared and kept in. */
interface RevisedSettings {
  skillIds: string[];
  tools: string[];
  executionMode: ExecutionMode;
  suppressionWindow: SuppressionWindow;
  /** The model its runs think with, or null for the AI Connection's default. */
  model: string | null;
}

/**
 * The model an Automation is to think with: one of those the AI Connection
 * names, or null for its default. Naming the default itself keeps null, so
 * the Automation follows the default when the Account changes it.
 */
const modelOf = (value: unknown, models: readonly string[]): string | null => {
  if (value === null || value === undefined) return null;
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model === models[0]) return null;
  if (!models.includes(model)) throw invalid(`モデル ${model} は AI 接続に登録されていません。「接続」の AI 接続で登録したモデルだけを選べます。`);
  return model;
};

const sameRevision = (left: RevisedSettings, right: RevisedSettings): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Reads a Tool Grant: tools of the product's list, or tools a connected MCP Server lends, each once, in the product's order. */
const toolsOf = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== 'string' || !tool.trim())) throw invalid('使ってよいことは道具の名前の一覧で指定してください。');
  const named = [...new Set((value as string[]).map((tool) => tool.trim()))];
  const grantable: readonly string[] = AUTOMATION_TOOLS.map(({ name }) => name);
  const refused = named.filter((tool) => toolNamed(tool) ? !grantable.includes(tool) : !/^[^.]+\..+$/u.test(tool));
  if (refused.length) throw invalid(`この自動化には ${refused.join('、')} を使わせられません。`);
  return [...grantable.filter((tool) => named.includes(tool)), ...named.filter((tool) => !toolNamed(tool)).sort()];
};

/** The grantable tools of a stored Tool Grant, dropping any a release has since retired. */
const storedTools = (tools: readonly string[]): string[] => {
  const grantable: readonly string[] = AUTOMATION_TOOLS.map(({ name }) => name);
  return [...grantable.filter((tool) => tools.includes(tool)), ...tools.filter((tool) => !toolNamed(tool)).sort()];
};

const oneOf = <T extends string>(values: readonly T[], value: unknown, message: string): T => {
  if (!values.includes(value as T)) throw invalid(message);
  return value as T;
};

const nameOf = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw invalid('名前を入力してください。');
  return name;
};

const scheduleOf = (value: unknown): string => {
  const schedule = typeof value === 'string' ? value.trim() : '';
  if (!parseSchedule(schedule)) throw invalid('いつ動かすかは daily HH:MM / weekly mon HH:MM / hourly :MM の形で指定してください。');
  return schedule;
};

/** Reads an Automation's switch: on or off, and nothing else. */
const enabledOf = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw invalid('オンかオフかで指定してください。');
  return value;
};

const nextRunOf = (row: Pick<Row, 'enabled' | 'schedule'>, at: Date): string | null =>
  row.enabled && row.schedule ? nextScheduledRun({ schedule: row.schedule, after: at }) : null;

/** The Automations named, each read whole. */
const viewsOf = async (db: AccountDatabase, rows: readonly Row[]): Promise<Automation[]> => {
  if (!rows.length) return [];
  const ids = rows.map(({ id }) => id);
  const [skills, tools, latest] = await Promise.all([
    db.select().from(automationSkills).where(inArray(automationSkills.automationId, ids)).orderBy(asc(automationSkills.position)).all(),
    db.select().from(automationTools).where(inArray(automationTools.automationId, ids)).all(),
    db.select({ id: runs.id, automationId: runs.automationId, startedAt: runs.startedAt, status: runs.status, error: runs.error }).from(runs)
      .where(and(inArray(runs.automationId, ids), sql`${runs.startedAt} = (select max(latest.started_at) from runs latest where latest.automation_id = ${runs.automationId})`)).all(),
  ]);
  return rows.map((row): Automation => {
    const lastRun = latest.find(({ automationId }) => automationId === row.id);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      schedule: row.schedule ?? '',
      executionMode: row.executionMode,
      skillIds: skills.filter(({ automationId }) => automationId === row.id).map(({ skillId }) => skillId),
      tools: storedTools(tools.filter(({ automationId }) => automationId === row.id).map(({ tool }) => tool)),
      suppressionWindow: row.suppressionWindow,
      model: row.model,
      revision: row.revision,
      nextRunAt: row.nextRunAt,
      lastRun: lastRun ? { id: lastRun.id, startedAt: lastRun.startedAt, status: lastRun.status, error: lastRun.error } : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
};

/** One Automation with a Trigger Time, or nothing. */
const scheduledRow = async (db: AccountDatabase, id: string): Promise<Row> => {
  const row = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.trigger, 'schedule'))).get();
  if (!row) throw notFound('自動化が見つかりません。');
  return row;
};

/** Every Automation of the Account, by when it next runs and then by name. */
export const listAutomations = async (db: AccountDatabase): Promise<Automation[]> => {
  const rows = await db.select().from(automations).where(eq(automations.trigger, 'schedule')).orderBy(asc(automations.name)).all();
  return viewsOf(db, rows);
};

export const readAutomation = async (db: AccountDatabase, id: string): Promise<Automation> =>
  (await viewsOf(db, [await scheduledRow(db, id)]))[0]!;

/** One Automation to add, already read, as the statements that add it whole. */
export interface AutomationRecord {
  id: string;
  accountId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  settings: RevisedSettings;
}

/** The statements that add one Automation with its Skills, Tool Grant, and first revision, for one batch. */
export const automationStatements = (db: AccountDatabase, record: AutomationRecord, at: Date) => {
  const timestamp = at.toISOString();
  const { settings } = record;
  return [
    db.insert(automations).values({
      id: record.id,
      accountId: record.accountId,
      name: record.name,
      trigger: 'schedule',
      enabled: record.enabled,
      executionMode: settings.executionMode,
      suppressionWindow: settings.suppressionWindow,
      revision: 1,
      model: settings.model,
      schedule: record.schedule,
      nextRunAt: nextRunOf(record, at),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    ...settings.skillIds.map((skillId, position) => db.insert(automationSkills).values({ automationId: record.id, skillId, position })),
    ...settings.tools.map((tool) => db.insert(automationTools).values({ automationId: record.id, tool })),
    db.insert(automationRevisions).values({
      automationId: record.id,
      revision: 1,
      skillIds: JSON.stringify(settings.skillIds),
      tools: JSON.stringify(settings.tools),
      executionMode: settings.executionMode,
      suppressionWindow: settings.suppressionWindow,
      model: settings.model,
      createdAt: timestamp,
    }),
  ] as const;
};

/**
 * Adds an Automation. `models` are those the AI Connection names, the default
 * first; the Automation may name only one of them.
 */
export const createAutomation = async (db: AccountDatabase, accountId: string, input: Partial<AutomationInput>, models: readonly string[]): Promise<Automation> => {
  const name = nameOf(input.name);
  const skillIds = skillIdsOf(input.skillIds) ?? [];
  if (!skillIds.length) throw invalid('スキルを 1 つ以上選んでください。');
  await assertSkills(db, skillIds);
  const taken = await db.select({ id: automations.id }).from(automations).where(eq(automations.name, name)).get();
  if (taken) throw conflict('同じ名前の自動化があります。');
  const id = crypto.randomUUID();
  await db.batch(automationStatements(db, {
    id,
    accountId,
    name,
    enabled: input.enabled === undefined ? false : enabledOf(input.enabled),
    schedule: scheduleOf(input.schedule),
    settings: {
      skillIds,
      tools: toolsOf(input.tools ?? []),
      executionMode: oneOf(EXECUTION_MODES, input.executionMode ?? 'unattended', '実行のしかたの指定が不正です。'),
      suppressionWindow: oneOf(SUPPRESSION_WINDOWS, input.suppressionWindow ?? 'none', '同じ操作を止める期間の指定が不正です。'),
      model: modelOf(input.model, models),
    },
  }, new Date(now())));
  return readAutomation(db, id);
};

/**
 * Changes an Automation. A change to what its runs do — its Skills, Tool
 * Grant, Execution Mode, Suppression Window, or model — is a new revision; a
 * rename, turning it on or off, or a Trigger Time is not, and neither is a save that
 * resubmits the values already stored. `models` are those the AI Connection
 * names, the default first.
 */
export const updateAutomation = async (db: AccountDatabase, id: string, update: AutomationUpdate, models: readonly string[]): Promise<Automation> => {
  const row = await scheduledRow(db, id);
  const current = await readAutomation(db, id);
  const name = update.name === undefined ? row.name : nameOf(update.name);
  if (name !== row.name) {
    const taken = await db.select({ id: automations.id }).from(automations).where(eq(automations.name, name)).get();
    if (taken) throw conflict('同じ名前の自動化があります。');
  }
  const skillIds = skillIdsOf(update.skillIds) ?? current.skillIds;
  if (update.skillIds !== undefined) await assertSkills(db, skillIds);
  const enabled = update.enabled === undefined ? row.enabled : enabledOf(update.enabled);
  const schedule = update.schedule === undefined ? current.schedule : scheduleOf(update.schedule);
  const settings: RevisedSettings = {
    skillIds,
    tools: update.tools === undefined ? current.tools : toolsOf(update.tools),
    executionMode: update.executionMode === undefined ? row.executionMode : oneOf(EXECUTION_MODES, update.executionMode, '実行のしかたの指定が不正です。'),
    suppressionWindow: update.suppressionWindow === undefined ? row.suppressionWindow : oneOf(SUPPRESSION_WINDOWS, update.suppressionWindow, '同じ操作を止める期間の指定が不正です。'),
    model: update.model === undefined ? row.model : modelOf(update.model, models),
  };
  const previous: RevisedSettings = { skillIds: current.skillIds, tools: current.tools, executionMode: row.executionMode, suppressionWindow: row.suppressionWindow, model: row.model };
  const revises = !sameRevision(previous, settings);
  const revision = revises ? row.revision + 1 : row.revision;
  const at = new Date(now());
  const timestamp = at.toISOString();
  const rescheduled = enabled !== row.enabled || schedule !== row.schedule;
  await db.batch([
    db.update(automations).set({
      name,
      enabled,
      executionMode: settings.executionMode,
      suppressionWindow: settings.suppressionWindow,
      model: settings.model,
      schedule,
      revision,
      ...(rescheduled ? { nextRunAt: nextRunOf({ enabled, schedule }, at) } : {}),
      updatedAt: timestamp,
    }).where(eq(automations.id, id)),
    ...(update.skillIds === undefined ? [] : [
      db.delete(automationSkills).where(eq(automationSkills.automationId, id)),
      ...skillIds.map((skillId, position) => db.insert(automationSkills).values({ automationId: id, skillId, position })),
    ]),
    ...(update.tools === undefined ? [] : [
      db.delete(automationTools).where(eq(automationTools.automationId, id)),
      ...settings.tools.map((tool) => db.insert(automationTools).values({ automationId: id, tool })),
    ]),
    ...(revises ? [db.insert(automationRevisions).values({
      automationId: id,
      revision,
      skillIds: JSON.stringify(settings.skillIds),
      tools: JSON.stringify(settings.tools),
      executionMode: settings.executionMode,
      suppressionWindow: settings.suppressionWindow,
      model: settings.model,
      createdAt: timestamp,
    })] : []),
  ]);
  return readAutomation(db, id);
};

/** The Automations that name one of `models`, so a model is not taken off the AI Connection while one still thinks with it. */
export const automationsNamingModels = async (db: AccountDatabase, models: readonly string[]): Promise<Array<{ name: string; model: string }>> => {
  if (!models.length) return [];
  const rows = await db.select({ name: automations.name, model: automations.model }).from(automations)
    .where(and(eq(automations.trigger, 'schedule'), inArray(automations.model, [...models]))).orderBy(asc(automations.name)).all();
  return rows.flatMap((row) => row.model ? [{ name: row.name, model: row.model }] : []);
};

/**
 * Removes an Automation that has never run and owns no Scheduled Event. One
 * that has is the record of what caused those writes, so it is turned off
 * instead.
 */
export const deleteAutomation = async (db: AccountDatabase, id: string): Promise<void> => {
  await scheduledRow(db, id);
  const [ran, owns] = await Promise.all([
    db.select({ id: runs.id }).from(runs).where(eq(runs.automationId, id)).limit(1).get(),
    db.select({ id: events.id }).from(events).where(eq(events.automationId, id)).limit(1).get(),
  ]);
  if (ran || owns) throw conflict('この自動化は動いた記録があるため削除できません。使わないときはオフにしてください。');
  await db.delete(automations).where(eq(automations.id, id)).run();
};
