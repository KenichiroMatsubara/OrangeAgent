import { CheckCircle2, CircleAlert, KeyRound, MessageCircle, MessageSquare, OctagonAlert, TriangleAlert, Unplug, UserCheck, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLoaderData } from 'react-router-dom';

import type { Attention, AttentionKind, AutomationGlance, AutomationStatus, Dashboard, UpcomingEvent } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, GoogleReauthenticationAction, useAccount } from '../dashboard';
import { momentLabel, timeLabel } from '../time';
import { ButtonLink } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { List, Row } from '../ui/list';
import { Banner, Chip, DateBadge, Empty, Mark, type Tone } from '../ui/notice';
import { Columns, Page, Section, Stack } from '../ui/page';
import { SkeletonBlock } from '../ui/skeleton';
import { automationSwitch, named, runStatus } from '../labels';
import { scheduleLabel } from './automations';

export interface HomeData {
  dashboard: Promise<Dashboard>;
  automation: Promise<AutomationStatus | null>;
}

/** Returns at once; the Automations and what needs the Account fill in as they are read. */
export const loader = async (): Promise<HomeData> => {
  const accountId = await accountIdOf();
  return { dashboard: later(api.dashboard(accountId)), automation: later(api.currentAutomation(accountId)) };
};

interface AttentionView {
  to: string;
  tone: Tone;
  icon: ReactNode;
  title: (count: number) => string;
  sub: (detail: string) => string;
}

/** Where each condition is resolved, and how it is said. */
const attentionViews: Readonly<Record<AttentionKind, AttentionView>> = {
  reauthentication: { to: '../connections', tone: 'danger', icon: <KeyRound size={18} />, title: () => 'Google の再接続が必要です', sub: (detail) => `${detail || 'メールの受信箱'}を読めません` },
  ai_missing: { to: '../connections', tone: 'danger', icon: <Unplug size={18} />, title: () => 'AI 接続が未設定です', sub: () => 'このままでは自動化が動けません' },
  pending_approval: { to: '../automations', tone: 'warn', icon: <UserCheck size={18} />, title: (count) => `承認待ちの実行 ${count}件`, sub: (detail) => detail ? `${detail}の画面で承認します` : '自動化の画面で承認します' },
  failed_run: { to: '../automations', tone: 'danger', icon: <OctagonAlert size={18} />, title: (count) => `失敗した実行 ${count}件（24 時間以内）`, sub: (detail) => detail ? `${detail}の実行履歴で理由を確かめます` : '自動化の実行履歴で理由を確かめます' },
  exception: { to: '../operations', tone: 'danger', icon: <OctagonAlert size={18} />, title: (count) => `処理できなかったこと ${count}件`, sub: (detail) => detail || '履歴で確かめます' },
  unlinked_line: { to: '../contacts', tone: 'info', icon: <MessageCircle size={18} />, title: (count) => `LINE から届いた相手 ${count}件`, sub: (detail) => `${detail ? `${detail}を` : ''}連絡先に結び付けると届けられます` },
  stuck_job: { to: '../operations', tone: 'danger', icon: <TriangleAlert size={18} />, title: (count) => `止まったままの処理 ${count}件`, sub: () => '再試行を使い切りました' },
  warning: { to: '../operations', tone: 'warn', icon: <TriangleAlert size={18} />, title: (count) => `読み取りの注意 ${count}件（24 時間以内）`, sub: () => 'AI が仮の値で補ったところがあります' },
};

const AttentionList = ({ attention }: { attention: readonly Attention[] }) => {
  if (!attention.length) return <Empty icon={<CheckCircle2 size={32} aria-hidden="true" />} title="対応が必要なものはありません" />;
  return <List>{attention.map((condition) => {
    const view = attentionViews[condition.kind];
    return <Row key={condition.kind} to={view.to} leading={<Mark tone={view.tone}>{view.icon}</Mark>} title={view.title(condition.count)} sub={view.sub(condition.detail)} />;
  })}</List>;
};

