import { Check, FileText, X } from 'lucide-react';

import type { DeliveryRecord, PlannedWrite, Run } from '@mail/domain';

import { channel, executionMode, named, plannedWriteStatus, runStatus, tool, word } from './labels';
import { pendingKey } from './pending';
import { dateTimeLabel, momentLabel } from './time';
import { Button } from './ui/button';
import { Disclosure } from './ui/disclosure';
import { List, Row } from './ui/list';
import { Banner, Chip, Empty } from './ui/notice';
import { Toolbar } from './ui/page';
import styles from './history.module.css';

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const textValue = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

const present = (values: Array<string | null>): string[] => values.filter((value): value is string => Boolean(value));

/** The filenames one write names, as one line. */
const filesLine = (label: string, value: unknown): string | null => {
  const files = Array.isArray(value)
    ? value.flatMap((entry) => {
      const name = typeof entry === 'string' ? entry : textValue(recordValue(entry)?.filename);
      return name ? [name] : [];
    })
    : [];
  return files.length ? `${label}: ${files.join(', ')}` : null;
};

/** Where in Drive an event's files are put: the folder the AI chose, and the folder inside it when it named one. */
const folderLine = (arguments_: Record<string, unknown>): string | null => {
  const folder = textValue(arguments_.folderName);
  if (!folder) return null;
  const subfolder = textValue(arguments_.subfolder);
  return `置き場所: ${subfolder ? `${folder} / ${subfolder}` : folder}`;
};

