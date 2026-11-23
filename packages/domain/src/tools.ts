/**
 * The one list of tools the product implements itself: one tool for each
 * capability, described once and performed by one handler.
 *
 * Operator Chat, every Automation, and an Access Token all select from this
 * list. What a run may call follows from what the run is — its
 * Execution Mode, its Tool Grant, and what it holds — never from which
 * entrance started it, so a tool added here reaches every run that can use
 * it. Whether a run plans its writes or performs them changes when a write is
 * applied, never which writes exist: a planned write is the same call,
 * performed later by the same handler. The one exception is keeping a
 * memory, which only a run that performs its writes, with a person at it, does.
 */

export type ToolName =
  | 'query_scheduled_events'
  | 'query_contacts'
  | 'query_attendance'
  | 'mail.search'
  | 'mail.read'
  | 'calendar.search'
  | 'drive.search'
  | 'drive.read'
  | 'meet.search'
  | 'meet.read'
  | 'tasks.search'
  | 'activate_skill'
  | 'read_skill_resource'
  | 'web.search'
  | 'browser.open'
  | 'browser.read'
  | 'browser.click'
  | 'browser.type'
  | 'browser.select'
  | 'browser.press'
  | 'memory.search'
  | 'run.token'
  | 'file.hand'
  | 'code.run'
  | 'agent.run'
  | 'tasks.create'
  | 'tasks.update'
  | 'channel.send'
  | 'reminder.schedule'
  | 'mail.send'
  | 'mail.draft'
  | 'create_scheduled_event'
  | 'update_scheduled_event'
  | 'cancel_scheduled_event'
  | 'attach_event_files'
  | 'record_event_response'
  | 'drive.save_file'
  | 'drive.make_pdf'
  | 'skill.write'
  | 'skill.save_file'
  | 'skill.delete_file'
  | 'memory.add'
  | 'drive.create_folder'
  | 'drive.move'
  | 'drive.rename'
  | 'drive.trash'
  | 'meet.transcribe';

/**
 * How a run applies its writes. An Automation plans each one as a Planned
 * Write before any is applied, whatever starts it (ADR 0134); Operator Chat
 * and an Access Token perform each one when it is called, because the caller
 * decides each write as it is made.
 */
export type ToolWrites = 'planned' | 'performed';

/**
 * Something a run holds beyond the Account's own records: the Automation
 * Inbox's Google grant, which opens the whole mailbox, calendar, Drive, and
 * Google Tasks, the
 * Account's Skills, which every run the Account itself starts thinks with and
 * an outside agent's does not, the Account's Memory, which every run the
 * Account itself starts may recall and only a run a person is at may add to, the files an Operator Chat
 * conversation wrote, which only such a conversation has, or the web, whose
 * pages the Worker reads for every run the Account starts, or a Run
 * Token, which only a run that thinks in FlareChat — an Operator Chat answer or
 * an Automation's run — can issue, since only such a run is there to answer
 * the calls made with it, or a browser, which Cloudflare Browser Run lends a
 * run that thinks in FlareChat for as long as it runs, signed in to every site
 * the Account saved a sign-in for, once the Account turned it on, or an
 * environment of FlareChat's own to run code in, which every run that thinks
 * in FlareChat holds when its Worker binds one (ADR 0203).
 */
export type ToolNeed = 'google' | 'skills' | 'memory' | 'generated_files' | 'web' | 'run_token' | 'browser' | 'code';

