import { describe, expect, it } from 'vitest';

import { APPROVAL_TOOLS, CHAT_MODES, type ChatMode } from '@mail/domain';

import { ASKED, chatGuard, chatPreview, describeCall, gate, labelOf, offeredTools } from './approval';
import { judge, NO_DECIDER, UNDECIDED, UNJUDGED, type Decider } from './decider';
import { decides, modeIn, offeredModes } from './modes';
import { decodePause, encodePause, type Pause } from './pause';
import { CallHeld, type RunTool } from './turns';

const internal = (name: string): RunTool => ({ name, description: name, parameters: {}, origin: { kind: 'internal' } });
const mcp = (server: string, name: string): RunTool => ({
  name: `${server}.${name}`, description: name, parameters: {}, origin: { kind: 'mcp', serverId: `${server}-1`, toolName: name, connection: { url: 'https://mcp.example.com' } },
});

const SEARCH = internal('calendar.search');
const SEND = internal('mail.send');
const CLICK = internal('browser.click');
const OPEN = internal('browser.open');
const READ = internal('browser.read');
const NOTION = mcp('notion', 'search');
const TOOLS = [SEARCH, SEND, CLICK, OPEN, READ, NOTION];

const allow: Decider = { judge: async () => ({ allow: true }) };
const failing: Decider = { judge: async () => { throw new Error('OpenRouter 503'); } };

const decided = (mode: ChatMode, tool: RunTool, options: { allowed?: boolean; decider?: Decider } = {}) => gate({
  mode, tool, arguments: { to: 'a@example.com' }, request: '送って',
  allowed: async () => options.allowed ?? false,
  decider: options.decider ?? NO_DECIDER,
});

describe('which calls wait for a person', () => {
  it('counts as writing or acting every tool the product\'s list marks so, and every MCP Server tool', () => {
    expect(APPROVAL_TOOLS).toEqual([
      'browser.open', 'browser.read', 'browser.click', 'browser.type', 'browser.select', 'browser.press',
      'tasks.create', 'tasks.update', 'channel.send', 'reminder.schedule', 'mail.send', 'mail.draft',
      'create_scheduled_event', 'update_scheduled_event', 'cancel_scheduled_event', 'attach_event_files', 'record_event_response',
      'drive.save_file', 'drive.make_pdf', 'skill.write', 'skill.save_file', 'skill.delete_file',
      'drive.create_folder', 'drive.move', 'drive.rename', 'drive.trash', 'meet.transcribe', 'memory.add',
    ]);
  });

  it('offers no tool that writes or acts in read-only, and every tool in the other modes', () => {
    expect(offeredTools(TOOLS, 'read_only').map((tool) => tool.name)).toEqual(['calendar.search']);
    for (const mode of CHAT_MODES.filter((entry) => entry !== 'read_only')) expect(offeredTools(TOOLS, mode)).toEqual(TOOLS);
  });

  it('makes a read in every mode, and a write as each mode says', async () => {
    for (const mode of CHAT_MODES) expect(await decided(mode, SEARCH)).toEqual({ kind: 'make' });
    expect(await decided('unrestricted', SEND)).toEqual({ kind: 'make' });
    expect(await decided('ask', SEND)).toEqual({ kind: 'ask', reason: ASKED });
    expect(await decided('ask', NOTION)).toEqual({ kind: 'ask', reason: ASKED });
    expect(await decided('ask', CLICK)).toEqual({ kind: 'ask', reason: ASKED });
    expect(await decided('read_only', SEND)).toMatchObject({ kind: 'refuse', message: expect.stringContaining('read-only') });
    expect(await decided('auto', SEND, { decider: allow })).toEqual({ kind: 'make' });
  });

  it('fails closed in auto: with no Decider, or one that fails or says nothing it can be held to, the person is asked', async () => {
    expect(await decided('auto', SEND)).toEqual({ kind: 'ask', reason: UNDECIDED });
    expect(await decided('auto', SEND, { decider: failing })).toEqual({ kind: 'ask', reason: UNJUDGED });
    const vague = { judge: async () => ({ allow: 'yes' }) } as unknown as Decider;
    expect(await decided('auto', SEND, { decider: vague })).toEqual({ kind: 'ask', reason: UNJUDGED });
    const risky: Decider = { judge: async () => ({ allow: false, reason: '外部の宛先です。' }) };
    expect(await decided('auto', SEND, { decider: risky })).toEqual({ kind: 'ask', reason: '外部の宛先です。' });
    expect(await judge({ judge: async () => ({ allow: false, reason: ' ' }) }, { tool: 'mail.send', label: '', arguments: {}, request: '' })).toEqual({ allow: false, reason: UNJUDGED });
  });

  it('opens and reads a page in the browser without asking, still asks before clicking, typing, choosing, or pressing a key, and offers no browser in read-only', async () => {
    for (const tool of [OPEN, READ]) {
      for (const mode of ['ask', 'auto', 'unrestricted'] as const) expect(await decided(mode, tool)).toEqual({ kind: 'make' });
      expect(await decided('read_only', tool)).toMatchObject({ kind: 'refuse' });
    }
    for (const name of ['browser.click', 'browser.type', 'browser.select', 'browser.press']) {
      expect(await decided('ask', internal(name))).toEqual({ kind: 'ask', reason: ASKED });
      expect(await decided('auto', internal(name))).toEqual({ kind: 'ask', reason: UNDECIDED });
    }
    // A server's tool named like the browser's is a server's, and waits.
    expect(await decided('ask', mcp('browser', 'open'))).toEqual({ kind: 'ask', reason: ASKED });
    expect(offeredTools(TOOLS, 'read_only').some((tool) => tool.name.startsWith('browser.'))).toBe(false);
  });

  it('makes a tool allowed always without asking in ask and auto, and still refuses it in read-only', async () => {
    expect(await decided('ask', SEND, { allowed: true })).toEqual({ kind: 'make' });
    expect(await decided('auto', SEND, { allowed: true })).toEqual({ kind: 'make' });
    expect(await decided('read_only', SEND, { allowed: true })).toMatchObject({ kind: 'refuse' });
  });
});

