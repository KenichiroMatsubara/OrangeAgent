/**
 * What Operator Chat keeps outside its conversations (`threads.ts`): how a
 * file a member sends is recognised, how a file the chat before ADR 0201
 * kept as an encrypted envelope is opened, the Account's MCP Servers, and
 * the notes an earlier answer is replayed with.
 */

import { asc, eq } from 'drizzle-orm';

import {
  chatContentType,
  isChatAttachmentType,
  unreadableChatAttachmentText,
  unsupportedChatAttachmentText,
  type ChatAttachmentType,
  type ChatGeneratedFile,
} from '@mail/domain';

import { invalid } from './refusal';
import { decrypt, encrypt } from './cryptography';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { mcpServers } from './storage/account-schema';
import type { McpFetch } from './mcp';
import { mcpAccessToken } from './mcp-oauth';
import type { McpServerSource, TurnFile } from './turns';

const mcpTokenContext = (accountId: string, serverId: string): string => `mcp-server-token:${accountId}:${serverId}`;

/** An accepted attachment before it is stored: what it is, and its bytes. */
export interface ChatUpload extends TurnFile {
  mediaType: ChatAttachmentType;
  size: number;
}

const attachmentContext = (accountId: string, attachmentId: string): string => `chat-attachment:${accountId}:${attachmentId}`;
/** An envelope is sealed for the Account and the attachment its key names, `chat-attachments/<account>/<attachment>.json`. */
const ENVELOPE_KEY = /^chat-attachments\/([^/]+)\/([^/]+)\.json$/u;

/**
 * What an object the chat before ADR 0201 kept as an encrypted envelope was
 * sealed for, read from its key, or null for an object kept as it is. A
 * conversation copied from that chat (migration 0061) names such an object
 * under a file id of its own, so the key, not the row, says what opens it.
 */
export const envelopeContext = (objectKey: string): string | null => {
  const match = ENVELOPE_KEY.exec(objectKey);
  return match?.[1] && match[2] ? attachmentContext(match[1], match[2]) : null;
};

/** The file an envelope holds, kept as base64 text before files were stored as they are. */
export const openEnvelope = async (text: string, key: CryptoKey, context: string): Promise<Uint8Array> => {
  const kept = await decrypt(JSON.parse(text), key, context);
  return Uint8Array.from(atob(kept), (character) => character.charCodeAt(0));
};

/** A Word or Excel file is a ZIP archive. */
const isZip = (bytes: Uint8Array): boolean => [0x50, 0x4b, 0x03, 0x04].every((byte, index) => bytes[index] === byte);

/** A text file is whole UTF-8; anything else under a text type is not handed over as text. */
const isText = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** How each accepted kind of file is recognised, so a renamed file is never handed over as something it is not. */
const SIGNATURES: Record<ChatAttachmentType, (bytes: Uint8Array) => boolean> = {
  'image/png': (bytes) => chatContentType(bytes) === 'image/png',
  'image/jpeg': (bytes) => chatContentType(bytes) === 'image/jpeg',
  'image/gif': (bytes) => chatContentType(bytes) === 'image/gif',
  'image/webp': (bytes) => chatContentType(bytes) === 'image/webp',
  'application/pdf': (bytes) => chatContentType(bytes) === 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'text/csv': isText,
  'text/plain': isText,
};

/**
 * The kind a file is handed over as: the one its type names when its bytes
 * are that, and otherwise the image or PDF its bytes are, since a phone often
 * saves a PNG or WebP under a `.jpg` name or sends a photo with no type at all.
 * A file is refused only when its bytes are no kind accepted.
 */
const kindOf = (filename: string, declared: string, bytes: Uint8Array): ChatAttachmentType => {
  if (isChatAttachmentType(declared) && SIGNATURES[declared](bytes)) return declared;
  const content = chatContentType(bytes);
  if (content) return content;
  throw invalid(isChatAttachmentType(declared) ? unreadableChatAttachmentText(filename, declared) : unsupportedChatAttachmentText(filename));
};

