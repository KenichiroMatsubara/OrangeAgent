/**
 * File names the Files API and a file system accept.
 *
 * The Files API refuses a name with a path separator, a reserved character
 * (`< > : " | ? * \ /`), or a control character, and one longer than 255
 * bytes; a mail attachment's or a Drive file's name may hold any of them.
 */

export const MAX_FILE_NAME_BYTES = 255;

const encoder = new TextEncoder();

/** A part of a file name the Files API and a file system accept: no separator, no reserved character, no control character, no leading dot. */
export const safeName = (value: string): string =>
  value.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/gu, '-').replace(/^[.\s-]+|[\s.]+$/gu, '').trim();

const byteLength = (value: string): number => encoder.encode(value).byteLength;

/** Cuts a name to at most `limit` bytes without splitting a character, keeping its extension whole. */
export const cutName = (name: string, limit: number): string => {
  if (byteLength(name) <= limit) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && byteLength(name.slice(dot)) <= 16 ? name.slice(dot) : '';
  let stem = [...(extension ? name.slice(0, dot) : name)];
  while (stem.length && byteLength(stem.join('')) + byteLength(extension) > limit) stem = stem.slice(0, -1);
  return `${stem.join('')}${extension}`;
};

/** The name a file is uploaded to the Files API under, and so the name it has in the sandbox. */
export const uploadName = (filename: string): string => cutName(safeName(filename), MAX_FILE_NAME_BYTES) || 'file';
