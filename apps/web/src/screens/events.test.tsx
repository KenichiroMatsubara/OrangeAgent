import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../api';
import { fakeApi } from '../fake';
import { ACCOUNT_ID, eventDetail, eventOverview } from './fixtures';
import * as eventScreen from './event';
import * as events from './events';
import { renderScreen } from './render';

fakeApi();

describe('予定 screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.events).mockImplementation(async (_accountId, view) => view === 'past'
      ? [eventOverview({ id: 'event-0', title: '防災訓練', startsAt: '2026-07-20T00:30:00.000Z', endsAt: '2026-07-20T02:30:00.000Z' })]
      : [
        eventOverview(),
        eventOverview({ id: 'event-2', title: '清掃活動', startsAt: '2026-09-03T00:00:00.000Z', endsAt: '2026-09-03T02:00:00.000Z', attending: 0, notAttending: 0, unanswered: 0, guestsAttending: 0, status: 'cancelled' }),
      ]);
  });

  it('lists the events ahead by month, with who has not answered and who is coming', async () => {
    renderScreen('events', events);

    const august = await screen.findByRole('region', { name: '8月' });
    const meeting = within(august).getByRole('link', { name: /秋季総会/u });
    expect(meeting.textContent).toContain('未回答 5');
    expect(meeting.textContent).toContain('出席 15');
    expect(meeting.getAttribute('href')).toBe(`/events/event-1`);
    expect(within(screen.getByRole('region', { name: '9月' })).getByRole('link', { name: /清掃活動/u }).textContent).toContain('中止');
  });

  it('reads the ended events only when they are asked for', async () => {
    const user = userEvent.setup();
    renderScreen('events', events);
    await screen.findByRole('link', { name: /秋季総会/u });
    expect(api.events).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('radio', { name: '終わった予定' }));

    expect(await screen.findByRole('link', { name: /防災訓練/u })).toBeTruthy();
    expect(api.events).toHaveBeenCalledWith(ACCOUNT_ID, 'past');
  });
});

describe('Scheduled Event screen', () => {
  const path = 'events/:eventId';
  const url = `/events/event-1`;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.event).mockResolvedValue(eventDetail());
  });

  it('shows who answered what, those who have not answered first, the guests, and the mail it came from', async () => {
    renderScreen(path, eventScreen, url);

    expect(await screen.findByRole('heading', { name: '秋季総会' })).toBeTruthy();
    const answers = screen.getByRole('region', { name: '出欠' });
    const rows = within(answers).getAllByRole('link');
    expect(rows.map((row) => row.textContent?.includes('佐藤 花子'))).toEqual([true, false]);
    expect(rows[0]?.textContent).toContain('まだ答えていません');
    expect(rows[1]?.textContent).toContain('山田 太郎');
    expect(within(screen.getByRole('region', { name: '外部からの参加登録' })).getByText('中村 誠')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '元のメール' })).getByText('総会のご案内')).toBeTruthy();
    expect(screen.getByText(/回答期限は8月15日（土）です。/u)).toBeTruthy();
  });

  it('says so inside the shell when the event does not exist', async () => {
    vi.mocked(api.event).mockRejectedValue(new ApiError({ code: 'not_found', message: 'Event was not found.' }, 404));
    renderScreen(path, eventScreen, url);

    expect(await screen.findByText('この画面の対象が見つかりません。')).toBeTruthy();
  });
});
