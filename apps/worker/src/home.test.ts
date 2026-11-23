import { afterEach, describe, expect, it } from 'vitest';

import type { Dashboard } from '@mail/domain';

import { app } from './app';
import { createTestApp, type TestApp } from '../test/app';
import { seedAutomation } from '../test/automation';
import { seedAttendanceRegistration, seedAutomationException, seedScheduledEvent } from '../test/seed';

// The suite's clock stands at 2026-08-01T00:00Z, 09:00 in Tokyo.

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const read = async (testApp: TestApp): Promise<Dashboard> => {
  const response = await app.fetch(testApp.request('/api/organizations/organization-1/dashboard'), testApp.environment);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Dashboard }).data;
};

describe('Home', () => {
  it('shows each Automation, the next to run first and one that is off last, with how its latest run ended', async () => {
    fixture = createTestApp();
    seedAutomation(fixture.account, { nextRunAt: '2026-08-01T20:00:00.000Z' });
    fixture.account.execute(
      `INSERT INTO automations (id, account_id, name, trigger, enabled, execution_mode, suppression_window, revision, schedule, next_run_at, created_at, updated_at)
       VALUES ('reminding', 'organization-1', 'タスクのリマインド', 'schedule', 1, 'unattended', 'day', 1, 'daily 07:00', '2026-08-01T22:00:00.000Z', '2026-07-01', '2026-07-01'),
              ('retired', 'organization-1', '古い自動化', 'schedule', 0, 'unattended', 'day', 1, 'daily 07:00', NULL, '2026-07-01', '2026-07-01')`,
    );
    fixture.account.execute(
      `INSERT INTO runs (id, trigger, automation_id, automation_revision, execution_mode, status, error, started_at, updated_at)
       VALUES ('run-1', 'schedule', 'automation-1', 1, 'unattended', 'failed', 'model unavailable', '2026-07-31T20:00:00.000Z', '2026-07-31T20:01:00.000Z')`,
    );

    const { automations, attention } = await read(fixture);

    expect(automations).toEqual([
      { id: 'automation-1', name: '毎朝のメール処理', enabled: true, schedule: 'daily 05:00', nextRunAt: '2026-08-01T20:00:00.000Z', lastRun: { id: 'run-1', startedAt: '2026-07-31T20:00:00.000Z', status: 'failed', error: 'model unavailable' } },
      { id: 'reminding', name: 'タスクのリマインド', enabled: true, schedule: 'daily 07:00', nextRunAt: '2026-08-01T22:00:00.000Z', lastRun: null },
      { id: 'retired', name: '古い自動化', enabled: false, schedule: 'daily 07:00', nextRunAt: null, lastRun: null },
    ]);
    expect(attention).toContainEqual({ kind: 'failed_run', count: 1, detail: '毎朝のメール処理' });
  });

  it('lists only the conditions that need the Account, each with how many and the first one named', async () => {
    fixture = createTestApp();
    seedAutomationException(fixture.account, { id: 'exception-1', message: 'AI 接続が応答しませんでした。' });
    fixture.account.execute(
      "INSERT INTO connections (id, kind, label, credential, status, created_at, updated_at) VALUES ('line-connection', 'line', 'LINE', '{}', 'active', '2026-07-01', '2026-07-01')",
    );
    fixture.account.execute(
      "INSERT INTO line_destinations (id, connection_id, destination_id, display_name, kind, status, source, discovered_at, updated_at) VALUES ('handle-1', 'line-connection', 'Cgroup0001', '役員グループ', 'group', 'discovered', 'webhook', '2026-07-30', '2026-07-30')",
    );

    const { attention } = await read(fixture);

    expect(attention).toEqual([
      { kind: 'ai_missing', count: 1, detail: '' },
      { kind: 'exception', count: 1, detail: 'AI 接続が応答しませんでした。' },
      { kind: 'unlinked_line', count: 1, detail: '役員グループ' },
    ]);
  });

  it('shows the next Scheduled Events with how they were answered, whatever offset their times were written in', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'ended', startsAt: '2026-07-31T10:00:00.000Z', endsAt: '2026-07-31T12:00:00.000Z' });
    seedScheduledEvent(fixture.account, { id: 'later', title: '定例会', startsAt: '2026-08-22T19:00:00+09:00', endsAt: '2026-08-22T20:30:00+09:00' });
    seedScheduledEvent(fixture.account, { id: 'sooner', title: '総会', startsAt: '2026-08-20T01:00:00.000Z', endsAt: '2026-08-20T03:00:00.000Z', attendanceDeadline: '2026-08-15' });
    seedScheduledEvent(fixture.account, { id: 'cancelled', startsAt: '2026-08-05T01:00:00.000Z', endsAt: '2026-08-05T03:00:00.000Z', status: 'cancelled' });
    seedAttendanceRegistration(fixture.account, { eventId: 'sooner', contactId: 'contact-1', destination: 'U0000000000000000000000000000001', status: 'attending' });
    seedAttendanceRegistration(fixture.account, { eventId: 'sooner', contactId: 'contact-2', destination: 'U0000000000000000000000000000002' });

    const { upcomingEvents } = await read(fixture);

    expect(upcomingEvents.map((event) => event.id)).toEqual(['sooner', 'later']);
    expect(upcomingEvents[0]).toMatchObject({ title: '総会', attending: 1, notAttending: 0, unanswered: 1, responseDeadline: '2026-08-15' });
  });
});
