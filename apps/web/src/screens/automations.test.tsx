import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '@mail/domain';

import { api } from '../api';
import { fakeApi } from '../fake';
import { RunHistory } from '../history';
import { ACCOUNT_ID, automation, run, skill } from './fixtures';
import { renderScreen } from './render';
import * as automations from './automations';

fakeApi();

const history = (runs: Run[]): string => renderToStaticMarkup(<RunHistory runs={runs} pending={() => false} onDecide={() => undefined} onTranscript={() => undefined} />);

describe('Automation run history', () => {
  it('shows what a completed run reported', () => {
    const markup = history([run({ status: 'completed', output: '未回答は2名でした。', transcript: false })]);

    expect(markup).toContain('未回答は2名でした。');
    expect(markup).toContain('完了');
    expect(markup).toContain('第2版');
    expect(markup).not.toContain('すべて承認して実行');
  });

  it('shows why a run failed rather than hiding it', () => {
    const markup = history([run({ status: 'failed', output: null, error: 'Skill was not found.' })]);

    expect(markup).toContain('Skill was not found.');
    expect(markup).toContain('失敗');
  });

  it('offers the approval where a run waits for it, with what it would write', () => {
    const markup = history([run({ writes: [{ id: 'write-1', key: 'k', tool: 'channel.send', arguments: { destination: '役員グループ', text: '会費のお願い' }, dependsOn: [], status: 'planned', attempts: 0, result: null, error: null }] })]);

    expect(markup).toContain('承認待ち');
    expect(markup).toContain('メッセージを送る');
    expect(markup).toContain('送信先: 役員グループ');
    expect(markup).toContain('すべて承認して実行');
    expect(markup).toContain('すべて却下');
    expect(markup).toContain('AI が読んだもの');
  });

  it('titles a run with no mail by what started it', () => {
    expect(history([run({ trigger: 'schedule', sourceMessage: null, status: 'completed' })])).toContain('決まった時刻の実行');
  });

  it('says nothing has run yet rather than rendering an empty list', () => {
    expect(history([])).toContain('まだ動いていません');
  });
});

describe('Automation schedules', () => {
  it('reads and writes the Worker’s schedule grammar, and says it as a person would', () => {
    expect(automations.scheduleParts('weekly mon 07:30')).toEqual({ cadence: 'weekly', weekday: 'mon', time: '07:30', minute: '00' });
    expect(automations.scheduleText({ cadence: 'hourly', weekday: 'mon', time: '09:00', minute: '15' })).toBe('hourly :15');
    expect(automations.scheduleLabel('daily 09:00')).toBe('毎日 09:00');
    expect(automations.scheduleLabel('weekly mon 07:30')).toBe('毎週月曜 07:30');
    expect(automations.scheduleLabel('hourly :05')).toBe('毎時 5分');
  });
});


