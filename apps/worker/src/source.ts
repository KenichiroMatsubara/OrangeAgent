/**
 * A mail as Gmail hands it over: its text, its attachments, and its headers.
 * Everything here reads; nothing writes to a provider.
 */

import { fromBase64Url } from './encoding';
import type { GmailPart, SourceAttachment } from './providers';

const mimeTypeOf = (part: GmailPart): string => (part.mimeType ?? '').toLowerCase();

const decodedPartText = (part: GmailPart): string => {
  if (!part.body?.data) return '';
  const text = new TextDecoder().decode(fromBase64Url(part.body.data));
  return mimeTypeOf(part).startsWith('text/html') ? text.replace(/<[^>]*>/gu, ' ') : text;
};

/**
 * Picks one representation of a multipart/alternative body. Both representations
 * carry the same text, so decoding both would send every sentence to the AI twice.
 */
const preferredAlternative = (parts: GmailPart[]): GmailPart[] => {
  const plain = parts.find((part) => mimeTypeOf(part).startsWith('text/plain'));
  if (plain) return [plain];
  const html = parts.find((part) => mimeTypeOf(part).startsWith('text/html'));
  if (html) return [html];
  return parts.slice(-1);
};

const bodyTextParts = (part: GmailPart): string[] => {
  const children = part.parts ?? [];
  const selected = mimeTypeOf(part) === 'multipart/alternative' ? preferredAlternative(children) : children;
  return [decodedPartText(part), ...selected.flatMap(bodyTextParts)];
};

/** Reads the Source Message body once, whichever representations Gmail supplies. */
export const decodedBody = (part: GmailPart | undefined): string => {
  if (!part) return '';
  return bodyTextParts(part).join('\n').replace(/\s+/gu, ' ').trim();
};

/**
 * States when the Source Message arrived, in the time zone this product schedules
 * in, so the AI can resolve a date that omits its year. Gmail reports epoch
 * milliseconds; an absent or unparseable value yields no fact at all rather than a
 * guessed one.
 */
export const receivedAtOf = (internalDate: string | undefined): string | undefined => {
  if (!internalDate || !/^\d+$/u.test(internalDate)) return undefined;
  const received = new Date(Number(internalDate) + 9 * 60 * 60 * 1_000);
  if (!Number.isFinite(received.getTime())) return undefined;
  return `${received.toISOString().slice(0, 19)}+09:00`;
};

/** Lists only Gmail file parts that can be copied safely after intake validation. */
export const sourceAttachments = (part: GmailPart | undefined): SourceAttachment[] => {
  if (!part) return [];
  const own = part.filename && part.body?.attachmentId
    ? [{ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 }]
    : [];
  return [...own, ...(part.parts?.flatMap(sourceAttachments) ?? [])];
};

export const subjectOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'subject')?.value?.trim() ?? '(件名なし)';

export const senderOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value?.trim() ?? '';
