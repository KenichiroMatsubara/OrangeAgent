import type { ChatDelivery } from './views';

/**
 * What Operator Chat accepts as an attachment. Each file is handed to the model
 * as it is, never as text made from it: images and PDFs to look at, and Word,
 * Excel, CSV, and plain text files, which Claude opens with code in its sandbox.
 */
export const CHAT_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
] as const;

export type ChatAttachmentType = typeof CHAT_ATTACHMENT_TYPES[number];

/** The longest title a conversation keeps, whether taken from its first message or given when it is renamed. */
export const CONVERSATION_TITLE_LENGTH = 80;

/**
 * Anthropic looks at an image of at most 5 MB once base64-encoded, which is
 * 3.75 MiB of file; a larger one is opened with code in its sandbox instead.
 */
export const LOOKABLE_IMAGE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);

export const isChatAttachmentType = (value: string): value is ChatAttachmentType =>
  (CHAT_ATTACHMENT_TYPES as readonly string[]).includes(value);

const isChatImageType = (type: string): boolean => type.startsWith('image/');

/** The sentence both the Worker and the screen give for a file of a kind that is not attached. */
export const unsupportedChatAttachmentText = (filename: string): string =>
  `${filename} は添付できません。添付できるのは画像（PNG・JPEG・GIF・WebP）、PDF、Word、Excel、CSV、テキストファイルです。`;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean =>
  prefix.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * The image or PDF a file's first bytes say it is, whatever its name or the
 * type the browser gave it, or null when they say neither. A phone often saves
 * a PNG, WebP, or HEIC photo under a `.jpg` name, so a file is taken as what
 * it holds rather than refused for what it is called. Twelve bytes are enough.
 */
export const chatContentType = (bytes: Uint8Array): ChatAttachmentType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF8'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return null;
};

const READ_AS: Readonly<Record<ChatAttachmentType, string>> = {
  'image/png': '画像',
  'image/jpeg': '画像',
  'image/gif': '画像',
  'image/webp': '画像',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word 文書',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel ブック',
  'text/csv': 'CSV（UTF-8）',
  'text/plain': 'テキスト（UTF-8）',
};

/** The sentence given for a file whose contents are not the kind it is named as, and are no other kind accepted. */
export const unreadableChatAttachmentText = (filename: string, mediaType: ChatAttachmentType): string =>
  isChatImageType(mediaType)
    ? `${filename} を画像として読み取れませんでした。PNG・JPEG・GIF・WebP で保存し直して添付してください。`
    : `${filename} を${READ_AS[mediaType]}として読み取れませんでした。`;

/** Whether a form's `delivery` names how a message reaches the answer being written. */
export const isChatDelivery = (value: unknown): value is ChatDelivery => value === 'steer' || value === 'queue';

/**
 * The fields of the form a message to a conversation of Operator Chat is sent as; each file is a part named `attachment`.
 * A message rewritten in place of an earlier one also names that message (`messageId`) and each file it was sent with that it leaves out (`drop`, one part each).
 */
export const CHAT_THREAD_FORM = {
  text: 'text',
  attachment: 'attachment',
  delivery: 'delivery',
  model: 'model',
  effort: 'effort',
  messageId: 'messageId',
  drop: 'drop',
} as const;

/** The code a conversation's socket is closed with once the conversation is deleted, after which no screen opens it again. */
export const CHAT_THREAD_GONE = 4404;

/** What a stopped answer is recorded with, beside the words it had written. */
export const CHAT_STOPPED_NOTE = '回答を途中で停止しました。';

/** The media types a file Claude writes is kept under, read from its extension. */
const GENERATED_FILE_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
};

/**
 * The type a file Claude wrote is kept as, read from its extension. Every file
 * it writes is kept, whatever its kind; one of a kind not named here is kept as
 * plain bytes.
 */
export const chatGeneratedFileType = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return GENERATED_FILE_TYPES[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
};

/**
 * The kinds of file the browser is shown rather than handed for download: the
 * images and PDFs it renders without running anything in them. Every other
 * file, such as an HTML page or an SVG image, which could run script on
 * FlareChat's origin, is downloaded.
 */
const SHOWN_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

export const isChatShownType = (mediaType: string): boolean => SHOWN_TYPES.includes(mediaType);
