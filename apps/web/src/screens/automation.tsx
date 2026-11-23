import { CircleAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import {
  AUTOMATION_TOOLS,
  modelLabel,
  type Automation,
  type AutomationUpdate,
  type Connections,
  type ExecutionMode,
  type Run,
  type RunTranscript,
  type Skill,
  type SuppressionWindow,
} from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { RunHistory } from '../history';
import { automationSwitch, executionMode, executionModeHint, named, suppressionWindow, word } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { momentLabel } from '../time';
import { AutomationTrialFlow } from '../trial';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Field, Switch } from '../ui/field';
import { Banner, Chip } from '../ui/notice';
import { Card, Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import { ScheduleFields, scheduleLabel, scheduleParts, scheduleText, ToolChecks, type ScheduleParts } from './automations';
import { SkillChecks } from './skills';
import styles from './automation.module.css';

export interface AutomationData {
  automation: Automation;
  skills: Skill[];
  connections: Connections;
  runs: Promise<Run[]>;
}

/** The Automation and what configures it are awaited; its runs fill in after. */
export const loader = async (args: LoaderFunctionArgs): Promise<AutomationData> => {
  const accountId = await accountIdOf();
  const automationId = args.params.automationId ?? '';
  const runs = later(api.runs(accountId, automationId));
  const [automation, skills, connections] = await Promise.all([
    api.automation(accountId, automationId),
    api.skills(accountId),
    api.connections(accountId),
  ]);
  return { automation, skills, connections, runs };
};

type Update = (input: AutomationUpdate) => void;

const WINDOWS: readonly SuppressionWindow[] = ['none', 'hour', 'day', 'week', 'forever'];

/**
 * What this Automation is called and when it runs. Saved together, because a
 * rename and a new time are one decision about when and what it is.
 */
const WhenEditor = ({ automation, saving, settled, onUpdate }: { automation: Automation; saving: boolean; settled: boolean; onUpdate: Update }) => {
  const [name, setName] = useState(automation.name);
  const [parts, setParts] = useState<ScheduleParts>(scheduleParts(automation.schedule));
  const save = (): void => onUpdate({ name: name.trim(), schedule: scheduleText(parts) });
  return <Section title="いつ動くか" lead="時刻は日本時間です。前回の実行は覚えていませんが、前回いつ動いたかは毎回伝えるので、スキルに「前回から届いたメール」のように書けます。">
    <Card>
      <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} disabled={saving} />}</Field>
      <ScheduleFields parts={parts} onChange={setParts} disabled={saving} />
      <Button busy={saving} disabled={!name.trim()} onClick={save}>{saving ? '保存しています…' : settled ? '保存しました' : '保存する'}</Button>
    </Card>
  </Section>;
};

/**
 * The model this Automation thinks with: the AI Connection's default, or
 * another the Connection names. No other model can be chosen.
 */