export interface Tool {
  name: ToolName;
  writes: boolean;
  /** Whether a call reaches a person, which only the Contacts a run may reach can be. */
  reachesContacts: boolean;
  /** What a run must hold to call it: any one of these, or nothing when empty. */
  needs: readonly ToolNeed[];
  /**
   * What a run must also hold to make this write, whether it performs it when
   * it is called or plans it: a Planned Write opens the Automation Inbox only
   * when it is applied, but an Account with no mailbox has no mailbox,
   * calendar, or Drive to write to either way.
   */
  performedNeeds?: ToolNeed;
  /**
   * Whether every run that can call it is offered it whatever its Tool Grant
   * says. Reading the Account's own Skills is: a run already thinks with
   * them, so opening another grants it no reach. So is issuing a Run Token,
   * which reaches only what the run itself reaches.
   */
  ungranted?: boolean;
  /**
   * Whether only a run that performs each write as it is called may make it,
   * never one that plans it. Only keeping a memory is: a person at Operator
   * Chat or their own CLI sees each memory as it is kept, while an
   * Automation's Planned Write is applied when nobody is asking (ADR 0197).
   */
  performedOnly?: boolean;
  /**
   * Whether it acts on the outside world the moment it is called, as an MCP
   * Server's tools do, so that it cannot be planned, held for an approval, or
   * withheld by a read-only run: only an unattended run is offered it.
   * Operating a browser is: a click is read and acted on at once (ADR 0200).
   */
  acts?: boolean;
}

const read = (name: ToolName, needs: readonly ToolNeed[] = []): Tool => ({ name, writes: false, reachesContacts: false, needs });
const write = (name: ToolName, reachesContacts: boolean, rest: Pick<Tool, 'performedNeeds' | 'performedOnly'> & { needs?: readonly ToolNeed[] } = {}): Tool => ({
  name, writes: true, reachesContacts, needs: rest.needs ?? [],
  ...(rest.performedNeeds ? { performedNeeds: rest.performedNeeds } : {}),
  ...(rest.performedOnly ? { performedOnly: true } : {}),
});

export const TOOLS: readonly Tool[] = [
  read('query_scheduled_events'),
  read('query_contacts'),
  read('query_attendance'),
  read('mail.search', ['google']),
  read('mail.read', ['google']),
  read('calendar.search', ['google']),
  read('drive.search', ['google']),
  read('drive.read', ['google']),
  read('meet.search', ['google']),
  read('meet.read', ['google']),
  // A Task is a Google Tasks task of the Automation Inbox's Google account, so only a run that holds the grant reads one.
  read('tasks.search', ['google']),
  // A run is started with the Skills it names and told the others by their
  // description; it opens one of those when it applies.
  // Agent Skills' two tools: opening a Skill, and reading a file of it (ADR 0203).
  { ...read('activate_skill', ['skills']), ungranted: true },
  { ...read('read_skill_resource', ['skills']), ungranted: true },
  // Anthropic searches inside the model's own request and the Worker reads the pages Claude names, so only a run whose model is Claude holds it.
  read('web.search', ['web']),
  // A browser is operated as a person operates one: each call acts on the site
  // at once, signed in as the Account saved, and answers what the page shows next (ADR 0200).
  ...(['browser.open', 'browser.read', 'browser.click', 'browser.type', 'browser.select', 'browser.press'] as const)
    .map((name): Tool => ({ ...read(name, ['browser']), acts: true })),
  // Every run the Account starts may recall what was kept; an outside agent's may not (ADR 0197).
  read('memory.search', ['memory']),
  // A Run Token calls nothing but the run's own tools, as the run itself calls
  // them, so issuing one grants no reach a Tool Grant would have to allow (ADR 0199).
  { ...read('run.token', ['run_token']), ungranted: true },
  // Handing the member a file the answer holds reaches nobody else and changes
  // no record of the Account: the file is kept in the conversation beside those
  // Claude wrote, so only a conversation that holds them hands one.
  read('file.hand', ['generated_files']),
  // Code FlareChat runs for the model reaches no network and calls none of
  // its tools: it reads only files the run holds and hands back files, so
  // running it grants no reach a Tool Grant would have to allow (ADR 0202).
  { ...read('code.run', ['code']), ungranted: true },
  // A subagent reaches only what the run that starts it reaches, and plans every write, so it grants no reach; only a run that thinks in FlareChat starts one.
  { ...read('agent.run', ['run_token']), ungranted: true },
  // A Task is kept in Google Tasks and reaches nobody: telling its assignee is a send of its own.
  write('tasks.create', false, { performedNeeds: 'google' }),
  write('tasks.update', false, { performedNeeds: 'google' }),
  write('channel.send', true),
  write('reminder.schedule', true),
  write('mail.send', true, { performedNeeds: 'google' }),
  // A draft stays in the Account's own mailbox until a person sends it, so it reaches nobody.
  write('mail.draft', false, { performedNeeds: 'google' }),
  // Whom an event's attendees may be is the run's bound, not the tool's.
  write('create_scheduled_event', true, { performedNeeds: 'google' }),
  // Changing and cancelling an event reach nobody new: they move or remove a
  // meeting its attendees already hold, without Google mailing any of them.
  write('update_scheduled_event', false, { performedNeeds: 'google' }),
  write('cancel_scheduled_event', false, { performedNeeds: 'google' }),
  write('attach_event_files', false, { performedNeeds: 'google' }),
  // An Event Response is a mail the run read, so only a run that reads mail records one.
  write('record_event_response', false, { needs: ['google'] }),
  // A file Claude wrote is the conversation's, so only the conversation that holds it saves one.
  write('drive.save_file', false, { needs: ['generated_files'], performedNeeds: 'google' }),
  // Google renders the PDF from a copy it removes at once, so nothing is left in the Drive and nobody is reached.
  write('drive.make_pdf', false, { needs: ['generated_files'], performedNeeds: 'google' }),
  // Changing a Skill changes how the Account's later runs work and reaches
  // nobody now; the Account's own Skills are held by every run it starts.
  write('skill.write', false, { needs: ['skills'] }),
  // A file Claude wrote is the conversation's, so only the conversation that holds it, which holds the Skills too, puts one into a Skill.
  write('skill.save_file', false, { needs: ['generated_files'] }),
  write('skill.delete_file', false, { needs: ['skills'] }),
  // Filing the Drive reaches nobody: nothing is shared, and nothing is deleted,
  // since putting a file away moves it into FlareChat's own trash folder.
  write('drive.create_folder', false, { performedNeeds: 'google' }),
  write('drive.move', false, { performedNeeds: 'google' }),
  write('drive.rename', false, { performedNeeds: 'google' }),
  write('drive.trash', false, { performedNeeds: 'google' }),
  // Transcribing a meeting reaches nobody: Google tells those in it that it is transcribed, as it does when a person starts it.
  write('meet.transcribe', false, { performedNeeds: 'google' }),
  // Keeping a memory reaches nobody. Only a run a person is at keeps one, and
  // every memory stays on the 記憶 screen, where a person reads, corrects, and
  // deletes it (ADR 0195).
  write('memory.add', false, { needs: ['memory'], performedOnly: true }),
];

