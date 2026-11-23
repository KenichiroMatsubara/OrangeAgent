/**
 * The files one Operator Chat answer holds, by name: those the member sent
 * with this message and the ones before it, and every file a tool handed the
 * answer — a picture browser.read took, a mail's attachment, a Drive file, a
 * page web.search read as a file, a file of a Skill. Any of them is handed on
 * to the member with file.hand, which keeps it beside the files Claude wrote,
 * so it is offered below the answer and can be saved to Drive or attached to
 * a mail like them.
 *
 * Without this, a file reached the member only when Claude copied it into its
 * sandbox's output directory, and a file a tool handed over never entered that
 * sandbox: the answer could look at a screenshot but never give it.
 *
 * A picture the run took itself, such as a screenshot, exists nowhere else, so
 * it is not left for the model to hand: it is shown to the member the moment
 * it is taken, as a thumbnail below the answer being written.
 */

import type { ChatGeneratedFile } from '@mail/domain';

import { FileAnswer, type CallContext, type GeneratedFile, type ToolHandlers, type TurnFile } from './turns';

export interface HeldFiles {
  /** The latest file held under this name, or null when none is. */
  find(filename: string): TurnFile | null;
  /** Every name held, the latest first. */
  names(): string[];
  /** The same handlers, each noting the files its answer hands over, whoever called it. */
  watch(handlers: ToolHandlers): ToolHandlers;
}

const baseName = (filename: string): string => filename.split('/').at(-1)?.trim() ?? '';

export const heldFiles = (initial: readonly TurnFile[], show?: (file: TurnFile) => Promise<unknown>): HeldFiles => {
  // A Map keeps the order names were last handed in, so a name handed again moves to the end.
  const byName = new Map<string, TurnFile>();
  const keep = (files: readonly TurnFile[]): void => {
    for (const file of files) {
      const name = baseName(file.filename);
      if (!name) continue;
      byName.delete(name);
      byName.set(name, file);
    }
  };
  keep(initial);
  return {
    find: (filename) => byName.get(baseName(filename)) ?? null,
    names: () => [...byName.keys()].reverse(),
    watch: (handlers) => Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (arguments_: Record<string, unknown>, context?: CallContext) => {
      const answer = await handler(arguments_, context);
      if (!(answer instanceof FileAnswer)) return answer;
      keep(answer.files);
      // A picture that could not be shown is still the tool's answer, and can still be handed.
      for (const file of answer.files) if (file.shown && show) await show(file).catch(() => undefined);
      return answer;
    }])),
  };
};

/** The name a handed file is kept under: the one asked for, keeping the file's own extension when it names none. */
export const handedName = (filename: string, name?: string): string => {
  const own = baseName(filename);
  const asked = name ? baseName(name) : '';
  if (!asked) return own;
  const dot = own.lastIndexOf('.');
  const extension = dot > 0 ? own.slice(dot) : '';
  return extension && !asked.toLowerCase().endsWith(extension.toLowerCase()) ? `${asked}${extension}` : asked;
};

/**
 * Hands the member one held file by name, kept by `keep` as a file of the
 * answer, or refuses naming what the answer holds.
 */
export const handFile = async (input: {
  held: HeldFiles;
  filename: string;
  name?: string;
  keep: (file: GeneratedFile) => Promise<readonly ChatGeneratedFile[]>;
}): Promise<unknown> => {
  const file = input.held.find(input.filename);
  if (!file) {
    const names = input.held.names();
    return {
      isError: true,
      message: names.length
        ? `${input.filename} is not a file you hold in this answer. You hold: ${names.join(', ')}. Name one exactly as it is written there; a file a tool did not hand you in this answer, such as a picture you have not taken yet, is taken again first.`
        : `You hold no file in this answer, so there is nothing to hand. Have a tool hand you the file first, such as mail.read or drive.read.`,
    };
  }
  const filename = handedName(file.filename, input.name);
  const [kept] = await input.keep({ filename, mediaType: file.mediaType || 'application/octet-stream', bytes: file.bytes });
  return {
    handed: { filename, mediaType: kept?.mediaType ?? file.mediaType, size: file.bytes.byteLength },
    note: 'It is offered to the member below your answer. Say what you handed; do not write a link to it.',
  };
};