/**
 * Reads the files one message carries, however many and however large, and
 * refuses the message when one of them is no accepted kind. Each is a file
 * part of the form, and is handed over as what its bytes are rather than what
 * its name or type says.
 */
export const readChatUploads = async (attachments: readonly File[]): Promise<ChatUpload[]> => {
  const parts = attachments.map((file) => {
    const filename = file.name.trim();
    if (!filename || !file.size) throw invalid('添付ファイルを読み取れませんでした。');
    return { file, filename, size: file.size };
  });
  return Promise.all(parts.map(async ({ file, filename, size }) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { filename, mediaType: kindOf(filename, file.type, bytes), size, bytes };
  }));
};

/**
 * The Account's MCP Servers with what each is called with: the access token of
 * the OAuth grant it was signed in to, renewed when it is about to expire, or
 * else its static token. A grant that cannot be used leaves the server without
 * a token, so the server itself answers that it needs a sign-in.
 */
export const listChatServers = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  fetch: McpFetch;
}): Promise<McpServerSource[]> => {
  const rows = await drizzleAccountDatabase(input.database).select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
  const tokenOf = async (row: typeof rows[number]): Promise<string | null> => {
    if (row.oauthEnvelope) {
      return mcpAccessToken({ database: input.database, fetch: input.fetch, key: input.accountKey, accountId: input.accountId, serverId: row.id, envelope: row.oauthEnvelope });
    }
    return row.tokenEnvelope ? decrypt(JSON.parse(row.tokenEnvelope), input.accountKey, mcpTokenContext(input.accountId, row.id)) : null;
  };
  return Promise.all(rows.map(async (row) => {
    const token = await tokenOf(row);
    return {
      id: row.id,
      name: row.name,
      connection: {
        url: row.url,
        ...(token ? { token } : {}),
        ...(row.revision ? { revision: row.revision } : {}),
      },
    };
  }));
};

export const saveChatServer = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  id: string;
  name: string;
  url: string;
  token: string | null;
  revision: '2026-07-28' | '2025-06-18' | null;
  timestamp: string;
}): Promise<void> => {
  const envelope = input.token
    ? JSON.stringify(await encrypt(input.token, input.accountKey, mcpTokenContext(input.accountId, input.id)))
    : null;
  await drizzleAccountDatabase(input.database).insert(mcpServers).values({
    id: input.id,
    accountId: input.accountId,
    name: input.name,
    url: input.url,
    tokenEnvelope: envelope,
    revision: input.revision,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }).onConflictDoUpdate({
    target: mcpServers.id,
    set: { name: input.name, url: input.url, tokenEnvelope: envelope, revision: input.revision, updatedAt: input.timestamp },
  }).run();
};

export const deleteChatServer = async (input: { database: D1Database; id: string }): Promise<void> => {
  await drizzleAccountDatabase(input.database).delete(mcpServers).where(eq(mcpServers.id, input.id)).run();
};

/** What OrangeAgent adds to an answer it replays that the administrator stopped, so Claude knows it was left unfinished. */
export const STOPPED_NOTE = '\n\n[OrangeAgent: the administrator stopped this answer before it was finished.]';

/**
 * The note OrangeAgent adds to an answer it replays, naming the files Claude
 * wrote for it. Only the answer's words are replayed, never the code that
 * wrote a file, so without the note Claude reads its own "I made it" with no
 * sign that it did, and takes the answer back.
 */
export const writtenNote = (files: readonly Pick<ChatGeneratedFile, 'filename' | 'size' | 'drive'>[]): string => files.length
  ? `\n\n[OrangeAgent: this answer wrote ${files.map((file) => `${file.filename} (${file.size} bytes${file.drive ? `, saved to Google Drive at ${file.drive.url}` : ''})`).join(', ')}, offered to the administrator for download below it.]`
  : '';