const ModelField = ({ automation, ai, saving, onUpdate }: { automation: Automation; ai: Connections['ai']; saving: boolean; onUpdate: Update }) => {
  if (!ai.apiKeyConfigured) return null;
  const others = ai.models.filter((model) => model !== ai.model);
  const retired = automation.model !== null && !ai.models.includes(automation.model);
  const hint = retired
    ? `${modelLabel(automation.model ?? '')} は AI 接続から外れたため、既定の ${modelLabel(ai.model)} で動きます。`
    : others.length
      ? '選べるのは AI 接続に登録した model だけです。既定にすると、AI 接続の既定を変えたときにそれに従います。'
      : 'AI 接続にほかの model を登録すると、ここで切り替えられます。';
  return <Field label="使う model" hint={<>{hint} <Link to="../connections">AI 接続</Link></>}>{(control) => <select {...control} value={automation.model ?? ''} disabled={saving} onChange={(change) => onUpdate({ model: change.target.value || null })}>
    <option value="">既定（{modelLabel(ai.model)}）</option>
    {others.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
    {retired && automation.model && <option value={automation.model} disabled>{modelLabel(automation.model)}（登録から外れています）</option>}
  </select>}</Field>;
};

/** What the agent read and what it concluded, for one run. */
const TranscriptSheet = ({ transcript, onClose }: { transcript: RunTranscript; onClose: () => void }) =>
  <Sheet title={transcript.source?.subject || 'AI が読んだもの'} onClose={onClose}>
    {transcript.source ? <>
      <h3 className={styles.heading}>読んだメール</h3>
      <pre className={styles.text}>{transcript.source.body}</pre>
      {transcript.source.attachments.map((attachment) => <div key={attachment.filename}>
        <h3 className={styles.heading}>添付: {attachment.filename}</h3>
        <pre className={styles.text}>{attachment.text}</pre>
      </div>)}
    </> : <>
      <h3 className={styles.heading}>頼まれたこと</h3>
      <pre className={styles.text}>{transcript.request}</pre>
    </>}
    <h3 className={styles.heading}>{transcript.error ? '止まった理由' : 'AI の結論'}</h3>
    {transcript.error ? <Banner tone="danger">{transcript.error}</Banner> : <pre className={styles.text}>{transcript.finalOutput}</pre>}
  </Sheet>;

/**
 * One Automation, whole. Everything that decides what it does is on this
 * screen — when it runs, its Skills, the tools it may use, and how its writes
 * are applied — and the screen says what is missing. Whom it tells is written
 * in its Skills, so it is changed on the スキル screen.
 */
const AutomationScreen = () => {
  const data = useLoaderData<AutomationData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const accountId = account.accountId;
  const { automation, skills } = data;
  const [transcript, setTranscript] = useState<RunTranscript | null>(null);
  const saving = operations.pending(pendingKey.automationUpdate(automation.id));
  const state = automationSwitch(automation.enabled);
  const missingSkill = automation.skillIds.some((id) => !skills.some((skill) => skill.id === id));
  const update = (input: AutomationUpdate): void => void operations.run(pendingKey.automationUpdate(automation.id), async () => {
    await api.updateAutomation(accountId, automation.id, input);
    await revalidator.revalidate();
  });
  const openTranscript = (runId: string): void => void operations.run(pendingKey.runTranscript(runId), async () => {
    setTranscript(await api.runTranscript(accountId, runId));
  });
  const decide = (runId: string, decision: 'approve' | 'reject'): void => void operations.run(pendingKey.runDecision(runId, decision), async () => {
    await api.decideRun(accountId, runId, decision);
    await revalidator.revalidate();
  });
  const remove = (): void => void operations.run(pendingKey.automationRemove(automation.id), async () => {
    await api.removeAutomation(accountId, automation.id);
    navigate('../automations');
  });
  const modes: readonly ExecutionMode[] = ['unattended', 'approval', 'read_only'];
  const next = automation.nextRunAt ? ` ・ 次は${momentLabel(automation.nextRunAt)}` : '';
  return <Page
    title={automation.name}
    back={{ to: '../automations', label: '自動化' }}
    lead={<>{scheduleLabel(automation.schedule)}{next} ・ <Chip tone={state.tone}>{state.label}</Chip></>}
    narrow
  >
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {!data.connections.ai.apiKeyConfigured && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />} action={<Link to="../connections">AI を接続する</Link>}>
      AI 接続が設定されていません。この自動化は動けません。
    </Banner>}
    {missingSkill && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>選んだスキルが見つかりません。この自動化は動けません。</Banner>}
    <WhenEditor key={`when-${automation.revision}-${automation.updatedAt}`} automation={automation} saving={saving} settled={operations.settled(pendingKey.automationUpdate(automation.id))} onUpdate={update} />
    <Section title="スキル" lead="毎回、選んだスキルを必ず読みます。ほかのスキルも、「いつ使うか」に当てはまれば読みます。誰に送るかは、スキルの本文に書きます。" link={{ to: '../skills', label: 'スキルを編集' }}>
      <Card>
        <SkillChecks skills={skills} value={automation.skillIds} onChange={(skillIds) => {
          // An Automation always starts with at least one Skill, so the last one cannot be taken off.
          if (skillIds.length) update({ skillIds });
        }} />
      </Card>
    </Section>
    <Section title="使ってよいこと" lead="書き込む道具は、計画として残り、下の「実行のしかた」に沿って書き込みます。外に送る道具は、スキルに書かれた相手に送ります。">
      <Card>
        <ToolChecks tools={AUTOMATION_TOOLS} value={automation.tools} disabled={saving} showLegend={false} onChange={(tools) => update({ tools })} />
        {data.connections.ai.apiKeyConfigured && data.connections.ai.provider !== 'anthropic' && automation.tools.includes('web.search') &&
          <Note>「ウェブを調べる」は、AI 接続が Claude（Anthropic）のときだけ使えます。いまの AI 接続では、この自動化はウェブを調べません。</Note>}
      </Card>
    </Section>
    <Section title="実行のしかた">
      <Card>
        <Switch label="決まった時刻に動かす" sub="オフのあいだは動きません。下で試しに動かせます。" checked={automation.enabled} disabled={saving} onChange={(enabled) => update({ enabled })} />
        <Field label="書き込みのしかた" hint={executionModeHint[automation.executionMode]}>{(control) => <select {...control} value={automation.executionMode} disabled={saving} onChange={(change) => update({ executionMode: change.target.value as ExecutionMode })}>
          {modes.map((mode) => <option key={mode} value={mode}>{executionMode[mode].label}</option>)}
        </select>}</Field>
        <ModelField automation={automation} ai={data.connections.ai} saving={saving} onUpdate={update} />
        <Field label="同じ操作を止める期間" hint="同じ相手への同じ送信も、同じタスクの登録も、この期間は二度しません。">{(control) => <select {...control} value={automation.suppressionWindow} disabled={saving} onChange={(change) => update({ suppressionWindow: change.target.value as SuppressionWindow })}>
          {WINDOWS.map((value) => <option key={value} value={value}>{word(suppressionWindow, value)}</option>)}
        </select>}</Field>
        <Note>第{automation.revision}版</Note>
      </Card>
    </Section>
    <Section title="試しに動かす" lead="いま、この自動化を動かしてみます。メールや記録は読みますが、書き込み・送信は見せるだけで行いません。">
      <AutomationTrialFlow accountId={accountId} automationId={automation.id} operations={operations} aiConfigured={data.connections.ai.apiKeyConfigured} />
    </Section>
    <Section title="実行履歴" lead="1 回ごとに、何を読み、何を計画し、どうなったかです。承認を待つものはここで承認します。">
      <Deferred value={data.runs} fallback={<SkeletonRows />}>{(runs) =>
        <RunHistory runs={runs} pending={operations.pending} onDecide={decide} onTranscript={openTranscript} />}</Deferred>
    </Section>
    <Section title="削除" lead="動いた記録がある自動化は消せません。使わないときはオフにします。">
      <Toolbar><Button variant="secondary" busy={operations.pending(pendingKey.automationRemove(automation.id))} icon={<Trash2 size={16} aria-hidden="true" />} onClick={remove}>この自動化を削除</Button></Toolbar>
    </Section>
    {transcript && <TranscriptSheet transcript={transcript} onClose={() => setTranscript(null)} />}
  </Page>;
};

export default AutomationScreen;
