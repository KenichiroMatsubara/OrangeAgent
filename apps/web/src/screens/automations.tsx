import { CircleAlert, Plus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useLoaderData, useNavigate, useRevalidator } from 'react-router-dom';

import { AUTOMATION_TOOLS, type Automation, type Preset, type Skill, type Tool } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { automationSwitch, executionMode, named, runStatus, tool, word } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { momentLabel } from '../time';
import { Button } from '../ui/button';
import { Segmented } from '../ui/choice';
import { Deferred, later } from '../ui/deferred';
import { Check, CheckGroup, Field } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner, Chip, Chips, Empty } from '../ui/notice';
import { Card, Note, Page, Section } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonRows } from '../ui/skeleton';
import { SkillChecks } from './skills';
import styles from './automations.module.css';

const toolEffect = (entry: Tool): string => entry.acts ? 'サイトをその場で操作します（無人実行のときだけ使えます）' : entry.reachesContacts ? '外に送ります' : entry.writes ? '記録を変えます' : '読むだけです';

/** The tools an Automation may use. */
export const ToolChecks = ({ tools, value, onChange, disabled = false, showLegend = true }: {
  tools: readonly Tool[];
  value: readonly string[];
  onChange: (tools: string[]) => void;
  disabled?: boolean;
  /** Off where a section heading already says it. */
  showLegend?: boolean;
}) => <CheckGroup legend="使ってよいこと" showLegend={showLegend}>
  {tools.map((entry) => <Check
    key={entry.name}
    label={word(tool, entry.name)}
    sub={toolEffect(entry)}
    checked={value.includes(entry.name)}
    disabled={disabled}
    onChange={(checked) => onChange(checked
      ? tools.map(({ name }) => name).filter((name) => name === entry.name || value.includes(name))
      : value.filter((name) => name !== entry.name))}
  />)}
</CheckGroup>;

export const WEEKDAYS = [['mon', '月'], ['tue', '火'], ['wed', '水'], ['thu', '木'], ['fri', '金'], ['sat', '土'], ['sun', '日']] as const;

type Cadence = 'hourly' | 'daily' | 'weekly';

export interface ScheduleParts {
  cadence: Cadence;
  weekday: string;
  time: string;
  minute: string;
}

/** The parts of a Trigger Time in the Worker's grammar (`hourly :15`, `daily 09:00`, `weekly mon 09:00`). */
export const scheduleParts = (schedule: string): ScheduleParts => {
  const hourly = /^hourly\s+:(\d{2})$/u.exec(schedule.trim());
  if (hourly?.[1]) return { cadence: 'hourly', weekday: 'mon', time: '09:00', minute: hourly[1] };
  const weekly = /^weekly\s+([a-z]{3})\s+(\d{2}:\d{2})$/u.exec(schedule.trim());
  if (weekly?.[1] && weekly[2]) return { cadence: 'weekly', weekday: weekly[1], time: weekly[2], minute: '00' };
  const daily = /^daily\s+(\d{2}:\d{2})$/u.exec(schedule.trim());
  return { cadence: 'daily', weekday: 'mon', time: daily?.[1] ?? '09:00', minute: '00' };
};

/** The Trigger Time the parts make, in the Worker's grammar. */
export const scheduleText = (parts: ScheduleParts): string =>
  parts.cadence === 'hourly' ? `hourly :${parts.minute}`
    : parts.cadence === 'weekly' ? `weekly ${parts.weekday} ${parts.time}`
      : `daily ${parts.time}`;

/** A Trigger Time as a person says it: 毎日 09:00, 毎週月曜 09:00, 毎時 15分. */
export const scheduleLabel = (schedule: string): string => {
  const parts = scheduleParts(schedule);
  if (parts.cadence === 'hourly') return `毎時 ${Number(parts.minute)}分`;
  if (parts.cadence === 'weekly') return `毎週${WEEKDAYS.find(([key]) => key === parts.weekday)?.[1] ?? ''}曜 ${parts.time}`;
  return `毎日 ${parts.time}`;
};

