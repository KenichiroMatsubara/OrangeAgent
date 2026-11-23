import { Mail } from 'lucide-react';
import { useLoaderData, type LoaderFunctionArgs } from 'react-router-dom';

import type { EventDetail, RegistrationView } from '@mail/domain';

import { api, ApiError } from '../api';
import { accountIdOf } from '../dashboard';
import { attendance, named } from '../labels';
import { dateLabel, dateTimeLabel, momentLabel, timeLabel } from '../time';
import { List, Row } from '../ui/list';
import { Banner, Chip, Empty } from '../ui/notice';
import { Card, Note, Page, Section, Stats } from '../ui/page';

export interface EventData {
  event: EventDetail;
}

/** One Scheduled Event. A missing one is the screen's 404. */
export const loader = async (args: LoaderFunctionArgs): Promise<EventData> => {
  try {
    return { event: await api.event(await accountIdOf(), args.params.eventId ?? '') };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) throw new Response('Event was not found', { status: 404 });
    throw cause;
  }
};

/** Who has not answered first, then who is coming, then who is not. */
const ORDER: Readonly<Record<RegistrationView['status'], number>> = { unanswered: 0, attending: 1, not_attending: 2 };

/**
 * One Scheduled Event, read and not written: each registration, the
 * guests others registered, and the mail it came from. Changing the event
 * itself is done in Calendar, which OrangeAgent treats as a Manual Override.
 */
const EventScreen = () => {
  const { event } = useLoaderData<EventData>();
  const registrations = [...event.registrations].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'ja'));
  const guestsAttending = event.guests.filter((guest) => guest.attending).length;
  return <Page
    title={event.title}
    back={{ to: '../events', label: '予定' }}
    lead={[`${dateTimeLabel(event.startsAt)}〜${timeLabel(event.endsAt)}`, event.location].filter(Boolean).join(' ・ ')}
    narrow
  >
    {event.status === 'cancelled' && <Banner tone="neutral">この予定は中止になりました。</Banner>}
    <Card>
      <Stats items={[
        { label: '出席', value: event.attending },
        { label: '欠席', value: event.notAttending },
        { label: '未回答', value: event.unanswered },
        { label: '外部から', value: guestsAttending },
      ]} />
    </Card>
    <Note>{event.responseDeadline ? `回答期限は${dateLabel(event.responseDeadline)}です。` : '回答期限はありません。'}日時や場所を直すときは Google カレンダーで直します。OrangeAgent はカレンダーでの修正を上書きしません。</Note>
    <Section title="出欠">
      {registrations.length === 0
        ? <Empty title="出欠を取っていない予定です" />
        : <List>{registrations.map((registration) => {
          const status = named(attendance, registration.status);
          return <Row
            key={registration.contactId}
            to={`../contacts/${encodeURIComponent(registration.contactId)}`}
            title={registration.name}
            sub={registration.comment || (registration.status === 'unanswered' ? 'まだ答えていません' : `${momentLabel(registration.updatedAt)}に回答`)}
            aside={<Chip tone={status.tone}>{status.label}</Chip>}
            wrap
          />;
        })}</List>}
    </Section>
    {event.guests.length > 0 && <Section title="外部からの参加登録" lead="カレンダーの説明には人数だけを書き、名前はここにだけ表示します。">
      <List>{event.guests.map((guest) => <Row
        key={`${guest.affiliation}-${guest.name}`}
        title={guest.name}
        sub={guest.affiliation || '所属の記載なし'}
        aside={guest.attending ? <Chip tone="brand">出席</Chip> : <Chip tone="muted">欠席</Chip>}
      />)}</List>
    </Section>}
    <Section title="元のメール">
      {event.source
        ? <List><Row leading={<Mail size={20} aria-hidden="true" />} title={event.source.subject} sub={`${event.source.sender} ・ ${momentLabel(event.source.receivedAt)}`} wrap /></List>
        : <Note>メールからではなく作られた予定です。</Note>}
    </Section>
    {event.description && <Section title="説明"><Note>{event.description}</Note></Section>}
  </Page>;
};

export default EventScreen;