/**
 * The namespaces the product's own tools are named in, such as `memory` and
 * `mail`. No MCP Server may take one as its name: its tools are named
 * `<server>.<tool>`, and one would then share a name with the product's.
 */
export const RESERVED_TOOL_NAMESPACES: readonly string[] = [
  ...new Set(TOOLS.flatMap(({ name }) => (name.includes('.') ? [name.slice(0, name.indexOf('.'))] : []))),
];

export interface ToolRun {
  executionMode: 'read_only' | 'approval' | 'unattended';
  writes: ToolWrites;
  holds: readonly ToolNeed[];
  /** The names a Tool Grant allows; absent for a run that holds the Account's whole set. */
  grant?: readonly string[];
}

/** Whether a run can call a tool at all, before any Tool Grant narrows it. */
const callable = (tool: Tool, run: Omit<ToolRun, 'grant'>): boolean => {
  if (tool.needs.length && !tool.needs.some((need) => run.holds.includes(need))) return false;
  if (tool.acts) return run.executionMode === 'unattended';
  if (!tool.writes) return true;
  if (tool.performedNeeds && !run.holds.includes(tool.performedNeeds)) return false;
  if (tool.performedOnly && run.writes !== 'performed') return false;
  return run.executionMode !== 'read_only';
};

/** The tools one run may call, in this list's order. */
export const selectTools = (run: ToolRun): Tool[] =>
  TOOLS.filter((tool) => callable(tool, run) && (!run.grant || tool.ungranted === true || run.grant.includes(tool.name)));

/** The tools a Tool Grant can name for such a run: those it is not offered whatever its grant. */
const grantable = (run: Omit<ToolRun, 'grant'>): Tool[] => selectTools(run).filter((tool) => tool.ungranted !== true);