describe('which modes a conversation offers', () => {
  it('offers 自動 only with an OpenRouter key, and is 無制限 in a conversation kept in 自動 without one', () => {
    expect(decides({})).toBe(false);
    expect(decides({ OPENROUTER_API_KEY: ' ' })).toBe(false);
    expect(decides({ OPENROUTER_API_KEY: 'sk-or-test' })).toBe(true);
    expect(offeredModes(false)).toEqual(['read_only', 'ask', 'unrestricted']);
    expect(offeredModes(true)).toEqual(CHAT_MODES);
    expect(modeIn('auto', false)).toBe('unrestricted');
    expect(modeIn('auto', true)).toBe('auto');
    for (const mode of ['read_only', 'ask', 'unrestricted'] as const) expect(modeIn(mode, false)).toBe(mode);
  });
});

describe('the guard of one answer', () => {
  const guardOf = (mode: () => ChatMode, answered?: Parameters<typeof chatGuard>[0]['answered']) =>
    chatGuard({ tools: TOOLS, mode, request: '送って', allowed: async () => false, decider: NO_DECIDER, ...(answered ? { answered } : {}) });

  it('holds a call that waits, and refuses one a program made, which cannot wait', async () => {
    const guard = guardOf(() => 'ask');

    await expect(guard('calendar.search', {}, { id: 'call-1', program: false })).resolves.toBeUndefined();
    await expect(guard('mail.send', {}, { id: 'call-2', program: false })).rejects.toBeInstanceOf(CallHeld);
    await expect(guard('mail.send', {}, { id: 'program-1', program: true })).resolves.toMatchObject({ isError: true, message: expect.stringContaining('not from a program') });
  });

  it('reads the mode at every call, so a change applies from the next one', async () => {
    let mode: ChatMode = 'unrestricted';
    const guard = guardOf(() => mode);

    await expect(guard('mail.send', {}, { id: 'call-1', program: false })).resolves.toBeUndefined();
    mode = 'ask';
    await expect(guard('mail.send', {}, { id: 'call-2', program: false })).rejects.toBeInstanceOf(CallHeld);
  });

  it('answers the held call once by the member\'s answer: approved, it is made; declined, the model is told why in the member\'s words', async () => {
    const approved = guardOf(() => 'ask', { callId: 'call-1', answer: { decision: 'accept' } });
    await expect(approved('mail.send', {}, { id: 'call-1', program: false })).resolves.toBeUndefined();
    // Only once: the same tool called again is asked about again.
    await expect(approved('mail.send', {}, { id: 'call-1', program: false })).rejects.toBeInstanceOf(CallHeld);

    const declined = guardOf(() => 'ask', { callId: 'call-1', answer: { decision: 'decline', feedback: '宛先は b@example.com です' } });
    await expect(declined('mail.send', {}, { id: 'call-1', program: false })).resolves.toEqual({
      isError: true,
      message: 'The member declined this call, so mail.send was not made. They said: 宛先は b@example.com です Do not make it again unless they ask for it.',
    });
  });
});

