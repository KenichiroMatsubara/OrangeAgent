import { describe, expect, it } from 'vitest';

import { emptyProjection, finishTurn, historyOf, itemEvent, messageEvent, onTurnEvent, queueMessage, readSteers, requestInterrupt, runEvent, startTurn, steerItem, threadOf, attachFile, recordUsage, unreadSteers, type Change } from './timeline';
import { encodeEvent, decodeEvent } from '@mail/t3chat/wire';
import { decodeFrame, encodeFrame, foldEvent, type Projection, type TurnItem } from '@mail/t3chat/wire';

const AT = Date.parse('2026-11-21T01:00:00.000Z');

const fresh = (): Projection => emptyProjection(threadOf({ id: 'thread-1', title: '', createdAt: AT, updatedAt: AT }));

const started = (projection = fresh()) => startTurn({ projection, runId: 'run-1', request: '今日の予定は？', model: 'test-model', at: AT });

const items = (changes: readonly Change[]): TurnItem[] => changes.map((change) => change.item);

/** Every change must encode as t3code's wire does and decode back as the copied client reads it. */
const roundTrips = (changes: readonly Change[]): void => {
  for (const change of changes) {
    const frame = encodeFrame({ kind: 'event', sequence: 1, event: itemEvent(change.item, AT) });
    expect(decodeFrame(frame)).toMatchObject({ kind: 'event', sequence: 1, event: { type: 'turn-item.updated', payload: { id: change.item.id } } });
  }
};