/** When a timed Automation runs, chosen as a person says it, in Asia/Tokyo. */
export const ScheduleFields = ({ parts, onChange, disabled = false }: { parts: ScheduleParts; onChange: (parts: ScheduleParts) => void; disabled?: boolean }) => {
  const set = (part: Partial<ScheduleParts>): void => onChange({ ...parts, ...part });
  return <>
    <Segmented label="いつ動かすか" value={parts.cadence} onChange={(cadence) => set({ cadence })} options={[
      { value: 'hourly', label: '毎時' }, { value: 'daily', label: '毎日' }, { value: 'weekly', label: '毎週' },
    ]} />
    <div className={styles.when}>
      {parts.cadence === 'weekly' && <Field label="曜日">{(control) => <select {...control} value={parts.weekday} disabled={disabled} onChange={(change) => set({ weekday: change.target.value })}>
        {WEEKDAYS.map(([key, label]) => <option key={key} value={key}>{label}曜</option>)}
      </select>}</Field>}
      {parts.cadence === 'hourly'
        ? <Field label="何分に">{(control) => <select {...control} value={parts.minute} disabled={disabled} onChange={(change) => set({ minute: change.target.value })}>
          {Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, '0')).map((minute) => <option key={minute} value={minute}>{Number(minute)}分</option>)}
        </select>}</Field>
        : <Field label="時刻（日本時間）">{(control) => <input {...control} type="time" value={parts.time} step={300} disabled={disabled} onChange={(change) => set({ time: change.target.value })} required />}</Field>}
    </div>
  </>;
};

/**
 * What a new Automation may do until the Account says otherwise: read, and
 * tell whom its Skills name. Operating a browser acts on a site at once, so it
 * is granted only when the Account grants it.
 */
const STARTING_TOOLS: readonly string[] = AUTOMATION_TOOLS.filter((entry) => (!entry.writes && !entry.acts) || entry.name === 'channel.send' || entry.name === 'mail.send').map(({ name }) => name);

/**
 * Adds one Automation as a draft: what it is called, when it runs, and the
 * Skills it runs. Everything else is set on its own screen, which this opens
 * when it is made.
 */
const AddAutomation = ({ skills, onClose }: { skills: readonly Skill[]; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>(skills[0] ? [skills[0].id] : []);
  const [parts, setParts] = useState<ScheduleParts>(scheduleParts('daily 09:00'));
  const creating = operations.pending(pendingKey.automationCreate);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.automationCreate, async () => {
      const created = await api.createAutomation(account.accountId, {
        name: name.trim(), enabled: false, schedule: scheduleText(parts), executionMode: 'unattended', skillIds, tools: [...STARTING_TOOLS], suppressionWindow: 'day', model: null,
      });
      onClose();
      navigate(created.id);
    });
  };
  return <Sheet title="自動化を追加" onClose={onClose} onSubmit={submit}>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} placeholder="例: 毎週の予定のお知らせ" required />}</Field>
    <ScheduleFields parts={parts} onChange={setParts} />
    <SkillChecks skills={skills} value={skillIds} onChange={setSkillIds} />
    <Note>誰に送るかは、スキルの本文に書きます。下書きとして作り、使ってよいことと実行のしかたは、作ったあとの画面で決めます。</Note>
    <Button type="submit" block busy={creating} disabled={!skillIds.length || !name.trim()}>{creating ? '追加しています…' : '追加する'}</Button>
  </Sheet>;
};

