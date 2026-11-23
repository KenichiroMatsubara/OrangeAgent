import { describe, expect, it } from 'vitest';

import { accessTokenHash, generateAccessToken, presentedToken } from './access-token';

describe('Access Token credential', () => {
  it('hashes what it stores so a leaked database cannot be presented as the token', async () => {
    const token = generateAccessToken();
    const hash = await accessTokenHash(token);

    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    await expect(accessTokenHash(token)).resolves.toBe(hash);
  });

  it('issues a token long enough not to be guessed', () => {
    const token = generateAccessToken();

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(generateAccessToken()).not.toBe(token);
  });

  it('reads the credential only from the Authorization header, never the query string', () => {
    expect(presentedToken(new Request('https://flarechat.example/mcp', { headers: { Authorization: 'Bearer abc' } }))).toBe('abc');
    expect(presentedToken(new Request('https://flarechat.example/mcp?access_token=abc'))).toBeNull();
    expect(presentedToken(new Request('https://flarechat.example/mcp', { headers: { Authorization: 'abc' } }))).toBeNull();
  });
});
