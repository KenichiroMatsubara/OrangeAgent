/** A published Source Attachment as it should appear inside a Google Calendar description. */
export interface AttachmentLink {
  filename: string;
  url: string;
}

export interface CalendarDescriptionInput {
  /** The Event Summary for this single Scheduled Event; omitted from the description when blank. */
  summary: string;
  /**
   * The Guest Registration counts by Affiliation, omitted when nobody from
   * outside has registered. It carries counts and never names, and it is passed
   * as plain text so the Affiliations another account wrote are escaped
   * here rather than by the caller that assembled them.
   */
  guestCounts?: string;
  attachments: AttachmentLink[];
  /** The trusted provenance sentence appended last. */
  attribution: string;
}

const escaped = (text: string): string => text
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const paragraph = (text: string): string => escaped(text.trim()).replaceAll('\n', '<br>');

const OPENING = '「『（(【〔［[';
const CLOSING = '」』）)】〕］]';
const SENTENCE_END = '。！？';

/**
 * Starts each sentence of an Event Summary on its own line, so a summary written as one run of
 * sentences reads as a list on a phone. A sentence end inside brackets, such as 「…。」, stays put.
 */
const summaryLines = (text: string): string => {
  const characters = [...text.trim()];
  let depth = 0;
  let lines = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (OPENING.includes(character)) depth += 1;
    if (CLOSING.includes(character)) depth = Math.max(0, depth - 1);
    lines += character;
    if (depth > 0 || !SENTENCE_END.includes(character)) continue;
    let next = index + 1;
    while (/[^\S\n]/u.test(characters[next] ?? '')) next += 1;
    const following = characters[next];
    if (following === undefined || following === '\n' || SENTENCE_END.includes(following)) continue;
    lines += '\n';
    index = next - 1;
  }
  return lines.split('\n').map((line) => line.trim()).join('\n');
};

/** Only an absolute http(s) URL may become a link; anything else stays inert escaped text. */
const linkableUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

/** Renders one attachment as a labelled link, the Calendar equivalent of Markdown's [filename](url). */
export const attachmentLink = (attachment: AttachmentLink): string => {
  const url = linkableUrl(attachment.url);
  const label = escaped(attachment.filename.trim() || attachment.url.trim());
  return url ? `<a href="${escaped(url)}">${label}</a>` : label;
};

/**
 * Builds the Google Calendar description. Google Calendar renders a small HTML subset, so a
 * published Source Attachment shows its filename instead of a long unreadable Drive URL.
 */
export const calendarEventDescription = (input: CalendarDescriptionInput): string => {
  const blocks: string[] = [];
  if (input.summary.trim()) blocks.push(paragraph(summaryLines(input.summary)));
  if (input.guestCounts?.trim()) blocks.push(paragraph(input.guestCounts));
  if (input.attachments.length) {
    blocks.push(['添付ファイル:', ...input.attachments.map(attachmentLink)].join('<br>'));
  }
  if (input.attribution.trim()) blocks.push(paragraph(input.attribution));
  return blocks.join('<br><br>');
};
