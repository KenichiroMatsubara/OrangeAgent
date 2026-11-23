import { afterEach, describe, expect, it, vi } from 'vitest';

import { masterKey } from './cryptography';
import { beginMicrosoftConnection, completeMicrosoftConnection, MAX_WORD_UPLOAD_BYTES, MicrosoftGrantRevoked, microsoftAccessToken, openMicrosoftState, renderPdfWithOffice } from './microsoft';
import { accountDatabase } from './storage/database';
import type { Bindings } from './types';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const env = {
  APP_URL: 'https://app.example.com',
  CREDENTIAL_MASTER_KEY: MASTER_KEY,
  MICROSOFT_CLIENT_ID: 'ms-client',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
} as unknown as Bindings;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let database: TestD1Database | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  database?.close();
  database = undefined;
});

describe('the Microsoft connection', () => {
  it('opens only a state it minted, and only until it expires', async () => {
    const url = new URL(await beginMicrosoftConnection(env, { accountId: 'organization-1', identityId: 'identity-1' }));
    const state = url.searchParams.get('state') ?? '';

    await expect(openMicrosoftState(env, state)).resolves.toMatchObject({ accountId: 'organization-1', identityId: 'identity-1' });
    await expect(openMicrosoftState(env, `${state.slice(0, -4)}AAAA`)).resolves.toBeNull();
    await expect(openMicrosoftState(env, undefined)).resolves.toBeNull();
    vi.setSystemTime(Date.now() + 11 * 60 * 1_000);
    await expect(openMicrosoftState(env, state)).resolves.toBeNull();
  });

  it('uses the access token until it nearly expires, then renews it and keeps the refresh token Microsoft hands back', async () => {
    database = createMigratedTestD1('organization');
    const db = accountDatabase(database.binding);
    const key = await masterKey(MASTER_KEY);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'The refresh token has been revoked.' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const connection = { env, db, key, accountId: 'organization-1' };

    await completeMicrosoftConnection({ ...connection, code: 'code', verifier: 'verifier' });
    await expect(microsoftAccessToken(connection)).resolves.toBe('access-1');
    vi.setSystemTime(Date.now() + 59 * 60 * 1_000);
    await expect(microsoftAccessToken(connection)).resolves.toBe('access-2');
    expect(new URLSearchParams(String(fetchMock.mock.calls[1]?.[1]?.body)).get('refresh_token')).toBe('refresh-1');
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    await expect(microsoftAccessToken(connection)).rejects.toBeInstanceOf(MicrosoftGrantRevoked);
    expect(new URLSearchParams(String(fetchMock.mock.calls[2]?.[1]?.body)).get('refresh_token')).toBe('refresh-2');
  });

  it('answers no token when the Account connected none', async () => {
    database = createMigratedTestD1('organization');
    const connection = { env, db: accountDatabase(database.binding), key: await masterKey(MASTER_KEY), accountId: 'organization-1' };
    await expect(microsoftAccessToken(connection)).resolves.toBeNull();
    await expect(microsoftAccessToken({ ...connection, env: { ...env, MICROSOFT_CLIENT_SECRET: '' } })).resolves.toBeNull();
  });

  it('refuses a file larger than one upload carries without asking Microsoft', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(renderPdfWithOffice('token', { extension: 'docx', bytes: new Uint8Array(MAX_WORD_UPLOAD_BYTES + 1) })).rejects.toThrow('at most');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