/** What one planned write would write or send, in lines a person can check. */
export const plannedWriteDetails = (write: Pick<PlannedWrite, 'tool' | 'arguments'>): string[] => {
  const arguments_ = write.arguments;
  switch (write.tool) {
    case 'channel.send':
    case 'reminder.schedule': {
      const to = textValue(arguments_.destination) ?? textValue(arguments_.contactId);
      return present([
        to ? `送信先: ${to}` : null,
        textValue(arguments_.at) ? `日時: ${dateTimeLabel(String(arguments_.at))}` : null,
        textValue(arguments_.text) ? `内容: ${String(arguments_.text)}` : null,
      ]);
    }
    case 'mail.send':
      return present([
        textValue(arguments_.to) ? `送信先: ${String(arguments_.to)}` : null,
        textValue(arguments_.subject) ? `件名: ${String(arguments_.subject)}` : null,
        textValue(arguments_.body) ? `内容: ${String(arguments_.body)}` : null,
      ]);
    case 'mail.draft':
      return present([
        '送信せず、Gmail の下書きに保存します',
        textValue(arguments_.to) ? `宛先: ${String(arguments_.to)}` : null,
        textValue(arguments_.subject) ? `件名: ${String(arguments_.subject)}` : null,
        textValue(arguments_.body) ? `内容: ${String(arguments_.body)}` : null,
      ]);
    case 'create_scheduled_event': {
      const attendees = Array.isArray(arguments_.attendees) ? arguments_.attendees.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
      return present([
        textValue(arguments_.title) ? `予定: ${String(arguments_.title)}` : null,
        textValue(arguments_.startsAt) ? `開始: ${dateTimeLabel(String(arguments_.startsAt))}` : null,
        arguments_.inviteRoster === true ? '招待: 連絡先全員' : null,
        attendees.length ? `招待: ${attendees.join(', ')}` : null,
        filesLine('資料', arguments_.attachments),
        folderLine(arguments_),
      ]);
    }
    case 'update_scheduled_event':
      return present([
        textValue(arguments_.title) ? `予定: ${String(arguments_.title)}` : null,
        textValue(arguments_.startsAt) ? `開始: ${dateTimeLabel(String(arguments_.startsAt))}` : null,
        textValue(arguments_.location) ? `場所: ${String(arguments_.location)}` : null,
        textValue(arguments_.description) ? `説明: ${String(arguments_.description)}` : null,
      ]);
    case 'attach_event_files':
      return present([filesLine('資料', arguments_.attachments), folderLine(arguments_), filesLine('差し替え', arguments_.replaces)]);
    case 'record_event_response': {
      const guests = Array.isArray(arguments_.guests) ? arguments_.guests.flatMap((value) => {
        const guest = recordValue(value);
        return guest && textValue(guest.name) ? [`${String(guest.name)}${textValue(guest.affiliation) ? `（${String(guest.affiliation)}）` : ''}`] : [];
      }) : [];
      return [guests.length ? `外部の参加者: ${guests.join('、')}` : '外部の参加者なし'];
    }
    case 'report':
      return present([
        textValue(arguments_.summary) ? `お知らせ: ${String(arguments_.summary)}` : null,
        ...(Array.isArray(arguments_.assumptions) ? arguments_.assumptions.map((line) => textValue(line) ? `確認してください: ${String(line)}` : null) : []),
        textValue(arguments_.held) ? `保留: ${String(arguments_.held)}` : null,
      ]);
    case 'tasks.create':
      return present([
        textValue(arguments_.title) ? `タスク: ${String(arguments_.title)}` : null,
        textValue(arguments_.due) ? `期限: ${String(arguments_.due)}` : null,
        textValue(arguments_.notes) ? `メモ: ${String(arguments_.notes)}` : null,
      ]);
    case 'tasks.update':
      return present([
        textValue(arguments_.title) ? `タスク: ${String(arguments_.title)}` : null,
        textValue(arguments_.due) ? `期限: ${String(arguments_.due)}` : null,
        arguments_.status === 'completed' ? '完了にする' : null,
        textValue(arguments_.notes) ? `メモ: ${String(arguments_.notes)}` : null,
      ]);
    case 'drive.save_file':
      return present([
        textValue(arguments_.filename) ? `ファイル: ${String(arguments_.filename)}` : null,
        textValue(arguments_.folderName) ? `保存先: ${String(arguments_.folderName)}` : null,
      ]);
    case 'drive.make_pdf':
      return present([textValue(arguments_.filename) ? `ファイル: ${String(arguments_.filename)}` : null]);
    case 'drive.create_folder':
      return present([
        textValue(arguments_.name) ? `フォルダ: ${String(arguments_.name)}` : null,
        textValue(arguments_.folderName) ? `作る場所: ${String(arguments_.folderName)}` : null,
      ]);
    case 'drive.move':
      return present([
        textValue(arguments_.fileName) ? `ファイル: ${String(arguments_.fileName)}` : null,
        textValue(arguments_.folderName) ? `移す先: ${String(arguments_.folderName)}` : null,
      ]);
    case 'drive.rename':
      return present([
        textValue(arguments_.fileName) ? `いまの名前: ${String(arguments_.fileName)}` : null,
        textValue(arguments_.name) ? `新しい名前: ${String(arguments_.name)}` : null,
      ]);
    case 'drive.trash':
      return present([
        textValue(arguments_.fileName) ? `ファイル: ${String(arguments_.fileName)}` : null,
        '削除はせず、「OrangeAgent のゴミ箱」フォルダに移します',
      ]);
    case 'skill.write':
    case 'skill.save_file':
    case 'skill.delete_file':
      return present([
        textValue(arguments_.name) ? `スキル: ${String(arguments_.name)}` : null,
        textValue(arguments_.path) ? `ファイル: ${String(arguments_.path)}` : null,
        textValue(arguments_.filename) ? `入れるファイル: ${String(arguments_.filename)}` : null,
      ]);
    case 'meet.transcribe':
      return present([
        textValue(arguments_.title) ? `会議: ${String(arguments_.title)}` : null,
        '以後この会議リンクで開く会議は、参加と同時に文字起こしが始まります',
      ]);
    default:
      return [];
  }
};

/** What a Run was given, as its title says: the mail it read, or what started it. */
const RUN_TITLES: Readonly<Record<Run['trigger'], string>> = { mail: '件名なし', morning: '朝のお知らせ', schedule: '決まった時刻の実行', chat: 'チャットでの依頼' };
const runTitle = (run: Run): string => run.sourceMessage?.subject || RUN_TITLES[run.trigger];

/**
 * What an Automation planned and what became of it, with the approval where
 * the plan is: approving a run belongs on the Automation that planned it.
 */
