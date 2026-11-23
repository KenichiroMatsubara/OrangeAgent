import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, automation, connections, run, skill, transcript } from './fixtures';
import { renderScreen } from './render';
import * as screenModule from './automation';

fakeApi();

const path = 'automations/:automationId';
const url = `/automations/automation-1`;

describe('Automation screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.automation).mockResolvedValue(automation());
    vi.mocked(api.skills).mockResolvedValue([skill(), skill({ id: 'skill-2', name: '出欠の集計', description: '出欠の返事をまとめるとき。' })]);
    vi.mocked(api.connections).mockResolvedValue(connections());
    vi.mocked(api.runs).mockResolvedValue([run()]);
  });

  it('says what is missing, and that whom it tells is its Skills\' to say', async () => {
    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: false, model: '', models: [], provider: null } }));
    renderScreen(path, screenModule, url);

    expect(await screen.findByRole('heading', { level: 1, name: '朝の確認' })).toBeTruthy();
    expect(screen.getByText(/AI 接続が設定されていません。この自動化は動けません。/u)).toBeTruthy();
    expect(screen.getByText(/誰に送るかは、スキルの本文に書きます。/u)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '届けてよい相手' })).toBeNull();
    expect(api.automation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1');
  });

  it('says a web search it may use needs Claude, and only where the AI Connection is not', async () => {
    vi.mocked(api.automation).mockResolvedValue(automation({ tools: ['web.search'] }));
    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: true, model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'], provider: 'openai' } }));
    const { unmount } = renderScreen(path, screenModule, url);

    expect(await screen.findByText(/いまの AI 接続では、この自動化はウェブを調べません。/u)).toBeTruthy();
    unmount();

    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], provider: 'anthropic' } }));
    renderScreen(path, screenModule, url);
    expect(await screen.findByRole('heading', { level: 1, name: '朝の確認' })).toBeTruthy();
    expect(screen.queryByText(/いまの AI 接続では、この自動化はウェブを調べません。/u)).toBeNull();
  });

  it('thinks with a model the AI Connection names, chosen from those alone, or with its default', async () => {
    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5'], provider: 'anthropic' } }));
    vi.mocked(api.updateAutomation).mockResolvedValue(automation({ model: 'claude-opus-5-5' }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    const field = await screen.findByRole('combobox', { name: '使う model' });
    expect(within(field).getAllByRole('option').map((option) => option.textContent)).toEqual(['既定（Claude Sonnet 5.5）', 'Claude Opus 5.5']);
    await user.selectOptions(field, 'claude-opus-5-5');

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', { model: 'claude-opus-5-5' }));
  });

  it('says it thinks with the default once the model it names is off the AI Connection', async () => {
    vi.mocked(api.automation).mockResolvedValue(automation({ model: 'claude-opus-4-1' }));
    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], provider: 'anthropic' } }));
    renderScreen(path, screenModule, url);

    expect(await screen.findByText(/Claude Opus 4.1 は AI 接続から外れたため、既定の Claude Sonnet 5.5 で動きます。/u)).toBeTruthy();
  });

  it('changes when it runs, in Tokyo, together with its name', async () => {
    vi.mocked(api.updateAutomation).mockResolvedValue(automation({ schedule: 'weekly fri 09:00' }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    expect(await screen.findByText(/毎日 09:00 ・ 次は/u)).toBeTruthy();
    const when = screen.getByRole('region', { name: 'いつ動くか' });
    await user.click(within(when).getByRole('radio', { name: '毎週' }));
    await user.selectOptions(within(when).getByRole('combobox', { name: '曜日' }), 'fri');
    await user.click(within(when).getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', { name: '朝の確認', schedule: 'weekly fri 09:00' }));
  });

  it('shows its Skills, and adds one after the ones it already names', async () => {
    vi.mocked(api.updateAutomation).mockResolvedValue(automation({ skillIds: ['prompt-1', 'skill-2'] }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    expect(await screen.findByRole('checkbox', { name: /Morning check/u })).toHaveProperty('checked', true);
    await user.click(screen.getByRole('checkbox', { name: /出欠の集計/u }));

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', { skillIds: ['prompt-1', 'skill-2'] }));
  });

  it('keeps the last Skill, because an Automation cannot run on none', async () => {
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    await user.click(await screen.findByRole('checkbox', { name: /Morning check/u }));

    expect(api.updateAutomation).not.toHaveBeenCalled();
  });

  it('says when a Skill it needs is gone', async () => {
    vi.mocked(api.skills).mockResolvedValue([]);
    renderScreen(path, screenModule, url);

    expect(await screen.findByText(/選んだスキルが見つかりません/u)).toBeTruthy();
  });

  it('narrows or widens what it may use, of every tool an Automation can call', async () => {
    vi.mocked(api.automation).mockResolvedValue(automation({ tools: ['mail.read', 'tasks.search', 'tasks.create'] }));
    vi.mocked(api.updateAutomation).mockResolvedValue(automation());
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    const granted = await screen.findByRole('group', { name: '使ってよいこと' });

    expect(within(granted).getByRole('checkbox', { name: /メールを読む/u })).toHaveProperty('checked', true);
    expect(within(granted).getByRole('checkbox', { name: /メールを検索する/u })).toHaveProperty('checked', false);
    expect(within(granted).queryByRole('checkbox', { name: /読む人に知らせる/u })).toBeNull();
    await user.click(within(granted).getByRole('checkbox', { name: /メッセージを送る/u }));

    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', {
      tools: ['mail.read', 'tasks.search', 'tasks.create', 'channel.send'],
    }));
  });

  it('turns it on and changes how its writes are applied', async () => {
    vi.mocked(api.automation).mockResolvedValue(automation({ enabled: false }));
    vi.mocked(api.updateAutomation).mockResolvedValue(automation());
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    const mode = await screen.findByRole('region', { name: '実行のしかた' });

    await user.click(within(mode).getByRole('switch', { name: /決まった時刻に動かす/u }));
    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', { enabled: true }));
    await user.selectOptions(within(mode).getByRole('combobox', { name: '書き込みのしかた' }), 'approval');
    await waitFor(() => expect(api.updateAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1', { executionMode: 'approval' }));
  });

  it('reads only its own runs, and decides a pending one where it was planned', async () => {
    vi.mocked(api.runs).mockResolvedValueOnce([run({ writes: [{ id: 'write-1', key: 'k', tool: 'tasks.create', arguments: { title: '会費を払う', due: null }, dependsOn: [], status: 'planned', attempts: 0, result: null, error: null }] })])
      .mockResolvedValue([run({ status: 'completed' })]);
    vi.mocked(api.decideRun).mockResolvedValue(run({ status: 'completed' }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    const history = await screen.findByRole('region', { name: '実行履歴' });
    expect(await within(history).findByText('タスク: 会費を払う')).toBeTruthy();
    await user.click(within(history).getByRole('button', { name: 'すべて承認して実行' }));

    await waitFor(() => expect(api.decideRun).toHaveBeenCalledWith(ACCOUNT_ID, 'run-1', 'approve'));
    expect(await within(history).findByText('完了')).toBeTruthy();
    expect(api.runs).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1');
  });

  it('rejects a pending run', async () => {
    vi.mocked(api.decideRun).mockResolvedValue(run({ status: 'rejected' }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    const history = await screen.findByRole('region', { name: '実行履歴' });
    await user.click(await within(history).findByRole('button', { name: 'すべて却下' }));

    await waitFor(() => expect(api.decideRun).toHaveBeenCalledWith(ACCOUNT_ID, 'run-1', 'reject'));
  });

  it('opens what the AI read beside the run', async () => {
    vi.mocked(api.runTranscript).mockResolvedValue(transcript());
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    await user.click(await screen.findByRole('button', { name: 'AI が読んだもの' }));

    const sheet = await screen.findByRole('dialog', { name: 'AI が読んだもの' });
    expect(within(sheet).getByText('Run now. This Automation has not run before.')).toBeTruthy();
    expect(within(sheet).getByText('予定を1件作成しました。')).toBeTruthy();
    expect(api.runTranscript).toHaveBeenCalledWith(ACCOUNT_ID, 'run-1');
  });

  it('runs now on trial and shows what it would write, without writing it', async () => {
    vi.mocked(api.tryAutomation).mockResolvedValue({
      automation: { id: 'automation-1', revision: 3 },
      model: 'test-model', output: '総会の予定を作り、役員に知らせます。', toolCalls: 4, tokens: 1200, error: null,
      planned: [
        { tool: 'create_scheduled_event', arguments: { title: '総会', startsAt: '2026-09-01T19:00:00+09:00', messageId: 'gmail-1' } },
        { tool: 'channel.send', arguments: { channel: 'line', contactId: 'contact-1', text: '9/1 総会です。' } },
      ],
    });
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    const trial = await screen.findByRole('region', { name: '試しに動かす' });
    await user.click(within(trial).getByRole('button', { name: '試しに動かす' }));

    expect(await within(trial).findByText('カレンダーに予定を入れる')).toBeTruthy();
    expect(within(trial).getByText('メッセージを送る')).toBeTruthy();
    expect(within(trial).getByText('総会の予定を作り、役員に知らせます。')).toBeTruthy();
    expect(within(trial).getByText(/第3版のスキルで動かしました/u)).toBeTruthy();
    expect(api.tryAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1');
    expect(api.updateAutomation).not.toHaveBeenCalled();
  });

  it('goes back to the Automations, and returns there once one is deleted', async () => {
    vi.mocked(api.removeAutomation).mockResolvedValue({ id: 'automation-1', deleted: true });
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    await screen.findByRole('heading', { level: 1, name: '朝の確認' });
    // The navigation's entry and the screen's own way back both lead to the index.
    expect(screen.getAllByRole('link', { name: '自動化' }).map((link) => link.getAttribute('href'))).toEqual([`/automations`, `/automations`]);
    await user.click(screen.getByRole('button', { name: 'この自動化を削除' }));

    await waitFor(() => expect(api.removeAutomation).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1'));
    expect(await screen.findByText('別の画面')).toBeTruthy();
  });
});
