import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, automationStatus, connections as connectionsView, contactList } from './fixtures';
import { renderScreen } from './render';
import * as connections from './connections';

fakeApi();

describe('Connections screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ ai: { apiKeyConfigured: false, model: '', models: [], provider: null } }));
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
    vi.mocked(api.accessTokens).mockResolvedValue([]);
    vi.mocked(api.operatorTokens).mockResolvedValue([]);
    vi.mocked(api.mcpEndpoint).mockResolvedValue({ url: 'https://orangeagent.example/api/public/organizations/org-1/mcp' });
    vi.mocked(api.mcpServers).mockResolvedValue([{ id: 'server-1', name: 'notion', url: 'https://example.com/mcp', revision: null, authentication: 'token', signInError: null, updatedAt: '2026-08-18T09:00:00.000Z' }]);
  });

  it('holds what the whole Account shares: its services, its outside tools, and the keys it lent', async () => {
    renderScreen('connections', connections);

    const services = await screen.findByRole('region', { name: 'サービス' });
    expect(within(services).getByText('inbox@example.com ・ Gmail・カレンダー・Drive・Meet')).toBeTruthy();
    expect(within(services).getByRole('button', { name: /AI/u }).textContent).toContain('未設定');
    expect(await screen.findByText('notion')).toBeTruthy();
    expect(screen.getByRole('region', { name: '外部エージェント用の鍵' })).toBeTruthy();
    expect(api.automations).not.toHaveBeenCalled();
  });

  it('asks for the Google grant again when it was revoked', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ status: 'reauthentication_required' }));
    renderScreen('connections', connections);

    expect(await screen.findByText(/Google の認証が切れました/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メールの受信箱を再接続する' })).toBeTruthy();
  });

  it('asks for the Google grant again when it was given before drafts existed', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ draftsGranted: false }));
    renderScreen('connections', connections);

    expect(await screen.findByText(/下書きを保存する許可がまだありません/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メールの受信箱を再接続する' })).toBeTruthy();
  });

  it('asks for the Google grant again when it was given before the Drive was reached', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ driveGranted: false }));
    renderScreen('connections', connections);

    expect(await screen.findByText(/Drive を読み書きする許可がまだありません/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メールの受信箱を再接続する' })).toBeTruthy();
  });

  it('asks for the Google grant again when it was given before Meet was reached', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ meetGranted: false }));
    renderScreen('connections', connections);

    expect(await screen.findByText(/Google Meet の会議を読む許可がまだありません/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メールの受信箱を再接続する' })).toBeTruthy();
  });

  it('saves the AI Connection once a provider, a model, and its key are present, with no Base URL to type', async () => {
    vi.mocked(api.saveAiConnection).mockResolvedValue({ apiKeyConfigured: true, model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'], provider: 'openai' });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /AI/u }));
    const sheet = await screen.findByRole('dialog', { name: 'AI' });
    const save = within(sheet).getByRole('button', { name: 'AI 接続を保存' });
    expect(save).toHaveProperty('disabled', true);
    expect(within(sheet).queryByLabelText('Base URL')).toBeNull();
    expect(within(sheet).getByRole('radiogroup', { name: '接続先' })).toBeTruthy();
    await user.click(within(sheet).getByRole('radio', { name: 'OpenAI' }));
    expect(within(sheet).getByText(/OpenAI のコードインタープリターでコードを動かします/u)).toBeTruthy();
    await user.type(within(sheet).getByLabelText('model を名前で追加'), 'gpt-4.1-mini{Enter}');
    await user.type(within(sheet).getByLabelText('OpenAI の API キー'), 'sk-test');
    await user.click(save);

    await waitFor(() => expect(api.saveAiConnection).toHaveBeenCalledWith(ACCOUNT_ID, { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'] }));
    await waitFor(() => expect(api.connections).toHaveBeenCalledTimes(2));
  });

  it('saves the OpenRouter key recordings are transcribed with, apart from the AI Connection, naming the default model', async () => {
    vi.mocked(api.saveTranscriptionConnection).mockResolvedValue({ apiKeyConfigured: true, model: 'microsoft/mai-transcribe-2' });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /AI/u }));
    const sheet = within(await screen.findByRole('dialog', { name: 'AI' })).getByRole('form', { name: '文字起こし' });
    expect(within(sheet).getByText('登録するまで、録音を文字起こしできません。')).toBeTruthy();
    expect(within(sheet).getByLabelText('文字起こしの model')).toHaveProperty('value', 'microsoft/mai-transcribe-2');
    const save = within(sheet).getByRole('button', { name: '文字起こしを保存' });
    expect(save).toHaveProperty('disabled', true);
    await user.type(within(sheet).getByLabelText('文字起こし用の OpenRouter の API キー'), 'sk-or-test');
    await user.click(save);

    await waitFor(() => expect(api.saveTranscriptionConnection).toHaveBeenCalledWith(ACCOUNT_ID, { apiKey: 'sk-or-test', model: 'microsoft/mai-transcribe-2' }));
    expect(api.saveAiConnection).not.toHaveBeenCalled();
  });

  it('shows the transcription model saved, and removes it', async () => {
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ transcription: { apiKeyConfigured: true, model: 'x-ai/grok-stt-1.0' } }));
    vi.mocked(api.removeTranscriptionConnection).mockResolvedValue({ apiKeyConfigured: false, model: '' });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    expect((await screen.findByRole('button', { name: /AI/u })).textContent).toContain('文字起こし あり');
    await user.click(screen.getByRole('button', { name: /AI/u }));
    const sheet = within(await screen.findByRole('dialog', { name: 'AI' })).getByRole('form', { name: '文字起こし' });
    expect(within(sheet).getByLabelText('文字起こしの model')).toHaveProperty('value', 'x-ai/grok-stt-1.0');
    await user.click(within(sheet).getByRole('button', { name: '文字起こしを外す' }));

    await waitFor(() => expect(api.removeTranscriptionConnection).toHaveBeenCalledWith(ACCOUNT_ID));
  });

  it('adds models from the Claude suggestions and by name, makes one the default, and takes one off', async () => {
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ ai: { apiKeyConfigured: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], provider: 'anthropic' } }));
    vi.mocked(api.saveAiConnection).mockResolvedValue({ apiKeyConfigured: true, model: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-1'], provider: 'anthropic' });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /AI/u }));
    const sheet = await screen.findByRole('dialog', { name: 'AI' });
    const save = within(sheet).getByRole('button', { name: 'AI 接続を保存' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(within(sheet).getByRole('button', { name: 'Claude Opus 5.5 を追加' }));
    await user.click(within(sheet).getByRole('button', { name: 'Claude Haiku 5.5 を追加' }));
    await user.type(within(sheet).getByLabelText('ほかの model を名前で追加'), ' claude-opus-4-1 {Enter}');
    await user.type(within(sheet).getByLabelText('ほかの model を名前で追加'), 'claude-opus-4-1{Enter}');
    expect(within(sheet).getByText('この model はもう登録されています。')).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Claude Opus 5.5 を既定にする' }));
    await user.click(within(sheet).getByRole('button', { name: 'Claude Haiku 5.5 を外す' }));
    const [first] = within(within(sheet).getByRole('list', { name: '登録した model' })).getAllByRole('listitem');
    expect(within(first as HTMLElement).getByText('既定')).toBeTruthy();
    await user.click(save);

    await waitFor(() => expect(api.saveAiConnection).toHaveBeenCalledWith(ACCOUNT_ID, {
      provider: 'anthropic', model: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-1'],
    }));
  });

  it('opens at the AI Connection when the chat sends a person to add a model', async () => {
    renderScreen('connections', connections, '/connections?sheet=ai');

    expect(await screen.findByRole('dialog', { name: 'AI' })).toBeTruthy();
  });

  it('offers the Claude models once Claude is chosen, and says where each provider runs code', async () => {
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /AI/u }));
    const sheet = await screen.findByRole('dialog', { name: 'AI' });
    expect(within(sheet).getByText('接続先を選んでください。')).toBeTruthy();
    await user.click(within(sheet).getByRole('radio', { name: 'Claude' }));
    expect(within(sheet).getByText(/Anthropic のサンドボックス/u)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Claude Sonnet 5.5 を追加' })).toBeTruthy();
    await user.click(within(sheet).getByRole('radio', { name: 'OpenRouter' }));
    expect(within(sheet).getByText(/OrangeAgent が用意する実行環境/u)).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Claude Sonnet 5.5 を追加' })).toBeNull();
  });

  it('asks for the new provider’s key, and forgets the models of the one before, when the provider changes', async () => {
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ ai: { apiKeyConfigured: true, model: 'gpt-5.5', models: ['gpt-5.5'], provider: 'openai' } }));
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /AI/u }));
    const sheet = await screen.findByRole('dialog', { name: 'AI' });
    await user.click(within(sheet).getByRole('radio', { name: 'Gemini' }));
    expect(within(sheet).queryByRole('list', { name: '登録した model' })).toBeNull();
    await user.type(within(sheet).getByLabelText('model を名前で追加'), 'gemini-3-flash{Enter}');
    const save = within(sheet).getByRole('button', { name: 'AI 接続を保存' });
    expect(save).toHaveProperty('disabled', true);
    await user.type(within(sheet).getByLabelText('Gemini の API キー'), 'gemini-key');
    expect(save).toHaveProperty('disabled', false);
  });

  it('says a Connection saved on another API goes on answering until it is saved on one of the four', async () => {
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ ai: { apiKeyConfigured: true, model: 'deepseek-chat', models: ['deepseek-chat'], provider: null } }));
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /以前の接続先 ・ deepseek-chat/u }));
    const sheet = await screen.findByRole('dialog', { name: 'AI' });
    expect(within(sheet).getByText(/ここで選べる 4 つ以外の接続先です/u)).toBeTruthy();
  });

  it('connects a Microsoft account so Office makes the PDFs, and says Google makes them until then', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    vi.mocked(api.connectMicrosoft).mockResolvedValue({ authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=s' });
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /Microsoft/u }));
    const sheet = await screen.findByRole('dialog', { name: 'Microsoft' });
    expect(within(sheet).getByText(/つながないときは Google ドライブが PDF にします/u)).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Microsoft につなぐ' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=s'));
    vi.unstubAllGlobals();
  });

  it('signs in to an outside tool by OAuth, and says which one must be signed in to again and what waits on it', async () => {
    vi.mocked(api.mcpServers).mockResolvedValue([
      { id: 'server-1', name: 'notion', url: 'https://example.com/mcp', revision: null, authentication: 'token', signInError: null, updatedAt: '2026-08-18T09:00:00.000Z' },
      { id: 'server-2', name: 'linear', url: 'https://mcp.linear.example/mcp', revision: null, authentication: 'oauth', signInError: 'サインインが切れました。もう一度サインインしてください。', updatedAt: '2026-08-18T09:00:00.000Z' },
    ]);
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    vi.mocked(api.authorizeMcpServer).mockResolvedValue({ authorizationUrl: 'https://auth.linear.example/authorize?state=s' });
    renderScreen('connections', connections);

    expect(await screen.findByText(/linear: サインインが切れました。もう一度サインインしてください。 それまで、自動化とチャットはこのツールを使えません。/u)).toBeTruthy();
    expect(screen.getByText('https://example.com/mcp ・ トークンあり')).toBeTruthy();
    expect(screen.getByText('https://mcp.linear.example/mcp ・ サインインが必要です')).toBeTruthy();
    // A server called with a static token is not signed in to.
    expect(screen.queryByRole('button', { name: 'notion にサインイン' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'linear にサインイン' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.linear.example/authorize?state=s'));
    expect(api.authorizeMcpServer).toHaveBeenCalledWith(ACCOUNT_ID, 'server-2');
    vi.unstubAllGlobals();
  });

  it('says a Microsoft account cannot be connected until the deployment registers the app, and shows the one connected', async () => {
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ microsoft: { configured: false, connected: false, email: null } }));
    const user = userEvent.setup();
    const { unmount } = renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: /Microsoft/u }));
    const sheet = await screen.findByRole('dialog', { name: 'Microsoft' });
    expect(within(sheet).getByText(/Microsoft のアプリが登録されていない/u)).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Microsoft につなぐ' })).toBeNull();
    unmount();

    vi.mocked(api.connections).mockResolvedValue(connectionsView({ microsoft: { configured: true, connected: true, email: 'taro@example.com' } }));
    renderScreen('connections', connections, `/connections?microsoft=connected`);
    expect(await screen.findByText('Microsoft とつながりました。これからの PDF は Office が作ります。')).toBeTruthy();
    expect(screen.getByText('taro@example.com ・ PDF を Word と同じ見た目で作ります')).toBeTruthy();
  });

  it('issues a key for an outside agent bounded to one Contact List, and shows it once', async () => {
    vi.mocked(api.issueAccessToken).mockResolvedValue({ id: 'token-1', name: 'cowork', tools: ['query_contacts'], token: 'secret-token', url: 'https://orangeagent.example/api/public/organizations/org-1/mcp' });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    await user.click(await screen.findByRole('button', { name: '鍵を発行' }));
    const sheet = await screen.findByRole('dialog', { name: '外部エージェント用の鍵を発行' });
    await user.type(within(sheet).getByRole('textbox', { name: '名前' }), 'cowork');
    await user.click(within(sheet).getByRole('button', { name: '発行する' }));

    await waitFor(() => expect(api.issueAccessToken).toHaveBeenCalledWith(ACCOUNT_ID, {
      name: 'cowork', contactListId: 'list-1', tools: ['query_contacts', 'channel.send', 'reminder.schedule'], suppressionWindow: 'day',
    }));
    expect(await within(sheet).findByDisplayValue('secret-token')).toBeTruthy();
  });

  it('shows a member a Login Code for their CLI, and lists the CLIs signed in with one', async () => {
    vi.mocked(api.operatorTokens).mockResolvedValue([{ id: 'operator-1', email: 'owner@example.com', client: null, createdAt: '2026-08-18T09:00:00.000Z', expiresAt: '2026-11-16T09:00:00.000Z', lastUsedAt: null }]);
    vi.mocked(api.issueLoginCode).mockResolvedValue({
      code: 'K7QF-2M9X', expiresAt: '2026-08-18T09:10:00.000Z',
      exchangeUrl: 'https://orangeagent.example/api/public/organizations/org-1/operator-tokens',
      serverUrl: 'https://orangeagent.example/api/public/organizations/org-1/mcp',
    });
    const user = userEvent.setup();
    renderScreen('connections', connections);

    const section = await screen.findByRole('region', { name: 'CLI とアプリからのログイン' });
    expect(within(section).getByText('CLI ・ owner@example.com')).toBeTruthy();
    expect(within(section).getByText(/11月16日（月）まで ・ まだ使われていません/u)).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'ログインコードを表示' }));
    const sheet = await screen.findByRole('dialog', { name: 'CLI にログイン' });
    await user.click(within(sheet).getByRole('button', { name: 'ログインコードを表示' }));

    await waitFor(() => expect(api.issueLoginCode).toHaveBeenCalledWith(ACCOUNT_ID));
    expect(await within(sheet).findByText('K7QF-2M9X')).toBeTruthy();
    expect(within(sheet).getByText(/18:10まで、一度だけ使えます/u)).toBeTruthy();
  });

  it('gives the MCP Server URL an app such as Claude connects to, and lists an app a member approved by its name', async () => {
    vi.mocked(api.operatorTokens).mockResolvedValue([{ id: 'operator-2', email: 'owner@example.com', client: 'Claude', createdAt: '2026-08-18T09:00:00.000Z', expiresAt: '2026-11-16T09:00:00.000Z', lastUsedAt: null }]);
    renderScreen('connections', connections);

    const section = await screen.findByRole('region', { name: 'CLI とアプリからのログイン' });
    expect(within(section).getByDisplayValue('https://orangeagent.example/api/public/organizations/org-1/mcp')).toBeTruthy();
    expect(within(section).getByText('Claude ・ owner@example.com')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'owner@example.com のClaudeログインを取り消す' })).toBeTruthy();
  });
});
