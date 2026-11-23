import meetingMinutes from '../presets/meeting-minutes.json';
import membershipAccount from '../presets/membership-organization.json';
import { AUTOMATION_TOOLS, SKILL_NAME_LIMIT, isSkillName, type ExecutionMode, type PresetApplication } from '@mail/domain';
import { eq } from 'drizzle-orm';

import { automationStatements } from './automations';
import { parseSchedule } from './schedule';
import { notFound, Refusal } from './refusal';
import type { AccountDatabase } from './storage/database';
import { automations, settings, skillRevisions, skills } from './storage/account-schema';

/**
 * A Preset: Skills and the Automations that run them, copied once into an
 * Account and thereafter unlinked from the release that supplied them. Each
 * Automation is granted every tool an Automation can call, and tells whom
 * its Skills name.
 */
export interface PresetDocument {
  id: string;
  name: string;
  description: string;
  skills: Array<{
    key: string;
    name: string;
    description: string;
    instructions: string;
  }>;
  automations: Array<{
    key: string;
    name: string;
    enabled: boolean;
    executionMode: ExecutionMode;
    skillKeys: string[];
    /** When it runs, as an Automation states it. */
    schedule: string;
  }>;
}

const catalog: readonly PresetDocument[] = [membershipAccount as PresetDocument, meetingMinutes as PresetDocument];

export const availablePresets = (): readonly PresetDocument[] => catalog;

export class PresetConfigurationConflictError extends Refusal {
  constructor() {
    super('conflict', 'This Account already has configuration. Explicitly choose to add another copy of the Preset.');
    this.name = 'PresetConfigurationConflictError';
  }
}

const scheduleOf = (schedule: string): string => {
  if (!parseSchedule(schedule)) throw new Error(`Preset schedule ${schedule} cannot be read.`);
  return schedule;
};

const requiredReference = (references: ReadonlyMap<string, string>, key: string, kind: string): string => {
  const id = references.get(key);
  if (!id) throw new Error(`Preset ${kind} reference ${key} was not found.`);
  return id;
};

/**
 * The name a preset's Skill is given as Agent Skills name one (ADR 0203): its
 * key, which is one, else a name made from its id, with `-2` and on for a
 * copy. The name the preset gives it becomes its title.
 */
const skillNameFor = (key: string, id: string, used: Set<string>): string => {
  const base = isSkillName(key) ? key : `skill-${id.replaceAll('-', '').slice(0, 12)}`;
  let candidate = base;
  for (let copy = 2; used.has(candidate); copy += 1) candidate = `${base.slice(0, SKILL_NAME_LIMIT - String(copy).length - 1)}-${copy}`;
  used.add(candidate);
  return candidate;
};

/** A name not yet taken, the requested one or a numbered copy of it. */
const copiedName = (requested: string, used: Set<string>): string => {
  if (!used.has(requested)) {
    used.add(requested);
    return requested;
  }
  for (let copy = 2; ; copy += 1) {
    const suffix = ` (${copy})`;
    const candidate = `${requested.slice(0, 100 - suffix.length)}${suffix}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
};

/**
 * Copies a Preset into the Account. An Account that already has Skills or
 * Automations gets a second copy only when it asks for one; an application
 * key makes the copy happen once however often it is asked for.
 */
export const applyPreset = async (
  database: AccountDatabase,
  accountId: string,
  presetId: string,
  options: { conflictPolicy?: 'duplicate'; applicationKey?: string } = {},
): Promise<PresetApplication> => {
  const preset = catalog.find((candidate) => candidate.id === presetId);
  if (!preset) throw notFound('Preset was not found.');
  const applicationSettingKey = options.applicationKey ? `preset-application:${options.applicationKey}` : null;
  if (applicationSettingKey) {
    const previous = await database.select({ value: settings.value }).from(settings).where(eq(settings.key, applicationSettingKey)).get();
    if (previous) return JSON.parse(previous.value) as PresetApplication;
  }
  const [existingSkills, existingAutomations] = await Promise.all([
    database.select({ name: skills.name }).from(skills).all(),
    database.select({ name: automations.name }).from(automations).all(),
  ]);
  if ((existingSkills.length || existingAutomations.length) && options.conflictPolicy !== 'duplicate') throw new PresetConfigurationConflictError();
  const at = new Date();
  const timestamp = at.toISOString();
  const skillIds = new Map(preset.skills.map((skill) => [skill.key, crypto.randomUUID()]));
  const usedSkillNames = new Set(existingSkills.map(({ name }) => name));
  const usedAutomationNames = new Set(existingAutomations.map(({ name }) => name));
  const summary: PresetApplication = { presetId: preset.id, skills: preset.skills.length, automations: preset.automations.length };
  const statements = [
    ...preset.skills.flatMap((skill) => {
      const id = requiredReference(skillIds, skill.key, 'Skill');
      return [
        database.insert(skills).values({
          id, accountId, name: skillNameFor(skill.key, id, usedSkillNames), title: skill.name, description: skill.description, instructions: skill.instructions,
          revision: 1, createdAt: timestamp, updatedAt: timestamp,
        }),
        database.insert(skillRevisions).values({ skillId: id, revision: 1, instructions: skill.instructions, createdAt: timestamp }),
      ];
    }),
    ...preset.automations.flatMap((automation) => automationStatements(database, {
      id: crypto.randomUUID(),
      accountId,
      name: copiedName(automation.name, usedAutomationNames),
      enabled: automation.enabled,
      schedule: scheduleOf(automation.schedule),
      settings: {
        skillIds: automation.skillKeys.map((key) => requiredReference(skillIds, key, 'Skill')),
        tools: AUTOMATION_TOOLS.map(({ name }) => name),
        executionMode: automation.executionMode,
        suppressionWindow: 'none',
        model: null,
      },
    }, at)),
    ...(applicationSettingKey ? [database.insert(settings).values({ key: applicationSettingKey, value: JSON.stringify(summary), updatedAt: timestamp })] : []),
  ];
  const [first, ...rest] = statements;
  if (!first) throw new Error('Preset contains no configuration.');
  await database.batch([first, ...rest]);
  return summary;
};
