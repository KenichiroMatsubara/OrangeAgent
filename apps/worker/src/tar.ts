/**
 * A tar archive of files, written as POSIX pax, which GNU tar and Python's
 * tarfile both unpack. A name longer than a ustar header holds, or one that
 * is not plain ASCII, is carried whole in a pax header before its file.
 */

const BLOCK = 512;
const encoder = new TextEncoder();

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0');

const header = (name: string, size: number, type: '0' | 'x'): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string): void => { block.set(encoder.encode(text), offset); };
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, '        ');
  put(156, type);
  put(257, 'ustar\u0000');
  put(263, '00');
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${octal(sum, 7)}\u0000 `);
  return block;
};

/** A pax record, `<length> path=<name>\n`, whose length counts its own digits. */
const paxPath = (name: string): Uint8Array => {
  const rest = encoder.encode(` path=${name}\n`).byteLength;
  let length = rest + 1;
  while (String(length).length + rest !== length) length = String(length).length + rest;
  return encoder.encode(`${length} path=${name}\n`);
};

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** Whether a ustar header holds this name as it is. */
const plain = (name: string): boolean => /^[\x20-\x7E]{1,99}$/u.test(name);

/** Writes the entries into one archive, each under its name, in order. */
export const tar = (entries: readonly TarEntry[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  entries.forEach((entry, index) => {
    if (!plain(entry.name)) {
      const record = paxPath(entry.name);
      parts.push(header(`PaxHeaders/${index}`, record.byteLength, 'x'), record, padding(record.byteLength));
    }
    const fallback = plain(entry.name) ? entry.name : `file-${index}`;
    parts.push(header(fallback, entry.bytes.byteLength, '0'), entry.bytes, padding(entry.bytes.byteLength));
  });
  parts.push(new Uint8Array(BLOCK * 2));
  const archive = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
};
