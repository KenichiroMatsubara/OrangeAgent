import type { Memory, MemoryDetail, MemoryList, MemorySearch } from '@mail/domain';

import { searchMemoryRows } from '../memory/answer';
import { eraseMemory, listMemories, memoryDetail, memoryStoreOf, saveMemory, updateMemory, type MemoryStore } from '../memory/store';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { accountRoute, created, type AccountRequest, type Created } from './account';

/**
 * The 記憶 screen: every memory, whoever wrote it, for a member to read,
 * search the way an AI's memory.search does, trace to the words it rests
 * on, correct, and erase.
 */
export const memoryRoutes = resource();

const storeOf = (request: AccountRequest<unknown>): MemoryStore => memoryStoreOf(request.env, request.db, request.accountId);

/** The member on the screen, by name, else by Google account. */
const memberOf = (request: AccountRequest<unknown>): string => request.session.display_name.trim() || request.session.email;

/** The words a request sends, trimmed, or a refusal that says what is wrong with them. */
const contentOf = (body: { content?: unknown }): string => {
  if (typeof body.content !== 'string' || !body.content.trim()) throw invalid('覚えることを入力してください。');
  return body.content.trim();
};

const missing = (): Error => notFound('この記憶は見つかりません。すでに削除されたかもしれません。');

memoryRoutes.get('/organizations/:accountId/memories', accountRoute(async (request): Promise<MemoryList> => {
  return { memories: await listMemories(storeOf(request)) };
}));

/** The same search an AI's memory.search makes. The words searched for are sent in the body, not the address. */
memoryRoutes.post('/organizations/:accountId/memories/search', accountRoute<{ query?: unknown }>(async (request): Promise<MemorySearch> => {
  const query = typeof request.body.query === 'string' ? request.body.query.trim() : '';
  if (!query) throw invalid('探すことを入力してください。');
  return searchMemoryRows(storeOf(request), query);
}));

/** Why the Account remembers it: the words it rests on, as they were said, and every change since. */
memoryRoutes.get('/organizations/:accountId/memories/:memoryId', accountRoute(async (request): Promise<MemoryDetail> => {
  const detail = await memoryDetail(storeOf(request), request.params.memoryId ?? '');
  if (!detail) throw missing();
  return detail;
}));

/** Words already kept are not kept twice: the memory that holds them is answered, unchanged. */
memoryRoutes.post('/organizations/:accountId/memories', accountRoute<{ content?: unknown }>(async (request): Promise<Created<Memory>> => {
  const content = contentOf(request.body);
  return created((await saveMemory(storeOf(request), { content, author: { kind: 'person', name: memberOf(request) } })).memory);
}));

memoryRoutes.put('/organizations/:accountId/memories/:memoryId', accountRoute<{ content?: unknown }>(async (request): Promise<Memory> => {
  const content = contentOf(request.body);
  const memory = await updateMemory(storeOf(request), { id: request.params.memoryId ?? '', content, editor: memberOf(request) });
  if (!memory) throw missing();
  return memory;
}));

memoryRoutes.delete('/organizations/:accountId/memories/:memoryId', accountRoute(async (request) => {
  const id = request.params.memoryId ?? '';
  if (!await eraseMemory(storeOf(request), { id, actor: memberOf(request) })) throw missing();
  return { id, removed: true };
}));