/** A Preset lands as Skills and the Automations that run them, so it is copied from here. */
const PresetSettings = ({ presets, hasConfiguration }: { presets: readonly Preset[]; hasConfiguration: boolean }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [confirmed, setConfirmed] = useState(false);
  if (!presets.length) return null;
  const apply = (presetId: string): void => void operations.run(pendingKey.presetApply(presetId), async () => {
    await api.applyPreset(account.accountId, presetId, hasConfiguration ? 'duplicate' : undefined);
    await revalidator.revalidate();
  });
  return <Section title="ひな形から作る" lead="ひな形の自動化とスキルをこの Account に写します。写したあとは自由に変えられ、製品の更新とは連動しません。">
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {hasConfiguration && <Card><Check label="いまの自動化に加えて、別の写しを足す" checked={confirmed} onChange={setConfirmed} /></Card>}
    <List>{presets.map((preset) => <Row
      key={preset.id}
      wrap
      title={preset.name}
      sub={preset.description}
      aside={<Button variant="secondary" small busy={operations.pending(pendingKey.presetApply(preset.id))} disabled={hasConfiguration && !confirmed} onClick={() => apply(preset.id)}>{operations.pending(pendingKey.presetApply(preset.id)) ? '写しています…' : '写す'}</Button>}
    />)}</List>
  </Section>;
};

export interface AutomationsData {
  automations: Promise<Automation[]>;
  skills: Promise<Skill[]>;
  presets: Promise<Preset[]>;
}

/** Returns at once; each part fills in as it is read. */
export const loader = async (): Promise<AutomationsData> => {
  const accountId = await accountIdOf();
  return {
    automations: later(api.automations(accountId)),
    skills: later(api.skills(accountId)),
    presets: later(api.presets()),
  };
};

/** One Automation in the index: when it runs, what it runs, and what needs the Account. */
const AutomationRow = ({ automation, skills }: { automation: Automation; skills: readonly Skill[] }) => {
  const state = automationSwitch(automation.enabled);
  const skillNames = automation.skillIds.map((id) => skills.find((skill) => skill.id === id)?.title ?? '見つからないスキル').join('、');
  const failed = automation.lastRun?.status === 'failed';
  const when = automation.nextRunAt ? ` ・ 次は${momentLabel(automation.nextRunAt)}` : '';
  return <Row
    to={automation.id}
    wrap
    title={automation.name}
    sub={`${scheduleLabel(automation.schedule)}${when} ・ スキル: ${skillNames} ・ ${named(executionMode, automation.executionMode).label}`}
    aside={<Chips>
      {failed && <Chip tone="danger">{named(runStatus, 'failed').label}</Chip>}
      <Chip tone={state.tone}>{state.label}</Chip>
    </Chips>}
  />;
};

/**
 * Every Automation: when it runs, the Skills it runs, and the tools it may
 * use. Whom it tells is written in its Skills. This screen lists and adds
 * them, and each is changed on its own screen.
 */
const AutomationsScreen = () => {
  const data = useLoaderData<AutomationsData>();
  const [adding, setAdding] = useState(false);
  // One promise for each part, kept across renders so a part does not suspend again on every render.
  const index = useMemo(() => later(Promise.all([data.automations, data.skills])), [data.automations, data.skills]);
  const copies = useMemo(() => later(Promise.all([data.presets, data.automations, data.skills])), [data.presets, data.automations, data.skills]);
  return <Page title="自動化" lead="決まった時刻に、選んだスキルを AI が実行します。誰に何を送るかはスキルに書きます。時刻はすべて日本時間です。" back={{ to: '../more', label: 'その他' }} actions={<Button pill icon={<Plus size={18} aria-hidden="true" />} onClick={() => setAdding(true)}>追加</Button>}>
    <Deferred value={index} fallback={<SkeletonRows count={4} />}>{([automations, skills]) => automations.length === 0
      ? <Empty title="まだありません" text="毎朝のメール処理や毎週の予定のお知らせなどを、決まった時刻に動かせます。" />
      : <List>{automations.map((automation) => <AutomationRow key={automation.id} automation={automation} skills={skills} />)}</List>}</Deferred>
    <Deferred value={copies} fallback={null}>{([presets, automations, skills]) =>
      <PresetSettings presets={presets} hasConfiguration={Boolean(automations.length || skills.length)} />}</Deferred>
    {adding && <Deferred value={data.skills} fallback={null}>{(skills) => <AddAutomation skills={skills} onClose={() => setAdding(false)} />}</Deferred>}
  </Page>;
};

export default AutomationsScreen;
