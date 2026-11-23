import { describe, expect, it } from 'vitest';

import { LOOKABLE_IMAGE_BYTES } from '@mail/domain';

import { prepareFile, prepareFiles } from './photos';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

/** A file of `size` bytes beginning with `head`. */
const fileOf = (name: string, type: string, head: readonly number[], size = head.length): File => {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return new File([bytes], name, { type });
};

const jpeg = async (): Promise<Blob> => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });

describe('photos as a message sends them', () => {
  it('sends a picture a model looks at, and any other file, as it is', async () => {
    const photo = fileOf('写真.png', 'image/png', PNG);
    const memo = new File(['19:00'], 'memo.txt', { type: 'text/plain' });

    expect(await prepareFiles([photo, memo], jpeg)).toEqual([photo, memo]);
  });

  it('re-encodes a picture larger than Claude looks at, and one of a kind no model reads, as a JPEG named as it was', async () => {
    const large = fileOf('大きい.png', 'image/png', PNG, LOOKABLE_IMAGE_BYTES + 1);
    // A phone's HEIC photo under a JPEG name: no image the domain recognises by its bytes.
    const heic = fileOf('IMG_0001.jpg', 'image/jpeg', [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

    const [shrunk, converted] = await prepareFiles([large, heic], jpeg);

    expect([shrunk?.name, shrunk?.type]).toEqual(['大きい.jpg', 'image/jpeg']);
    expect([converted?.name, converted?.type]).toEqual(['IMG_0001.jpg', 'image/jpeg']);
  });

  it('sends a picture as it is where the browser cannot re-encode it', async () => {
    const large = fileOf('大きい.png', 'image/png', PNG, LOOKABLE_IMAGE_BYTES + 1);

    expect(await prepareFile(large, async () => null)).toBe(large);
  });
});
