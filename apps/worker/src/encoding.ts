const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64Url = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

/** Standard base64, built a chunk at a time so a file of several megabytes is not one character at a time. */
export const toBase64 = (value: Uint8Array): string => {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += 0x8000) chunks.push(String.fromCharCode(...value.subarray(start, start + 0x8000)));
  return btoa(chunks.join(''));
};

export const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) throw new Error('Invalid base64url value.');
  const unpadded = value.replace(/=+$/u, '');
  const padded = unpadded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const encodeText = (value: string): Uint8Array => encoder.encode(value);
export const decodeText = (value: ArrayBuffer | Uint8Array): string => decoder.decode(value);
export const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

export const randomToken = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
};

export const sha256 = async (value: string): Promise<string> =>
  toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(value))));