/**
 * What Operator Chat is: a run that performs each write and holds the
 * Automation Inbox's Google grant, the Skills, the Memory, the files its
 * conversation wrote, and the web, and, thinking in FlareChat, a Run Token to
 * issue and a browser to operate, whatever its model.
 */
export const OPERATOR_CHAT_RUN: Omit<ToolRun, 'grant'> = { executionMode: 'unattended', writes: 'performed', holds: ['google', 'skills', 'memory', 'generated_files', 'web', 'run_token', 'browser'] };

/**
 * What an Automation's run is: it holds the Automation Inbox's Google grant,
 * the Account's Skills, its Memory, which it may only recall, the web, and,
 * thinking in FlareChat, a Run Token to issue and a browser to operate, and
 * plans every write. Its Trigger Time hands it nothing, so it finds its work
 * through its tools, as its Skills tell it to.
 */
export const automationRun = (executionMode: ToolRun['executionMode']): Omit<ToolRun, 'grant'> =>
  ({ executionMode, writes: 'planned', holds: ['google', 'skills', 'memory', 'web', 'run_token', 'browser'] });

/** What an Automation can be granted: every tool its run can call. */
export const AUTOMATION_TOOLS: readonly Tool[] = grantable(automationRun('unattended'));

/**
 * What an outside agent's Access Token is: a run that performs each write when
 * it is called and holds nothing of the Account's own, neither a Source Message,
 * the Automation Inbox's Google grant, nor the Memory, so the mailbox,
 * calendar, Drive, Tasks, and what the Account keeps stay with the runs it starts.
 */
export const ACCESS_TOKEN_RUN: Omit<ToolRun, 'grant'> = { executionMode: 'unattended', writes: 'performed', holds: [] };

/**
 * What a member's own CLI is when it presents an Operator Token: Operator Chat
 * without the files Claude writes there or the web, since the CLI's own agent
 * writes its files and searches the web where it runs, and without a Run
 * Token or a browser, since the CLI thinks where it runs and is no run of
 * FlareChat's to answer one or to keep a browser open for. It holds the
 * Account's whole set, so it has no grant.
 */
export const OPERATOR_TOKEN_RUN: Omit<ToolRun, 'grant'> = { ...OPERATOR_CHAT_RUN, holds: OPERATOR_CHAT_RUN.holds.filter((need) => need !== 'run_token' && need !== 'browser' && need !== 'generated_files' && need !== 'web') };

/**
 * A run of an Account whose mailbox is not connected: it holds no Google grant,
 * whichever entrance started it, so it is offered no mail, calendar, Drive,
 * Meet, or Task tool until the Account connects one.
 */
export const withoutMailbox = <Run extends Pick<ToolRun, 'holds'>>(run: Run): Run =>
  ({ ...run, holds: run.holds.filter((need) => need !== 'google') });

/**
 * A run of an Account that has not turned its browser on on the ブラウザ screen, or
 * whose Worker has no Browser Run binding: whichever entrance started it, it
 * is offered no browser tool.
 */
export const withoutBrowser = <Run extends Pick<ToolRun, 'holds'>>(run: Run): Run =>
  ({ ...run, holds: run.holds.filter((need) => need !== 'browser') });

/**
 * A run whose Worker lends it an environment to run code in (ADR 0203): it is
 * offered `code.run`, whatever its model.
 */
export const withCode = <Run extends Pick<ToolRun, 'holds'>>(run: Run): Run =>
  (run.holds.includes('code') ? run : { ...run, holds: [...run.holds, 'code'] });

/** The product's tools that operate a browser. */
export const BROWSER_TOOLS: readonly ToolName[] = TOOLS.filter((tool) => tool.needs.includes('browser')).map((tool) => tool.name);

/** What an Access Token can be granted. */
export const ACCESS_TOKEN_TOOLS: readonly Tool[] = grantable(ACCESS_TOKEN_RUN);

export const toolNamed = (name: string): Tool | undefined => TOOLS.find((tool) => tool.name === name);

/**
 * What each tool does, in the words every screen names it by: the tools an
 * Automation or an Access Token may be granted, and a tool Operator Chat
 * waits for approval to call. A name this table does not know is an MCP
 * Server's tool, named `<server>.<tool>`.
 */
