// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFile = (path: string): Promise<Buffer> => readFile(`${root}public${path}`);

/** A PNG's width and height, read from its IHDR chunk. */
const pngSize = (bytes: Buffer): string => `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;

interface ManifestIcon { src: string; sizes: string; type: string; purpose: string }

describe('the icon', () => {
  it('is every icon the page links, and each of them is there', async () => {
    const html = await readFile(`${root}index.html`, 'utf8');
    const linked = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/gu)].map((match) => match[1] ?? '');

    expect(linked).toEqual(['/favicon.ico', '/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest']);
    for (const path of linked) await expect(publicFile(path)).resolves.toBeInstanceOf(Buffer);
    expect(pngSize(await publicFile('/apple-touch-icon.png'))).toBe('180x180');
  });

  it('is what the web app manifest installs, at the size each entry states', async () => {
    const manifest = JSON.parse((await publicFile('/manifest.webmanifest')).toString('utf8')) as { icons: ManifestIcon[]; theme_color: string };
    const html = await readFile(`${root}index.html`, 'utf8');

    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(['any', 'any', 'any', 'maskable', 'maskable']);
    for (const icon of manifest.icons) {
      const bytes = await publicFile(icon.src);
      if (icon.type === 'image/png') expect(pngSize(bytes)).toBe(icon.sizes);
    }
  });

  it('holds 16, 32, and 48 pixel images in favicon.ico', async () => {
    const ico = await publicFile('/favicon.ico');
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => ico.readUInt8(6 + index * 16));

    expect(sizes).toEqual([16, 32, 48]);
  });
});
