import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, automationStatus, connections, contact, delivery, exception } from './fixtures';
import { renderScreen } from './render';
import * as operations from './operations';

fakeApi();

describe('Operations screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.exceptions).mockResolvedValue([exception()]);
    vi.mocked(api.warnings).mockResolvedValue([]);
    vi.mocked(api.stuckJobs).mockResolvedValue([{ id: 'job-1', kind: 'deliver', state: 'failed', attempts: 5, availableAt: '', lastError: 'LINE 500', updatedAt: '2026-08-18T09:00:00.000Z' }]);
    vi.mocked(api.deliveries).mockResolvedValue([delivery()]);
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.connections).mockResolvedValue(connections());
    vi.mocked(api.contacts).mockResolvedValue([contact()]);
  });

  it('gathers what went wrong: exceptions, stuck Jobs, and the delivery audit', async () => {
    renderScreen('operations', operations);

    expect(await screen.findByText('AI 接続が未設定')).toBeTruthy();
    expect(screen.getByText(/再試行を使い切りました/u)).toBeTruthy();
    expect(screen.getByText('Uabc1')).toBeTruthy();
    expect(api.automations).not.toHaveBeenCalled();
  });

  it('resolves an exception and re-reads the list', async () => {
    vi.mocked(api.resolveException).mockResolvedValue({ id: 'exception-1' });
    vi.mocked(api.exceptions).mockResolvedValueOnce([exception()]).mockResolvedValue([]);
    const user = userEvent.setup();
    renderScreen('operations', operations);

    await user.click(await screen.findByRole('button', { name: '解決済みにする' }));

    expect(await screen.findByText(/未解決の例外はありません/u)).toBeTruthy();
    expect(api.resolveException).toHaveBeenCalledWith(ACCOUNT_ID, 'exception-1');
  });

});