/** The Google grant the Automations read mail with, when it needs the Account. */
const InboxHealth = ({ automation }: { automation: AutomationStatus | null }) => {
  const { reauthenticate, reauthenticating } = useAccount();
  if (automation?.status === 'reauthentication_required') return <GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />;
  if (!automation?.failingSince) return null;
  return <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>
    {momentLabel(automation.failingSince)}から Google への接続に失敗しています。復旧すると自動で再開します。{automation.lastError ? `（${automation.lastError}）` : ''}
  </Banner>;
};

/** Each Automation: when it next runs, and how its latest run ended. */
const Automations = ({ automations }: { automations: readonly AutomationGlance[] }) => automations.length === 0
  ? <Empty icon={<Workflow size={32} aria-hidden="true" />} title="自動化がありません" text="「自動化」の画面で、決まった時刻にスキルを動かせます。" />
  : <List>{automations.map((automation) => {
    const state = automationSwitch(automation.enabled);
    const last = automation.lastRun
      ? `前回 ${momentLabel(automation.lastRun.startedAt)}（${named(runStatus, automation.lastRun.status).label}）`
      : 'まだ動いていません';
    return <Row
      key={automation.id}
      to={`../automations/${encodeURIComponent(automation.id)}`}
      title={automation.name}
      sub={[automation.nextRunAt ? `次は${momentLabel(automation.nextRunAt)}` : scheduleLabel(automation.schedule), last].join(' ・ ')}
      aside={automation.lastRun?.status === 'failed' ? <Chip tone="danger">{named(runStatus, 'failed').label}</Chip> : <Chip tone={state.tone}>{state.label}</Chip>}
    />;
  })}</List>;

const answers = (event: UpcomingEvent): ReactNode => {
  const invited = event.attending + event.notAttending + event.unanswered;
  if (!invited) return null;
  return event.unanswered ? <Chip tone="warn">未回答 {event.unanswered}</Chip> : <Chip tone="brand">全員回答</Chip>;
};

const NextEvents = ({ events }: { events: readonly UpcomingEvent[] }) => events.length === 0
  ? <Empty title="これからの予定はありません" />
  : <List>{events.map((event) => <Row
    key={event.id}
    to={`../events/${encodeURIComponent(event.id)}`}
    leading={<DateBadge value={event.startsAt} />}
    title={event.title}
    sub={[`${timeLabel(event.startsAt)}〜${timeLabel(event.endsAt)}`, event.location, event.attending ? `出席 ${event.attending}` : ''].filter(Boolean).join(' ・ ')}
    aside={answers(event)}
  />)}</List>;

/** The Automations, what needs the Account, and what is next. */
const HomeScreen = () => {
  const data = useLoaderData<HomeData>();
  return <Page
    title="ホーム"
    lead="自動化の予定と、対応が必要なものです。"
    actions={<ButtonLink to="../chat" variant="soft" pill small icon={<MessageSquare size={18} aria-hidden="true" />}>AI に聞く</ButtonLink>}
  >
    <Deferred value={data.automation} fallback={null}>{(automation) => <InboxHealth automation={automation} />}</Deferred>
    <Deferred value={data.dashboard} fallback={<SkeletonBlock height={280} />}>{(dashboard) => <Columns>
      <Stack>
        <Section title="自動化" link={{ to: '../automations', label: 'すべて' }}>
          <Automations automations={dashboard.automations} />
        </Section>
        <Section title="要対応" count={dashboard.attention.reduce((total, condition) => total + condition.count, 0)}>
          <AttentionList attention={dashboard.attention} />
        </Section>
      </Stack>
      <Stack>
        <Section title="次の予定" link={{ to: '../events', label: 'すべて' }}>
          <NextEvents events={dashboard.upcomingEvents} />
        </Section>
      </Stack>
    </Columns>}</Deferred>
  </Page>;
};

export default HomeScreen;
