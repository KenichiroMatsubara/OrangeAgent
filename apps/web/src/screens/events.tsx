import { CalendarDays } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useLoaderData } from 'react-router-dom';

import type { EventOverview } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { dateParts, timeLabel } from '../time';
import { Segmented } from '../ui/choice';
import { Deferred, later } from '../ui/deferred';
import { List, Row } from '../ui/list';
import { Chip, Chips, DateBadge, Empty } from '../ui/notice';
import { Page, Section } from '../ui/page';
import { SkeletonRows } from '../ui/skeleton';

export interface EventsData {
  upcoming: Promise<EventOverview[]>;
}

/** Returns at once; the events still ahead fill in as they are read. */
export const loader = async (): Promise<EventsData> => ({ upcoming: later(api.events(await accountIdOf())) });

/** How a Scheduled Event was answered, in chips: who has not answered stands out. */
export const answerChips = (event: EventOverview): ReactNode => <Chips>
  {event.status === 'cancelled' && <Chip tone="muted">中止</Chip>}
  {event.unanswered > 0 && <Chip tone="warn">未回答 {event.unanswered}</Chip>}
  {event.attending + event.guestsAttending > 0 && <Chip tone="brand">出席 {event.attending + event.guestsAttending}</Chip>}
</Chips>;

const byMonth = (events: readonly EventOverview[]): Array<{ month: string; events: EventOverview[] }> => {
  const groups: Array<{ month: string; events: EventOverview[] }> = [];
  for (const event of events) {
    const { month } = dateParts(event.startsAt);
    const label = `${month}月`;
    const last = groups.at(-1);
    if (last?.month === label) last.events.push(event);
    else groups.push({ month: label, events: [event] });
  }
  return groups;
};

const EventList = ({ events, empty }: { events: readonly EventOverview[]; empty: string }) => events.length === 0
  ? <Empty icon={<CalendarDays size={32} aria-hidden="true" />} title={empty} text="メールから予定が見つかると、ここに並びます。" />
  : <>{byMonth(events).map((group) => <Section key={group.month} title={group.month}>
    <List>{group.events.map((event) => <Row
      key={event.id}
      to={encodeURIComponent(event.id)}
      leading={<DateBadge value={event.startsAt} />}
      title={event.title}
      sub={[`${timeLabel(event.startsAt)}〜${timeLabel(event.endsAt)}`, event.location].filter(Boolean).join(' ・ ')}
      aside={answerChips(event)}
    />)}</List>
  </Section>)}</>;

type View = 'upcoming' | 'past';

/** The Scheduled Events and who has answered. They are read here and corrected in Calendar. */
const EventsScreen = () => {
  const data = useLoaderData<EventsData>();
  const { account } = useAccount();
  const [view, setView] = useState<View>('upcoming');
  const [past, setPast] = useState<Promise<EventOverview[]> | null>(null);
  const choose = (next: View): void => {
    setView(next);
    if (next === 'past' && !past) setPast(later(api.events(account.accountId, 'past')));
  };
  return <Page title="予定" lead="日時や場所の修正は Google カレンダーで行います。">
    <Segmented label="表示する予定" value={view} onChange={choose} options={[{ value: 'upcoming', label: 'これから' }, { value: 'past', label: '終わった予定' }]} />
    {view === 'upcoming'
      ? <Deferred value={data.upcoming} fallback={<SkeletonRows count={4} />}>{(events) => <EventList events={events} empty="これからの予定はありません" />}</Deferred>
      : past && <Deferred value={past} fallback={<SkeletonRows count={4} />}>{(events) => <>
        <EventList events={events} empty="終わった予定はありません" />
      </>}</Deferred>}
  </Page>;
};

export default EventsScreen;
