/**
 * What `memory.search` and `memory.add` answer an AI, and what the 記憶
 * screen's search returns. An AI is told, for each memory, when and from
 * whom it was kept and how it matched, and is told plainly when the Memory
 * holds nothing certain, so it does not guess.
 */

import type { MemorySearch } from '@mail/domain';

import { findMemories, type MemoryFound } from './search';
import { saveMemory, viewOf, type MemoryAuthor, type MemoryRow, type MemoryStore } from './store';

/** At most this many characters of memories are answered; the rest are left out, and the answer says so. */
const ANSWER_LIMIT = 4000;

const NOTHING_CERTAIN = 'No certain memory about this. Do not answer from a guess: say the Memory does not hold it, or ask.';

const tokyo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** An instant as Asia/Tokyo wall-clock time, `YYYY-MM-DD HH:MM`. */
const tokyoTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : tokyo.format(date);
};

const sourceOf = (row: MemoryRow): string => {
  if (row.authorKind === 'person') return `${row.authorName || 'a member'} wrote it on 記憶`;
  if (row.authorKind === 'cli') return `the CLI of ${row.authorName || 'a member'} kept it`;
  return 'Operator Chat’s AI kept it';
};

const matchOf = ({ similarity, keywords }: MemoryFound): string =>
  [similarity !== null ? `meaning ${similarity.toFixed(2)}` : '', keywords !== null ? `words ${keywords.toFixed(2)}` : ''].filter(Boolean).join(', ');

const entryOf = (found: MemoryFound, position: number): string => {
  const { row } = found;
  const edited = row.editedBy ? `; corrected by ${row.editedBy} ${tokyoTime(row.updatedAt)}` : '';
  return `${position}. ${row.content}\n   kept ${tokyoTime(row.createdAt)} (Asia/Tokyo); ${sourceOf(row)}${edited}; matched by ${matchOf(found)}; id ${row.id}`;
};

/** The memories found, best first, as an AI reads them, or that nothing certain was found. */
export const answerOf = (found: readonly MemoryFound[]): string => {
  if (!found.length) return NOTHING_CERTAIN;
  const entries: string[] = [];
  let length = 0;
  for (const [index, item] of found.entries()) {
    const entry = entryOf(item, index + 1);
    if (entries.length && length + entry.length > ANSWER_LIMIT) break;
    entries.push(entry);
    length += entry.length;
  }
  const left = found.length - entries.length;
  return [`Certain memories: ${entries.length}`, ...entries, ...(left ? [`(${left} more left out for length; ask more narrowly to see them.)`] : [])].join('\n');
};

/** `memory.search`. */
export const searchMemory = async (store: MemoryStore, query: string): Promise<string> => {
  try {
    return answerOf(await findMemories(store, { query }));
  } catch (error) {
    return `The Memory could not be searched: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/** `memory.add`. */
export const addMemory = async (store: MemoryStore, content: string, author: MemoryAuthor): Promise<string> => {
  try {
    const { memory, duplicate } = await saveMemory(store, { content, author });
    return duplicate ? `Already kept, so not kept again: ${memory.content} (id ${memory.id})` : `Kept: ${memory.content} (id ${memory.id})`;
  } catch (error) {
    return `The memory could not be kept: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/** What the 記憶 screen's search found: the same search an AI makes, each with the memory it is on the screen as. */
export const searchMemoryRows = async (store: MemoryStore, query: string): Promise<MemorySearch> => {
  const found = await findMemories(store, { query });
  return { query, hits: found.map(({ row, similarity, keywords }) => ({ memory: viewOf(row), similarity, keywords })) };
};
