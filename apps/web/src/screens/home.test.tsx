import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { automationStatus, dashboard, eventOverview } from './fixtures';
import * as home from './home';
import { renderScreen } from './render';

fakeApi();

// The suite's clock stands at 2026-08-01, 09:00 in Tokyo.

describe('Home screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.dashboard).mockResolvedValue(dashboard({
      attention: [
        { kind: 'pending_approval', count: 2, detail: '毎朝のメール処理' },
        { kind: 'unlinked_line', count: 1, detail: '役員グループ' },
      ],
      upcomingEvents: [eventOverview({ unanswered: 5 })],
    }));
  });

  it('shows each Automation with when it next runs and how its latest run ended, linked to its screen', async () => {
    vi.mocked(api.dashboard).mockResolvedValue(dashboard({
      automations: [
        { id: 'automation-1', name: '毎朝のメール処理', enabled: true, schedule: 'daily 05:00', nextRunAt: '2026-08-01T20:00:00.000Z', lastRun: { id: 'run-1', startedAt: '2026-07-31T20:00:00.000Z', status: 'failed', error: 'model unavailable' } },
        { id: 'automation-2', name: 'タスクのリマインド', enabled: false, schedule: 'daily 07:00', nextRunAt: null, lastRun: null },
      ],
    }));
    renderScreen('home', home);

    const section = await screen.findByRole('region', { name: '自動化' });
    const mail = within(section).getByRole('link', { name: /毎朝のメール処理/u });
    expect(mail.textContent).toContain('次は明日 05:00');
    expect(mail.textContent).toContain('失敗');
    expect(mail.getAttribute('href')).toBe(`/automations/automation-1`);
    const reminders = within(section).getByRole('link', { name: /タスクのリマインド/u });
    expect(reminders.textContent).toContain('毎日 07:00');
    expect(reminders.textContent).toContain('まだ動いていません');
    expect(reminders.textContent).toContain('オフ');
  });

  it('lists what needs the Account, each linked to the screen that resolves it, with the total in the heading', async () => {
    renderScreen('home', home);

    const attention = await screen.findByRole('region', { name: /要対応/u });
    expect(within(attention).getByLabelText('3件')).toBeTruthy();
    expect(within(attention).getByRole('link', { name: /承認待ちの実行 2件/u }).getAttribute('href')).toBe(`/automations`);
    expect(within(attention).getByRole('link', { name: /承認待ちの実行 2件/u }).textContent).toContain('毎朝のメール処理の画面で承認します');
    expect(within(attention).getByRole('link', { name: /LINE から届いた相手 1件/u }).textContent).toContain('役員グループを連絡先に結び付けると届けられます');
  });

  it('says plainly when nothing needs the Account', async () => {
    vi.mocked(api.dashboard).mockResolvedValue(dashboard());
    renderScreen('home', home);

    expect(await screen.findByText('対応が必要なものはありません')).toBeTruthy();
  });

  it('shows the next events with who has not answered', async () => {
    renderScreen('home', home);

    const event = await screen.findByRole('link', { name: /秋季総会/u });
    expect(event.textContent).toContain('未回答 5');
    expect(event.getAttribute('href')).toBe(`/events/event-1`);
  });

  it('asks for the Google grant again when it was revoked', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ status: 'reauthentication_required' }));
    renderScreen('home', home);

    expect(await screen.findByRole('button', { name: 'メールの受信箱を再接続する' })).toBeTruthy();
  });
});
