import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_TOOLS, AUTOMATION_TOOLS, OPERATOR_CHAT_RUN, OPERATOR_TOKEN_RUN, TOOLS, automationRun, selectTools, toolLabel, toolNamed, withCode, withoutBrowser, withoutMailbox, BROWSER_TOOLS, type ToolNeed, type ToolRun } from './tools';

const names = (run: ToolRun): string[] => selectTools(run).map((tool) => tool.name);

const chat: ToolRun = OPERATOR_CHAT_RUN;
const timed: ToolRun = automationRun('unattended');
/** The tools every run the Account starts is offered whatever its grant: opening its Skills and reading their files, issuing a Run Token, and starting a subagent. */
const UNGRANTED = ['activate_skill', 'read_skill_resource', 'run.token', 'agent.run'];

const HOLDINGS: ReadonlyArray<readonly ToolNeed[]> = [[], ['google'], ['skills'], ['google', 'skills'], ['google', 'skills', 'web']];

describe('the one list of tools', () => {
  it('lists each capability once, under the one name it has', () => {
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
    for (const retired of ['read_source_message', 'send_line_message', 'send_email_summary', 'calendar.create', 'contacts.search', 'report', 'morning.send']) {
      expect(toolNamed(retired)).toBeUndefined();
    }
  });

  it('offers the same tools to runs that hold the same things, whether they plan or perform their writes', () => {
    for (const holds of HOLDINGS) {
      // Performing a calendar or mail write needs the Google grant now; a run that holds it is offered the same writes either way.
      const both = [...new Set([...holds, 'google' as const])];
      for (const executionMode of ['read_only', 'approval', 'unattended'] as const) {
        expect(names({ executionMode, writes: 'planned', holds: both })).toEqual(names({ executionMode, writes: 'performed', holds: both }));
      }
    }
  });

  it('plans every Automation’s writes and performs Operator Chat’s', () => {
    expect(timed.writes).toBe('planned');
    expect(chat.writes).toBe('performed');
  });

  it('offers an Automation exactly what Operator Chat holds, for its grant to narrow', () => {
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).toEqual(names(chat).filter((name) => !UNGRANTED.includes(name) && name !== 'file.hand' && name !== 'drive.save_file' && name !== 'drive.make_pdf' && name !== 'skill.save_file' && name !== 'memory.add'));
    expect(names({ ...timed, grant: ['tasks.search', 'tasks.create'] })).toEqual(['tasks.search', 'activate_skill', 'read_skill_resource', 'run.token', 'agent.run', 'tasks.create']);
  });

  it('reads mail and records an Event Response from it in any run that holds the mailbox', () => {
    for (const run of [chat, timed]) expect(names(run)).toEqual(expect.arrayContaining(['mail.search', 'mail.read', 'calendar.search', 'record_event_response']));
  });

  it('reads the Drive in any run that holds the Google grant, files it in any that may write, and never in an outside agent’s', () => {
    const filing = ['drive.create_folder', 'drive.move', 'drive.rename', 'drive.trash'];
    for (const run of [chat, timed]) expect(names(run)).toEqual(expect.arrayContaining(['drive.search', 'drive.read', ...filing]));
    expect(names(automationRun('read_only'))).toEqual(expect.arrayContaining(['drive.search', 'drive.read']));
    expect(names(automationRun('read_only'))).not.toEqual(expect.arrayContaining(['drive.move']));
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['drive.read']));
    for (const name of filing) expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain(name);
  });

  it('reads Meet transcripts in any run that holds the Google grant, transcribes a meeting in any that may write, and never in an outside agent’s', () => {
    for (const run of [chat, timed]) expect(names(run)).toEqual(expect.arrayContaining(['meet.search', 'meet.read', 'meet.transcribe']));
    expect(names(automationRun('read_only'))).toEqual(expect.arrayContaining(['meet.search', 'meet.read']));
    expect(names(automationRun('read_only'))).not.toContain('meet.transcribe');
    for (const name of ['meet.search', 'meet.read', 'meet.transcribe']) expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain(name);
  });

  it('lets every run the Account starts read its Skills whatever its grant, and an outside agent none of them', () => {
    for (const run of [chat, timed]) expect(names(run)).toEqual(expect.arrayContaining(['activate_skill', 'read_skill_resource']));
    expect(names({ ...timed, grant: [] })).toEqual(UNGRANTED);
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain('activate_skill');
  });

  it('lets every run that thinks in OrangeAgent issue a Run Token whatever its grant, and neither an outside agent nor a member’s CLI', () => {
    for (const run of [chat, timed, automationRun('read_only'), automationRun('approval')]) expect(names(run)).toContain('run.token');
    expect(names({ ...timed, grant: [] })).toContain('run.token');
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).not.toContain('run.token');
    expect(names(OPERATOR_TOKEN_RUN)).not.toContain('run.token');
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain('run.token');
  });

  it('lets a run a person is at keep and recall memories, an Automation only recall them, and an outside agent neither', () => {
    for (const run of [chat, OPERATOR_TOKEN_RUN, withoutMailbox(chat)]) expect(names(run)).toEqual(expect.arrayContaining(['memory.search', 'memory.add']));
    for (const executionMode of ['read_only', 'approval', 'unattended'] as const) {
      expect(names(automationRun(executionMode))).toContain('memory.search');
      expect(names(automationRun(executionMode))).not.toContain('memory.add');
    }
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).toContain('memory.search');
    expect(names({ ...timed, grant: [] })).not.toContain('memory.search');
    for (const name of ['memory.search', 'memory.add']) expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain(name);
    expect(names({ ...chat, executionMode: 'read_only' })).toContain('memory.search');
  });

  it('offers an Access Token the Account’s own records and its sends, but not its mailbox, its calendar, or its Tasks, which are kept in Google Tasks', () => {
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).toEqual([
      'query_scheduled_events', 'query_contacts', 'query_attendance',
      'channel.send', 'reminder.schedule',
    ]);
  });

  it('binds no write in read-only mode', () => {
    expect(selectTools({ ...chat, executionMode: 'read_only' }).every((tool) => !tool.writes)).toBe(true);
    expect(selectTools(automationRun('read_only')).every((tool) => !tool.writes)).toBe(true);
  });

  it('reads the web in every run the Account starts, whatever its model, and only as its grant allows', () => {
    expect(names(chat)).toContain('web.search');
    expect(names(automationRun('read_only'))).toContain('web.search');
    expect(names(timed)).toContain('web.search');
    expect(names({ ...timed, grant: ['tasks.search'] })).not.toContain('web.search');
    expect(names({ ...timed, grant: ['web.search'] })).toEqual(['activate_skill', 'read_skill_resource', 'web.search', 'run.token', 'agent.run']);
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain('web.search');
  });

  it('operates a browser in every unattended run the Account starts, chat or Automation alike, unless the Account turned it off', () => {
    const browserIn = (run: ToolRun): string[] => names(run).filter((name) => name.startsWith('browser.'));
    expect(BROWSER_TOOLS).toEqual(['browser.open', 'browser.read', 'browser.click', 'browser.type', 'browser.select', 'browser.press']);
    expect(browserIn(chat)).toEqual(BROWSER_TOOLS);
    expect(browserIn(timed)).toEqual(BROWSER_TOOLS);
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining([...BROWSER_TOOLS]));
    // A click acts at once, so it can be neither planned for approval nor withheld by a read-only run.
    expect(browserIn(automationRun('approval'))).toEqual([]);
    expect(browserIn(automationRun('read_only'))).toEqual([]);
    expect(browserIn(withoutBrowser(chat))).toEqual([]);
    expect(browserIn(withoutBrowser(timed))).toEqual([]);
    expect(browserIn({ ...timed, grant: ['browser.open', 'browser.read'] })).toEqual(['browser.open', 'browser.read']);
    // Neither an outside agent nor a member's own CLI is a run OrangeAgent keeps a browser open for.
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name).filter((name) => name.startsWith('browser.'))).toEqual([]);
    expect(browserIn(OPERATOR_TOKEN_RUN)).toEqual([]);
    expect(TOOLS.filter((tool) => tool.acts).every((tool) => !tool.writes)).toBe(true);
  });

  it('hands the member a file, saves one to Drive, makes a PDF of it, or puts it into a Skill, only in a conversation that holds its files', () => {
    const own = (name: string): boolean => name === 'file.hand' || name === 'drive.save_file' || name === 'drive.make_pdf' || name === 'skill.save_file';
    expect(names(chat)).toEqual(expect.arrayContaining(['file.hand', 'drive.save_file', 'drive.make_pdf', 'skill.save_file']));
    expect(names(OPERATOR_TOKEN_RUN).filter(own)).toEqual([]);
    expect(AUTOMATION_TOOLS.map((tool) => tool.name).filter(own)).toEqual([]);
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name).filter(own)).toEqual([]);
  });

  it('changes the Account’s Skills from every run the Account starts, an Automation only when granted, and never from an Access Token', () => {
    const writes = ['skill.write', 'skill.delete_file'];
    expect(names(chat)).toEqual(expect.arrayContaining(writes));
    expect(names(OPERATOR_TOKEN_RUN)).toEqual(expect.arrayContaining(writes));
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(writes));
    expect(names({ ...timed, grant: [] })).toEqual(UNGRANTED);
    expect(names(automationRun('read_only'))).not.toContain('skill.write');
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name).filter((name) => name.startsWith('skill.'))).toEqual([]);
  });

  it('offers a run of an Account with no mailbox no mail, calendar, Drive, Meet, or Task tool, and everything else it would have', () => {
    for (const run of [chat, automationRun('unattended'), OPERATOR_TOKEN_RUN]) {
      const without = names(withoutMailbox(run));
      expect(without.filter((name) => /^(mail|calendar|drive|meet|tasks)\./u.test(name))).toEqual([]);
      expect(without).toEqual(expect.arrayContaining(['query_contacts', 'channel.send', 'activate_skill']));
      expect(without.every((name) => names(run).includes(name))).toBe(true);
    }
  });

  it('lists no tool that no run can call', () => {
    const callable = new Set([...names(withCode(chat)), ...names(timed)]);
    expect(TOOLS.filter((tool) => !callable.has(tool.name))).toEqual([]);
  });
});

describe('the environment OrangeAgent lends every model', () => {
  it('offers code.run to every run whose Worker lends one, whatever its grant, since it reaches only what the run reaches', () => {
    const lent = withCode(automationRun('read_only'));
    expect(names(lent)).toContain('code.run');
    expect(names({ ...lent, grant: ['tasks.search'] })).toContain('code.run');
    expect(names(withCode(chat))).toContain('code.run');
    expect(names(timed)).not.toContain('code.run');
    expect(AUTOMATION_TOOLS.map((tool) => tool.name)).not.toContain('code.run');
    expect(ACCESS_TOKEN_TOOLS.map((tool) => tool.name)).not.toContain('code.run');
    expect(withCode(lent)).toEqual(lent);
  });
});

describe('a tool in words', () => {
  it('names the product\'s tools by their labels and a server\'s tool by the server and the tool', () => {
    expect(toolLabel('mail.send')).toBe('メールを送る');
    expect(toolLabel('update_scheduled_event')).toBe('カレンダーの予定を変える');
    expect(toolLabel('notion.search_pages')).toBe('notion の search_pages');
    expect(toolLabel('mystery')).toBe('mystery');
  });
});