describe('an answer as t3code turn items', () => {
  it('starts with the member message, finished, and its Run running', () => {
    const { run, user } = started();

    expect(user).toMatchObject({ type: 'user_message', text: '今日の予定は？', status: 'completed', runId: 'run-1', ordinal: 0, inputIntent: 'turn_start' });
    expect(run).toMatchObject({ id: 'run-1', threadId: 'thread-1', ordinal: 1, status: 'running', modelSelection: { model: 'test-model' } });
  });

  it('streams the words into one assistant item until a tool call closes it, and shows the call with what it was asked and answered', () => {
    const { turn } = started();
    const first = onTurnEvent(turn, { type: 'text', text: '確認' }, AT);
    const second = onTurnEvent(turn, { type: 'text', text: 'します' }, AT);
    const call = onTurnEvent(turn, { type: 'tool', name: 'calendar.search', state: 'started', id: 'call-1', arguments: '{"from":"2026-11-21"}' }, AT);
    const done = onTurnEvent(turn, { type: 'tool', name: 'calendar.search', state: 'finished', id: 'call-1', result: [{ title: '定例' }] }, AT);
    const after = onTurnEvent(turn, { type: 'text', text: '1件です。' }, AT);

    expect(first).toEqual([expect.objectContaining({ streaming: true })]);
    expect(second[0]?.item).toMatchObject({ type: 'assistant_message', text: '確認します', streaming: true, status: 'running' });
    expect(items(call)).toEqual([
      expect.objectContaining({ type: 'assistant_message', text: '確認します', streaming: false, status: 'completed' }),
      expect.objectContaining({ type: 'dynamic_tool', toolName: 'calendar.search', status: 'running', input: { from: '2026-11-21' } }),
    ]);
    expect(call.map((change) => change.streaming)).toEqual([false, false]);
    expect(items(done)).toEqual([expect.objectContaining({ type: 'dynamic_tool', status: 'completed', output: [{ title: '定例' }] })]);
    expect(done[0]?.item.id).toBe(call[1]?.item.id);
    // Words after a call are a new item, after it.
    expect(after[0]?.item.id).not.toBe(first[0]?.item.id);
    expect(after[0]?.item.ordinal).toBeGreaterThan(call[1]?.item.ordinal ?? Infinity);
    roundTrips([...first, ...call, ...done, ...after]);
  });

  it('names each call in words: the product\'s tool by its label, a server\'s by the server and its tool, even one whose start was never seen', () => {
    const { turn } = started();
    const own = onTurnEvent(turn, { type: 'tool', name: 'mail.send', state: 'started', id: 'call-1', arguments: '{}' }, AT);
    const server = onTurnEvent(turn, { type: 'tool', name: 'notion.search', state: 'started', id: 'call-2', arguments: '{}' }, AT);
    const unseen = onTurnEvent(turn, { type: 'tool', name: 'update_scheduled_event', state: 'failed', id: 'call-3', error: '見つかりません' }, AT);

    expect(own[0]?.item.title).toBe('メールを送る');
    expect(server[0]?.item.title).toBe('notion の search');
    expect(unseen[0]?.item).toMatchObject({ title: 'カレンダーの予定を変える', toolName: 'update_scheduled_event', status: 'failed', output: '見つかりません' });
  });

  it('shows reasoning in its own item, closed when the words begin', () => {
    const { turn } = started();
    const thinking = onTurnEvent(turn, { type: 'reasoning', text: '予定を見る' }, AT);
    const words = onTurnEvent(turn, { type: 'text', text: '2件です' }, AT);

    expect(thinking).toEqual([{ item: expect.objectContaining({ type: 'reasoning', text: '予定を見る', streaming: true }), streaming: true }]);
    expect(items(words)).toEqual([
      expect.objectContaining({ type: 'reasoning', streaming: false, status: 'completed' }),
      expect.objectContaining({ type: 'assistant_message', text: '2件です' }),
    ]);
    roundTrips([...thinking, ...words]);
  });

  it('shows a failed call in the words of what refused it, even one whose start was never seen', () => {
    const { turn } = started();
    onTurnEvent(turn, { type: 'tool', name: 'mail.search', state: 'started', id: 'call-1', arguments: 'not json' }, AT);
    const failed = onTurnEvent(turn, { type: 'tool', name: 'mail.search', state: 'failed', id: 'call-1', error: 'GoogleApiError 429: Too many requests' }, AT);
    const unseen = onTurnEvent(turn, { type: 'tool', name: 'web.search', state: 'failed', error: 'web_fetch: url_not_accessible' }, AT);

    expect(failed[0]?.item).toMatchObject({ type: 'dynamic_tool', status: 'failed', input: 'not json', output: 'GoogleApiError 429: Too many requests' });
    expect(unseen[0]?.item).toMatchObject({ type: 'dynamic_tool', toolName: 'web.search', status: 'failed', output: 'web_fetch: url_not_accessible' });
    roundTrips([...failed, ...unseen]);
  });

  it('keeps only the start of a very long answer of a tool for the screen', () => {
    const { turn } = started();
    onTurnEvent(turn, { type: 'tool', name: 'mail.read', state: 'started', id: 'call-1', arguments: '{}' }, AT);
    const [change] = onTurnEvent(turn, { type: 'tool', name: 'mail.read', state: 'finished', id: 'call-1', result: { body: 'あ'.repeat(40_000) } }, AT);

    const output = change?.item.type === 'dynamic_tool' ? change.item.output : null;
    expect(typeof output).toBe('string');
    expect(String(output).length).toBeLessThan(17_000);
  });

  it('shows a picture an answer kept inline and any other file as a file, beside its words', () => {
    const { turn } = started();
    onTurnEvent(turn, { type: 'text', text: '撮りました' }, AT);
    const picture = attachFile(turn, { id: 'file-1', filename: 'screen.png', mediaType: 'image/png', size: 2048 }, AT);
    const workbook = attachFile(turn, { id: 'file-2', filename: '請求.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4096 }, AT);

    expect(workbook[0]?.item).toMatchObject({
      type: 'assistant_message',
      text: '撮りました',
      attachments: [
        { type: 'image', id: 'file-1', name: 'screen.png', mimeType: 'image/png', sizeBytes: 2048 },
        { type: 'file', id: 'file-2', name: '請求.xlsx', sizeBytes: 4096 },
      ],
    });
    expect(picture[0]?.item.id).toBe(workbook[0]?.item.id);
    roundTrips([...picture, ...workbook]);
  });

  it('fails a call still running when the answer fails, and says why in an error item', () => {
    const { turn } = started();
    onTurnEvent(turn, { type: 'text', text: '途中' }, AT);
    onTurnEvent(turn, { type: 'tool', name: 'drive.read', state: 'started', id: 'call-1' }, AT);
    const { changes, run } = finishTurn(turn, { kind: 'failed', message: 'Anthropic API: overloaded' }, AT);

    expect(items(changes)).toEqual([
      expect.objectContaining({ type: 'dynamic_tool', status: 'failed', output: expect.stringContaining('終わりませんでした') }),
      expect.objectContaining({ type: 'error', failure: expect.objectContaining({ message: 'Anthropic API: overloaded' }) }),
    ]);
    expect(run).toMatchObject({ status: 'failed', completedAt: expect.anything() });
    roundTrips(changes);
  });

  it('ends a stopped answer with the interrupt it asked for and its result, its words kept', () => {
    const { turn } = started();
    onTurnEvent(turn, { type: 'text', text: '書きかけ' }, AT);
    const asked = requestInterrupt(turn, AT);
    const { changes, run } = finishTurn(turn, { kind: 'interrupted' }, AT);

    expect(asked[0]?.item).toMatchObject({ type: 'run_interrupt_request', status: 'running' });
    expect(items(changes)).toEqual([
      expect.objectContaining({ type: 'assistant_message', text: '書きかけ', status: 'interrupted', streaming: false }),
      expect.objectContaining({ type: 'run_interrupt_request', status: 'completed' }),
      expect.objectContaining({ type: 'run_interrupt_result', status: 'completed' }),
    ]);
    expect(run.status).toBe('interrupted');
    roundTrips([...asked, ...changes]);
  });

  it('replays each earlier answer that ended as the member message and its words, a stopped one noted', () => {
    let projection = fresh();
    const fold = (changes: readonly Change[]) => {
      for (const change of changes) projection = foldEvent(projection, itemEvent(change.item, AT));
    };
    const first = startTurn({ projection, runId: 'run-1', request: '予定は？', model: 'm', at: AT });
    projection = foldEvent(foldEvent(projection, itemEvent(first.user, AT)), runEvent('run.created', first.run, AT));
    fold(onTurnEvent(first.turn, { type: 'text', text: '2件です。' }, AT));
    fold(onTurnEvent(first.turn, { type: 'tool', name: 'calendar.search', state: 'started', id: 'c' }, AT));
    fold(onTurnEvent(first.turn, { type: 'tool', name: 'calendar.search', state: 'finished', id: 'c', result: [] }, AT));
    fold(onTurnEvent(first.turn, { type: 'text', text: '以上です。' }, AT));
    const ended = finishTurn(first.turn, { kind: 'completed' }, AT);
    fold(ended.changes);
    projection = foldEvent(projection, runEvent('run.updated', ended.run, AT));

    const second = startTurn({ projection, runId: 'run-2', request: '詳しく', model: 'm', at: AT });
    projection = foldEvent(foldEvent(projection, itemEvent(second.user, AT)), runEvent('run.created', second.run, AT));
    fold(onTurnEvent(second.turn, { type: 'text', text: '書きか' }, AT));
    const stopped = finishTurn(second.turn, { kind: 'interrupted' }, AT);
    fold(stopped.changes);
    projection = foldEvent(projection, runEvent('run.updated', stopped.run, AT));

    const third = startTurn({ projection, runId: 'run-3', request: '失敗', model: 'm', at: AT });
    projection = foldEvent(foldEvent(projection, itemEvent(third.user, AT)), runEvent('run.created', third.run, AT));
    const failed = finishTurn(third.turn, { kind: 'failed', message: 'x' }, AT);
    fold(failed.changes);
    projection = foldEvent(projection, runEvent('run.updated', failed.run, AT));

    expect(second.run.ordinal).toBe(2);
    expect(historyOf(projection)).toEqual([
      { message: { role: 'user', content: '予定は？' }, files: [] },
      { message: { role: 'assistant', content: '2件です。\n\n以上です。' }, files: [] },
      { message: { role: 'user', content: '詳しく' }, files: [] },
      { message: { role: 'assistant', content: expect.stringMatching(/^書きか\n\n\[OrangeAgent: the administrator stopped/u) }, files: [] },
    ]);
  });

  it('replays a message handed to an answer after the words written before it, with the files each message was sent with', () => {
    let projection = fresh();
    const fold = (changes: readonly Change[]) => {
      for (const change of changes) projection = foldEvent(projection, itemEvent(change.item, AT));
    };
    const photo = { id: 'photo-1', filename: 'photo.jpg', mediaType: 'image/jpeg', size: 10 };
    const first = startTurn({ projection, runId: 'run-1', request: 'この写真の予定を', model: 'm', at: AT, files: [photo] });
    projection = foldEvent(foldEvent(projection, itemEvent(first.user, AT)), runEvent('run.created', first.run, AT));
    fold(onTurnEvent(first.turn, { type: 'text', text: '確認します。' }, AT));
    fold(steerItem(first.turn, { id: 'steer-1', sent: { text: '午後だけ', files: [] }, intent: 'steer', at: AT }));
    expect(unreadSteers(projection, 'run-1').map((item) => item.text)).toEqual(['午後だけ']);
    // Read: the words before it end, so what the model writes next follows it.
    const read = readSteers(first.turn, unreadSteers(projection, 'run-1'), AT);
    expect(read.map((change) => [change.item.type, change.item.status])).toEqual([['assistant_message', 'completed'], ['user_message', 'completed']]);
    roundTrips(read);
    fold(read);
    fold(onTurnEvent(first.turn, { type: 'text', text: '午後は1件です。' }, AT));
    const ended = finishTurn(first.turn, { kind: 'completed' }, AT);
    fold(ended.changes);
    projection = foldEvent(projection, runEvent('run.updated', ended.run, AT));

    expect(unreadSteers(projection, 'run-1')).toEqual([]);
    expect(historyOf(projection)).toEqual([
      { message: { role: 'user', content: 'この写真の予定を' }, files: ['photo-1'] },
      { message: { role: 'assistant', content: '確認します。' }, files: [] },
      { message: { role: 'user', content: '午後だけ' }, files: [] },
      { message: { role: 'assistant', content: '午後は1件です。' }, files: [] },
    ]);
    expect(first.user).toMatchObject({ attachments: [{ type: 'image', id: 'photo-1', name: 'photo.jpg', mimeType: 'image/jpeg' }] });
  });

  it('queues a message as a Run of its own whose message stays hidden until it starts, and keeps every record decodable', () => {
    let projection = fresh();
    const queued = queueMessage({ projection, runId: 'run-q', model: 'm', sent: { text: '後で', files: [] }, position: 1, at: AT });
    const events = [itemEvent(queued.user, AT), messageEvent(queued.message, AT), runEvent('run.created', queued.run, AT)];
    for (const event of events) {
      expect(decodeEvent(encodeEvent(event))).toMatchObject({ type: event.type });
      projection = foldEvent(projection, event);
    }
    expect(projection.runs).toEqual([expect.objectContaining({ id: 'run-q', status: 'queued', queuePosition: 1 })]);
    expect(projection.visibleTurnItems).toEqual([]);

    const begun = startTurn({ projection, runId: 'run-q', request: '後で', model: 'm', at: AT, intent: 'queued_turn', itemId: queued.user.id });
    projection = foldEvent(foldEvent(projection, itemEvent(begun.user, AT)), runEvent('run.updated', begun.run, AT));
    expect(projection.visibleTurnItems.map((row) => [row.item.id, row.item.status])).toEqual([[queued.user.id, 'completed']]);
    expect(projection.runs).toEqual([expect.objectContaining({ id: 'run-q', status: 'running', ordinal: 2 })]);
  });
});

describe('what an answer cost', () => {
  const REQUEST = { promptTokens: 1_000, cachedTokens: 800, completionTokens: 50 };

  it('sums every request\'s cost, and is a bill only while every request was billed', () => {
    const { turn } = started();

    expect(recordUsage(turn, { ...REQUEST, costUsd: 0.002, costBilled: true }).usage).toMatchObject({ costUsd: 0.002, costBilled: true });
    const run = recordUsage(turn, { ...REQUEST, costUsd: 0.001, costBilled: false });

    expect(run.usage?.costUsd).toBeCloseTo(0.003);
    expect(run.usage?.costBilled).toBe(false);
  });

  it('records no cost while no request\'s cost is known', () => {
    const { turn } = started();

    const run = recordUsage(turn, REQUEST);

    expect(run.usage).toMatchObject({ requests: 1, inputTokens: 1_000 });
    expect(run.usage?.costUsd).toBeUndefined();
  });
});