describe('Automations screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.automations).mockResolvedValue([
      automation({ id: 'automation-mail', name: '毎朝のメール処理', schedule: 'daily 05:00' }),
      automation(),
    ]);
    vi.mocked(api.skills).mockResolvedValue([skill()]);
    vi.mocked(api.presets).mockResolvedValue([{ id: 'membership-organization', name: '会員組織', description: '最初の構成です。' }]);
  });

  it('lists every Automation with when it runs and next runs, in Japanese time, and what Skills it runs', async () => {
    renderScreen('automations', automations);

    const row = await screen.findByRole('link', { name: /朝の確認/u });
    expect(row.textContent).toContain('毎日 09:00');
    expect(row.textContent).toContain('次は9月3日（木）09:00');
    expect(row.textContent).toContain('スキル: Morning check');
    expect(row.getAttribute('href')).toBe(`/automations/automation-1`);
    expect(screen.getByRole('link', { name: /毎朝のメール処理/u }).textContent).toContain('毎日 05:00');
    expect(screen.queryByText('届け先なし')).toBeNull();
  });

  it('marks an Automation whose last run failed, and says when there is none', async () => {
    vi.mocked(api.automations).mockResolvedValueOnce([
      automation({ lastRun: { id: 'run-9', startedAt: '2026-08-18T09:00:00.000Z', status: 'failed', error: 'Skill was not found.' } }),
    ]);
    renderScreen('automations', automations);

    expect((await screen.findByRole('link', { name: /朝の確認/u })).textContent).toContain('失敗');
  });

  it('says there is none yet rather than rendering an empty list', async () => {
    vi.mocked(api.automations).mockResolvedValue([]);
    renderScreen('automations', automations);

    expect(await screen.findByText('まだありません')).toBeTruthy();
  });

  it('adds a draft at a stated time, in Tokyo, that may read and tell whom its Skills name, and opens it', async () => {
    vi.mocked(api.createAutomation).mockResolvedValue(automation({ id: 'automation-2', enabled: false }));
    const user = userEvent.setup();
    renderScreen('automations', automations);

    await user.click(await screen.findByRole('button', { name: '追加' }));
    const sheet = await screen.findByRole('dialog', { name: '自動化を追加' });
    expect(within(sheet).getByText(/誰に送るかは、スキルの本文に書きます。/u)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '追加する' })).toHaveProperty('disabled', true);
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), '週次の確認');
    await user.click(within(sheet).getByRole('radio', { name: '毎週' }));
    await user.selectOptions(within(sheet).getByRole('combobox', { name: '曜日' }), 'fri');
    await user.click(within(sheet).getByRole('button', { name: '追加する' }));

    await waitFor(() => expect(api.createAutomation).toHaveBeenCalledWith(ACCOUNT_ID, {
      name: '週次の確認', enabled: false, schedule: 'weekly fri 09:00', executionMode: 'unattended', skillIds: ['prompt-1'], suppressionWindow: 'day', model: null,
      tools: ['query_scheduled_events', 'query_contacts', 'query_attendance', 'mail.search', 'mail.read', 'calendar.search', 'drive.search', 'drive.read', 'meet.search', 'meet.read', 'tasks.search', 'web.search', 'memory.search', 'channel.send', 'mail.send'],
    }));
    expect(await screen.findByText('別の画面')).toBeTruthy();
  });

  it('keeps the sheet and what was typed when the Worker refuses the Automation', async () => {
    vi.mocked(api.createAutomation).mockRejectedValue(new Error('An Automation needs at least one Skill.'));
    const user = userEvent.setup();
    renderScreen('automations', automations);

    await user.click(await screen.findByRole('button', { name: '追加' }));
    const sheet = await screen.findByRole('dialog', { name: '自動化を追加' });
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), '市役所');
    await user.click(within(sheet).getByRole('button', { name: '追加する' }));

    expect(await within(sheet).findByText('An Automation needs at least one Skill.')).toBeTruthy();
    expect(within(sheet).getByRole('textbox', { name: '名前' })).toHaveProperty('value', '市役所');
  });

  it('cannot add one before a Skill exists', async () => {
    vi.mocked(api.skills).mockResolvedValue([]);
    const user = userEvent.setup();
    renderScreen('automations', automations);

    await user.click(await screen.findByRole('button', { name: '追加' }));
    const sheet = await screen.findByRole('dialog', { name: '自動化を追加' });
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), '市役所');

    expect(within(sheet).getByText('先に「スキル」の画面でスキルを作ってください。')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '追加する' })).toHaveProperty('disabled', true);
  });

  it('requires an explicit choice before adding a Preset beside existing configuration, and re-reads the list', async () => {
    vi.mocked(api.applyPreset).mockResolvedValue({ presetId: 'membership-organization', skills: 1, automations: 1 });
    const user = userEvent.setup();
    renderScreen('automations', automations);

    const apply = await screen.findByRole('button', { name: '写す' });
    expect(apply).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox', { name: 'いまの自動化に加えて、別の写しを足す' }));
    await user.click(apply);

    await waitFor(() => expect(api.applyPreset).toHaveBeenCalledWith(ACCOUNT_ID, 'membership-organization', 'duplicate'));
    await waitFor(() => expect(api.automations).toHaveBeenCalledTimes(2));
  });

  it('applies a Preset at once to an Account with nothing configured', async () => {
    vi.mocked(api.automations).mockResolvedValue([]);
    vi.mocked(api.skills).mockResolvedValue([]);
    vi.mocked(api.applyPreset).mockResolvedValue({ presetId: 'membership-organization', skills: 1, automations: 1 });
    const user = userEvent.setup();
    renderScreen('automations', automations);

    await user.click(await screen.findByRole('button', { name: '写す' }));

    await waitFor(() => expect(api.applyPreset).toHaveBeenCalledWith(ACCOUNT_ID, 'membership-organization', undefined));
    expect(screen.queryByRole('checkbox', { name: 'いまの自動化に加えて、別の写しを足す' })).toBeNull();
  });
});
