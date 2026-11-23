import { describe, expect, it } from 'vitest';

import { tar } from './tar';

const text = (bytes: Uint8Array, from: number, length: number): string => new TextDecoder().decode(bytes.slice(from, from + length)).replace(/\u0000.*$/su, '');

describe('tar', () => {
  it('writes each file after a ustar header whose checksum holds, padded to whole blocks, ending in two empty blocks', () => {
    const archive = tar([{ name: 'a.txt', bytes: new TextEncoder().encode('hello') }]);

    expect(archive.byteLength).toBe(512 * 4);
    expect(text(archive, 0, 100)).toBe('a.txt');
    expect(Number.parseInt(text(archive, 124, 12), 8)).toBe(5);
    expect(text(archive, 257, 6)).toBe('ustar');
    const header = archive.slice(0, 512);
    header.fill(0x20, 148, 156);
    expect(Number.parseInt(text(archive, 148, 7), 8)).toBe(header.reduce((total, byte) => total + byte, 0));
    expect(text(archive, 512, 5)).toBe('hello');
  });

  it('carries a name a ustar header cannot hold in a pax record whose length counts itself', () => {
    const name = `${'案内'.repeat(40)}.md`;
    const archive = tar([{ name, bytes: new Uint8Array(1) }]);

    expect(text(archive, 156, 1)).toBe('x');
    const size = Number.parseInt(text(archive, 124, 12), 8);
    const record = text(archive, 512, size);
    expect(record).toBe(`${size} path=${name}\n`);
    expect(new TextEncoder().encode(record).byteLength).toBe(size);
    expect(text(archive, 1024 + 156, 1)).toBe('0');
  });
});
