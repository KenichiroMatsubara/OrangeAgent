/**
 * Photos as a message of Operator Chat sends them, as the chat before ADR
 * 0201 sent them: a picture larger than Claude looks at, or of a kind no model
 * reads (HEIC, TIFF, BMP, which a phone often saves under a `.jpg` name), is
 * re-encoded in the browser as a JPEG on white whose longest edge is at most
 * 2,048 pixels. Anything else, and a picture the browser cannot re-encode, is
 * sent as it is, and the Worker says why a file it cannot take is refused.
 */

import { chatContentType, LOOKABLE_IMAGE_BYTES } from '@mail/domain';

/** The longest edge a shrunk photo keeps; models see little more than this. */
export const SHRUNK_EDGE = 2048;

/** Re-encodes a picture as a JPEG, or gives up where the browser cannot. */
export type Encoder = (file: Blob) => Promise<Blob | null>;

/** Draws the picture on white, at most SHRUNK_EDGE on its longest edge, and saves it as a JPEG. */
export const shrink: Encoder = async (file) => {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, SHRUNK_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
};

/** The name a re-encoded picture is sent under: its own, ending in .jpg. */
const jpegName = (name: string): string => `${(name || '貼り付けた画像').replace(/\.[^.]+$/u, '')}.jpg`;

/** One file as it is sent: a picture too large to look at or of no kind a model reads re-encoded, anything else as it is. */
export const prepareFile = async (file: File, encode: Encoder = shrink): Promise<File> => {
  const content = chatContentType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const picture = content ? content.startsWith('image/') : file.type.startsWith('image/');
  if (!picture || (content && file.size <= LOOKABLE_IMAGE_BYTES)) return file;
  const shrunk = await encode(file);
  return shrunk && shrunk.size <= LOOKABLE_IMAGE_BYTES ? new File([shrunk], jpegName(file.name), { type: 'image/jpeg' }) : file;
};

/** Every file of one message as it is sent, in the order chosen. */
export const prepareFiles = (files: readonly File[], encode: Encoder = shrink): Promise<File[]> => Promise.all(files.map((file) => prepareFile(file, encode)));
