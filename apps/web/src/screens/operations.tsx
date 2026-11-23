import { CircleAlert, CircleCheck } from 'lucide-react';
import { useLoaderData, useRevalidator } from 'react-router-dom';

import type { AutomationException, AutomationWarning, DeliveryRecord, StuckJob } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { DeliveryAudit } from '../history';
import { word } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { momentLabel } from '../time';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { List, Row } from '../ui/list';
import { Banner, Chip, Empty } from '../ui/notice';
import { Page, Section } from '../ui/page';
import { SkeletonRows } from '../ui/skeleton';

interface Problems {
  exceptions: AutomationException[];
  warnings: AutomationWarning[];
  jobs: StuckJob[];
}

export interface OperationsData {
  problems: Promise<Problems>;
  deliveries: Promise<DeliveryRecord[]>;
}

/** Returns at once; each part fills in as it is read. */
export const loader = async (): Promise<OperationsData> => {
  const accountId = await accountIdOf();
  return {
    problems: later(Promise.all([api.exceptions(accountId), api.warnings(accountId), api.stuckJobs(accountId)])
      .then(([exceptions, warnings, jobs]) => ({ exceptions, warnings, jobs }))),
    deliveries: later(api.deliveries(accountId)),
  };
};

/** Why a Source Message could not be processed, as the Account would say it. */
const exceptionCode: Readonly<Record<string, string>> = {
  ai_connection_missing: 'AI 接続が未設定',
  ai_event_details_invalid: 'AI が安全な形で読み取れなかった',
  drive_attachment_publish_failed: '添付ファイルを公開できなかった',
  gmail_attachment_download_failed: '添付ファイルを取得できなかった',
  source_attachment_conversion_failed: '添付ファイルを変換できなかった',
  agent_rule_run_failed: 'メールの自動化が途中で止まった',
  agent_held: 'AI が判断を人に任せた',
  calendar_event_deleted: 'カレンダーで予定が削除されていた',
  attachment_folder_unavailable: '添付の保存先を作れなかった',
};

const jobState: Readonly<Record<string, string>> = {
  running: '途中で止まったまま（もう一度は動きません）',
  failed: '再試行を使い切りました',
};

/** What a Job was doing, as the Account would say it. */
const jobKind: Readonly<Record<string, string>> = {
  deliver: '送信',
  deliver_summary: '要約の送信',
  reminder: 'リマインド',
  intake: 'メールの取り込み',
  morning_notice: 'モーニング通知',
};

/**
 * Everything that went wrong, and what was sent:
 * exceptions, stuck Jobs, what an Agent had to assume, and the delivery audit.
 */
const OperationsScreen = () => {
  const data = useLoaderData<OperationsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const resolve = (id: string): void => void operations.run(pendingKey.exceptionResolve(id), async () => {
    await api.resolveException(accountId, id);
    await revalidator.revalidate();
  });

  return <Page title="履歴" lead="うまくいかなかったこと、放っておくと止まったままのもの、送ったものです。" back={{ to: '../more', label: 'その他' }} narrow>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Deferred value={data.problems} fallback={<SkeletonRows count={4} />}>{({ exceptions, warnings, jobs }) => {
      const open = exceptions.filter((entry) => entry.state === 'open');
      return <>
        <Section title="処理できなかったメール" count={open.length}>
          {open.length === 0
            ? <Empty icon={<CircleCheck size={28} aria-hidden="true" />} title="未解決の例外はありません" />
            : <List>{open.map((entry) => <Row
              key={entry.id}
              wrap
              title={word(exceptionCode, entry.code)}
              sub={`${entry.message} ・ ${momentLabel(entry.createdAt)}`}
              aside={<Button variant="secondary" small busy={operations.pending(pendingKey.exceptionResolve(entry.id))} onClick={() => resolve(entry.id)}>{operations.pending(pendingKey.exceptionResolve(entry.id)) ? '処理しています…' : '解決済みにする'}</Button>}
            />)}</List>}
        </Section>
        <Section title="止まったままの処理" count={jobs.length}>
          {jobs.length === 0
            ? <Empty icon={<CircleCheck size={28} aria-hidden="true" />} title="止まったままの処理はありません" />
            : <List>{jobs.map((job) => <Row
              key={job.id}
              wrap
              title={word(jobKind, job.kind)}
              sub={`${word(jobState, job.state)} ・ ${job.attempts} 回試しました ・ ${momentLabel(job.updatedAt)}${job.lastError ? ` ・ ${job.lastError}` : ''}`}
              aside={<Chip tone="danger">止まっています</Chip>}
            />)}</List>}
        </Section>
        <Section title="AI が仮定したこと">
          {warnings.length === 0
            ? <Empty title="注意はありません" />
            : <List>{warnings.map((warning) => <Row key={warning.id} wrap title={warning.message} sub={momentLabel(warning.createdAt)} aside={<Chip tone="warn">注意</Chip>} />)}</List>}
        </Section>
      </>;
    }}</Deferred>
    <Section title="送信履歴">
      <Deferred value={data.deliveries} fallback={<SkeletonRows />}>{(deliveries) => <DeliveryAudit deliveries={deliveries} />}</Deferred>
    </Section>
  </Page>;
};

export default OperationsScreen;
