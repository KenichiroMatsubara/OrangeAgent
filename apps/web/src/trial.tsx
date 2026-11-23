import { CircleAlert, Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { AutomationTrial } from '@mail/domain';

import { api } from './api';
import { plannedWriteDetails } from './history';
import { tool, word } from './labels';
import { pendingKey, type PendingOperations } from './pending';
import { Button } from './ui/button';
import { List, Row } from './ui/list';
import { Banner } from './ui/notice';
import { Card, Note, Toolbar } from './ui/page';
import styles from './trial.module.css';

/**
 * Running one Automation now, as its time would, without writing anything:
 * it reads the mail and records it reads, and every write it decides on is
 * shown as planned and none applied, so a draft can be tried before it is
 * switched on.
 */
export const AutomationTrialFlow = ({ accountId, automationId, operations, aiConfigured }: {
  accountId: string;
  automationId: string;
  operations: PendingOperations;
  aiConfigured: boolean;
}) => {
  const [trial, setTrial] = useState<AutomationTrial | null>(null);
  const running = operations.pending(pendingKey.automationTrial(automationId));
  const run = (): void => void operations.run(pendingKey.automationTrial(automationId), async () => {
    setTrial(null);
    setTrial(await api.tryAutomation(accountId, automationId));
  });
  return <>
    {!aiConfigured && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />} action={<Link to="../connections">AI を接続する</Link>}>AI の接続が未設定です。</Banner>}
    <Toolbar><Button variant="secondary" busy={running} disabled={!aiConfigured} icon={<Play size={16} aria-hidden="true" />} onClick={run}>{running ? 'AI が動いています…' : '試しに動かす'}</Button></Toolbar>
    {trial && <Card>
      <Note>{`第${trial.automation.revision}版のスキルで動かしました。ここに並ぶ書き込みは、どれも行っていません。`}</Note>
      {trial.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>途中で止まりました: {trial.error}</Banner>}
      <h4 className={styles.heading}>書き込む予定だったこと（{trial.planned.length}件）</h4>
      {trial.planned.length === 0
        ? <Note>何も書き込まないと判断しました。</Note>
        : <List>{trial.planned.map((planned, index) => {
          const details = plannedWriteDetails(planned).join(' ・ ');
          return <Row key={`${planned.tool}-${index}`} wrap title={word(tool, planned.tool)} {...(details ? { sub: details } : {})} />;
        })}</List>}
      <h4 className={styles.heading}>AI の結論</h4>
      <p className={styles.summary}>{trial.output || '（結論の文章はありません）'}</p>
      <Note>{trial.model} ・ ツール {trial.toolCalls}回 ・ {trial.tokens.toLocaleString('ja-JP')} トークン</Note>
    </Card>}
  </>;
};
