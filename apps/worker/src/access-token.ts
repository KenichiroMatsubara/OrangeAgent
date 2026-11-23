/**
 * The credential an outside agent presents to the MCP Server.
 *
 * A Token is bounded by its Tool Grant alone: it reaches whom Operator Chat
 * reaches, and nothing counts or holds back its calls or its writes.
 */

export const generateAccessToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Only the hash is stored, so a copy of the database is not a usable credential. */
export const accessTokenHash = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Reads the credential from the Authorization header alone. The MCP authorization
 * specification forbids an access token in the URI query string, and a token in a
 * URL is copied into logs and referrers by everything it passes through.
 */
export const presentedToken = (request: Request): string | null => {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  return match?.[1] ?? null;
};
