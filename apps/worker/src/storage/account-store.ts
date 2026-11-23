import { eq } from 'drizzle-orm';

import { grantsDrafts, grantsDrive, grantsMeet, grantsTasks } from '../google';
import type { AccountDatabase } from './database';
import { googleConnections } from './account-schema';

export interface AutomationStatus {
  email: string;
  status: 'active' | 'reauthentication_required' | 'disconnected';
  lastError: string | null;
  failingSince: string | null;
  draftsGranted: boolean;
  driveGranted: boolean;
  meetGranted: boolean;
  tasksGranted: boolean;
}

export interface AccountStore {
  currentAutomation: () => Promise<AutomationStatus | null>;
}

/**
 * Owns every Automation Inbox read. Its schema contains no Control D1 table,
 * so identity-scoped automation queries cannot be expressed.
 */
export const createAccountStore = (database: AccountDatabase): AccountStore => ({
  currentAutomation: async () => {
    const inbox = await database.select({
      email: googleConnections.inboxAddress,
      status: googleConnections.status,
      lastError: googleConnections.lastError,
      failingSince: googleConnections.failingSince,
      grantedScopes: googleConnections.grantedScopes,
    }).from(googleConnections)
      .where(eq(googleConnections.kind, 'automation_inbox'))
      .limit(1)
      .get();
    if (!inbox) return null;
    const { grantedScopes, ...status } = inbox;
    const scopes = storedScopes(grantedScopes);
    return { ...status, draftsGranted: grantsDrafts(scopes), driveGranted: grantsDrive(scopes), meetGranted: grantsMeet(scopes), tasksGranted: grantsTasks(scopes) };
  },
});

/** The scopes a Google Connection recorded when it was granted, as a JSON list; anything else grants none. */
const storedScopes = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
};
