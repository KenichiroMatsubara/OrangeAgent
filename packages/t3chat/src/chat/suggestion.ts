/**
 * The suggestion each conversation's composer offers: what the person is likely to write next after
 * its latest answer, read from the server once that answer completes (ADR 0201 keeps the chat's
 * server FlareChat's own, so t3code's `promptSuggestion` subscription has no server to answer it).
 * t3code's `usePromptSuggestion` reads it from here and offers it only while the answer it follows
 * is the conversation's latest completed one.
 */
import type { RunId } from '@t3tools/contracts';

/** A suggestion and the answer it follows. */
export interface OfferedSuggestion {
  readonly runId: RunId;
  readonly text: string;
}

let suggestions: ReadonlyMap<string, OfferedSuggestion> = new Map();
const listeners = new Set<() => void>();

/** Calls `listener` whenever any conversation's suggestion changes; returns the function that stops it. */
export const subscribeSuggestions = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Every conversation's suggestion, by conversation; a new map whenever one changes. */
export const readSuggestions = (): ReadonlyMap<string, OfferedSuggestion> => suggestions;

/** Keeps the suggestion for a conversation, or forgets it given null. */
export const offerSuggestion = (threadId: string, suggestion: OfferedSuggestion | null): void => {
  const current = suggestions.get(threadId);
  if (current?.runId === suggestion?.runId && current?.text === suggestion?.text) return;
  const next = new Map(suggestions);
  if (suggestion === null) next.delete(threadId);
  else next.set(threadId, suggestion);
  suggestions = next;
  for (const listener of listeners) listener();
};

/** Forgets every suggestion, as a page loaded afresh holds none; a test starts each conversation anew with it. */
export const forgetSuggestions = (): void => {
  if (suggestions.size === 0) return;
  suggestions = new Map();
  for (const listener of listeners) listener();
};