export const RunHistory = ({ runs, pending, onDecide, onTranscript }: {
  runs: readonly Run[];
  pending: (key: string) => boolean;
  onDecide: (runId: string, decision: 'approve' | 'reject') => void;
  onTranscript: (runId: string) => void;
}) => {
  if (!runs.length) return <Empty title="まだ動いていません" text="この自動化が動くと、何を読み、何を計画し、どうなったかがここに並びます。" />;
  return <div>
    {runs.map((run) => {
      const status = named(runStatus, run.status);
      const deciding = pending(pendingKey.runDecision(run.id, 'approve')) || pending(pendingKey.runDecision(run.id, 'reject'));
      const source = run.sourceMessage;
      return <Disclosure
        key={run.id}
        open={run.status === 'pending_approval'}
        title={runTitle(run)}
        sub={[momentLabel(run.startedAt), source?.sender].filter(Boolean).join(' ・ ')}
        aside={<Chip tone={status.tone}>{status.label}</Chip>}
      >
        <p className={styles.meta}>
          {named(executionMode, run.executionMode).label}
          {run.automation ? ` ・ 第${run.automation.revision}版` : ''}
          {run.model ? ` ・ ${run.model}` : ''} ・ ツール {run.toolCalls}回
        </p>
        {run.error && <Banner tone="danger">{run.error}</Banner>}
        {run.writes.length
          ? <ul className={styles.effects}>{run.writes.map((write) => {
            const writeStatus = named(plannedWriteStatus, write.status);
            return <li key={write.id} className={styles.effect}>
              <div className={styles.effectHead}><strong>{word(tool, write.tool)}</strong><Chip tone={writeStatus.tone}>{writeStatus.label}</Chip></div>
              {plannedWriteDetails(write).map((detail, index) => <p key={`${write.id}-${index}`} className={styles.detail}>{detail}</p>)}
              {write.error && <Banner tone="danger">{write.error}</Banner>}
            </li>;
          })}</ul>
          : !run.error && <p className={styles.meta}>書き込むことも、送ることもありませんでした。</p>}
        {run.output && <p className={styles.detail}>{run.output}</p>}
        <Toolbar>
          {run.status === 'pending_approval' && <>
            <Button busy={pending(pendingKey.runDecision(run.id, 'approve'))} disabled={deciding} icon={<Check size={18} aria-hidden="true" />} onClick={() => onDecide(run.id, 'approve')}>すべて承認して実行</Button>
            <Button variant="secondary" busy={pending(pendingKey.runDecision(run.id, 'reject'))} disabled={deciding} icon={<X size={18} aria-hidden="true" />} onClick={() => onDecide(run.id, 'reject')}>すべて却下</Button>
          </>}
          {run.transcript && <Button variant="quiet" small busy={pending(pendingKey.runTranscript(run.id))} icon={<FileText size={16} aria-hidden="true" />} onClick={() => onTranscript(run.id)}>AI が読んだもの</Button>}
        </Toolbar>
      </Disclosure>;
    })}
  </div>;
};

const deliveryChannel: Readonly<Record<string, string>> = { ...channel, calendar: 'カレンダー', drive: 'Drive' };

const deliveryOutcome: Readonly<Record<string, { label: string; tone: 'brand' | 'danger' | 'warn' }>> = {
  succeeded: { label: '成功', tone: 'brand' },
  failed: { label: '失敗', tone: 'danger' },
  pending: { label: '保留', tone: 'warn' },
};

/** What actually left the product, one row per Delivery Record, newest first as the Worker returns them. */
export const DeliveryAudit = ({ deliveries }: { deliveries: readonly DeliveryRecord[] }) => {
  if (!deliveries.length) return <Empty title="まだ送っていません" />;
  return <List>
    {deliveries.map((row) => {
      const outcome = deliveryOutcome[row.outcome] ?? { label: row.outcome, tone: 'warn' as const };
      return <Row
        key={row.id}
        title={row.destination}
        sub={`${word(deliveryChannel, row.channel)} ・ ${momentLabel(row.createdAt)}`}
        aside={<Chip tone={outcome.tone}>{outcome.label}</Chip>}
      />;
    })}
  </List>;
};