describe('a call waiting for approval, as the member reads it', () => {
  it('names the tool in words and each argument on a line of its own, or what it will do in words in their place when there is a preview', () => {
    expect(labelOf(SEND)).toBe('メールを送る');
    expect(labelOf(NOTION)).toBe('notion の search');
    expect(describeCall({ label: 'メールを送る', arguments: { to: ['a@example.com', 'b@example.com'], subject: '定例', body: '皆さま\nよろしく', urgent: true }, preview: null })).toBe(
      'メールを送る\nto: a@example.com, b@example.com\nsubject: 定例\nbody:\n  皆さま\n  よろしく\nurgent: true',
    );
    expect(describeCall({ label: 'メールを送る', arguments: { to: 'a@example.com' }, preview: '宛先：a@example.com' })).toBe('メールを送る\n宛先：a@example.com');
  });

  it('previews a mail or an event write in words, reading the event a change names as OrangeAgent recorded it', async () => {
    const read: string[] = [];
    const preview = chatPreview(async (eventId) => {
      read.push(eventId);
      return eventId === 'event-1' ? { title: '週次定例', startsAt: '2026-11-27T10:00:00+09:00', endsAt: '2026-11-27T10:30:00+09:00', location: '' } : null;
    });

    expect(await preview('mail.send', { to: 'a@example.com', subject: '定例', body: 'よろしく' })).toBe('宛先：a@example.com\n件名：定例\n本文：\nよろしく');
    expect(await preview('update_scheduled_event', { eventId: 'event-1', startsAt: '2026-11-26T15:00:00+09:00', endsAt: '2026-11-26T15:30:00+09:00' }))
      .toBe('予定名：週次定例\n日時：2026年11月27日(金) 10:00〜10:30 → 2026年11月26日(木) 15:00〜15:30');
    expect(await preview('cancel_scheduled_event', { eventId: 'event-2' })).toBe('予定：event-2（OrangeAgent に記録がありません）');
    expect(await chatPreview(async () => { throw new Error('D1 is down'); })('cancel_scheduled_event', { eventId: 'event-1' })).toBe('予定：event-1（OrangeAgent に記録がありません）');
    // A tool without a preview keeps its arguments, and reads no event.
    expect(await preview('channel.send', { eventId: 'event-1', text: 'こんにちは' })).toBeNull();
    expect(await preview('create_scheduled_event', { eventId: 'event-1', title: '総会', startsAt: '2026-12-05', endsAt: '2026-12-06' })).toBe('予定名：総会\n日時：2026年12月5日(土) 終日');
    expect(read).toEqual(['event-1', 'event-2']);
  });

  it('is kept as JSON text and each file\'s bytes, and read back as it was', () => {
    const pause: Pause = {
      id: 'request-1', runId: 'run-1', request: '送って', model: 'm', itemId: 'item-1', createdAt: '2026-11-21T00:00:00.000Z',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'mail.read', arguments: '{}' }, { id: 'call-2', name: 'mail.send', arguments: '{}' }] },
        { role: 'tool', name: 'mail.read', toolCallId: 'call-1', content: '{"subject":"請求"}', attachments: [{ filename: '請求書.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }] },
      ],
      calls: [{ id: 'call-2', name: 'mail.send', arguments: '{}' }],
      reason: ASKED, label: 'メールを送る', description: 'メールを送る', preview: null,
      spent: { model: 'm', tokens: 10, toolCalls: 2, output: '' },
    };

    const { state, files } = encodePause(pause);

    expect(state).not.toContain('37,80');
    expect(files).toEqual([new Uint8Array([37, 80, 68, 70])]);
    expect(decodePause(state, files)).toEqual(pause);
    expect(() => decodePause(state, [])).toThrow('請求書.pdf');
  });
});