export const TOOL_LABELS: Readonly<Record<string, string>> ={
  query_scheduled_events: '予定を調べる',
  query_contacts: '連絡先を調べる',
  query_attendance: '出欠を調べる',
  'tasks.search': 'Google ToDo のタスクを調べる',
  'tasks.create': 'Google ToDo にタスクを登録する',
  'tasks.update': 'Google ToDo のタスクを変える',
  'channel.send': 'メッセージを送る',
  'reminder.schedule': 'リマインドを予約する',
  'mail.search': 'メールを検索する',
  'mail.read': 'メールを読む',
  'mail.send': 'メールを送る',
  'mail.draft': 'メールの下書きを保存する',
  'calendar.search': 'カレンダーを調べる',
  'drive.search': 'Drive を探す',
  'drive.read': 'Drive のファイルを読む',
  'meet.search': 'Meet の会議を調べる',
  'meet.read': 'Meet の文字起こしを読む',
  create_scheduled_event: 'カレンダーに予定を入れる',
  update_scheduled_event: 'カレンダーの予定を変える',
  cancel_scheduled_event: 'カレンダーの予定を中止する',
  attach_event_files: '予定に資料を添付する',
  record_event_response: '予定への返信を記録する',
  'drive.save_file': 'Drive に保存する',
  'drive.make_pdf': 'PDF にする',
  'drive.create_folder': 'Drive にフォルダを作る',
  'drive.move': 'Drive のファイルを移す',
  'drive.rename': 'Drive のファイルの名前を変える',
  'drive.trash': 'Drive のファイルをゴミ箱フォルダに入れる',
  'meet.transcribe': 'Meet の会議を自動で文字起こしする',
  'skill.write': 'スキルを書き換える',
  'skill.save_file': 'スキルにファイルを入れる',
  'skill.delete_file': 'スキルのファイルを削除する',
  // Claude's own sandbox, where it writes files; never granted, only shown while Operator Chat uses it.
  code_execution: 'ファイルを作る',
  // Tools of the former mail and Morning Automations, which only their runs' history still names.
  report: '読む人に知らせる',
  'morning.send': '朝のお知らせを送る',
  activate_skill: 'スキルを開く',
  read_skill_resource: 'スキルのファイルを読む',
  'web.search': 'ウェブを調べる',
  'browser.open': 'ブラウザでページを開く',
  'browser.read': 'ブラウザの画面を読む',
  'browser.click': 'ブラウザでクリックする',
  'browser.type': 'ブラウザで入力する',
  'browser.select': 'ブラウザで選ぶ',
  'browser.press': 'ブラウザでキーを押す',
  'memory.search': '記憶を探す',
  'run.token': 'プログラムに道具を使わせる',
  'file.hand': 'ファイルを渡す',
  'code.run': 'コードを実行する',
  'agent.run': 'サブエージェントに任せる',
  'memory.add': '記憶する',
};

/**
 * A tool in the words a person reads it by: the product's own tool by its
 * label, and an MCP Server's tool, named `<server>.<tool>`, as the server's
 * tool. A server's name holds no dot, so the first one parts the two.
 */
export const toolLabel = (name: string): string => {
  const label = TOOL_LABELS[name];
  if (label !== undefined) return label;
  const dot = name.indexOf('.');
  return dot > 0 && dot < name.length - 1 ? `${name.slice(0, dot)} の ${name.slice(dot + 1)}` : name;
};

/**
 * Whether a call of the tool waits for a person in a conversation that asks
 * before it writes: a tool that writes, or one that acts on the outside world
 * the moment it is called, as operating a browser does. Every MCP Server's
 * tool acts, so a tool this list does not know is one that waits.
 */
export const asksApproval = (name: string): boolean => {
  const known = toolNamed(name);
  return !known || known.writes || known.acts === true;
};

/** The product's own tools a conversation that asks before it writes waits for, in this list's order. */
export const APPROVAL_TOOLS: readonly ToolName[] = TOOLS.filter((tool) => asksApproval(tool.name)).map((tool) => tool.name);
