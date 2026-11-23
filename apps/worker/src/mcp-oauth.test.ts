import { describe, expect, it } from 'vitest';

import { randomToken } from './encoding';
import type { McpFetch } from './mcp';
import { beginMcpSignIn, McpSignInUnavailable, openMcpState } from './mcp-oauth';
import type { Bindings } from './types';

const env = { APP_URL: 'https://orangeagent.example.workers.dev', CREDENTIAL_MASTER_KEY: randomToken(32) } as unknown as Bindings;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Google's Gmail MCP Server as it answers: initialize needs no token, its metadata sits at the path-inserted well-known URL, and accounts.google.com registers no client. */
const google: McpFetch = async (url, init) => {
  if (url === 'https://gmailmcp.googleapis.com/mcp/v1' && init.method === 'POST') {
    return json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'StatelessServer' } } });
  }
  if (url === 'https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1') {
    return json({
      resource: 'https://gmailmcp.googleapis.com/mcp/v1',
      authorization_servers: ['https://accounts.google.com/'],
      scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
    });
  }
  if (url === 'https://accounts.google.com/.well-known/openid-configuration') {
    return json({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      code_challenge_methods_supported: ['plain', 'S256'],
    });
  }
  return new Response('Not Found', { status: 404 });
};

const signIn = (registered: Parameters<typeof beginMcpSignIn>[0]['registered']): Promise<string> => beginMcpSignIn({
  env, fetch: google, accountId: 'account-1', identityId: 'identity-1', serverId: 'server-1', url: 'https://gmailmcp.googleapis.com/mcp/v1', registered,
});

describe('signing in to an MCP Server whose authorization server registers no client', () => {
  it('signs in with the client the Account registered, asking for its scopes and for a refresh token', async () => {
    const authorization = new URL(await signIn({
      clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret-1', scope: 'https://www.googleapis.com/auth/gmail.readonly',
    }));

    expect(`${authorization.origin}${authorization.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      client_id: 'client-1.apps.googleusercontent.com',
      redirect_uri: 'https://orangeagent.example.workers.dev/oauth/mcp/callback',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      resource: 'https://gmailmcp.googleapis.com/mcp/v1',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    const state = await openMcpState(env, authorization.searchParams.get('state') ?? undefined);
    expect(state).toMatchObject({
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: 'client-1.apps.googleusercontent.com',
      clientSecret: 'secret-1',
      authentication: 'client_secret_post',
      serverId: 'server-1',
    });
  });

  it('asks for every scope the server names when the Account chose none', async () => {
    const authorization = new URL(await signIn({ clientId: 'client-1', clientSecret: null, scope: null }));

    expect(authorization.searchParams.get('scope')).toBe('https://mail.google.com/ https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose');
    expect((await openMcpState(env, authorization.searchParams.get('state') ?? undefined))?.authentication).toBe('none');
  });

  it('says to enter a client of its own when the Account registered none', async () => {
    await expect(signIn(null)).rejects.toThrow(McpSignInUnavailable);
    await expect(signIn(null)).rejects.toThrow(/クライアント ID とシークレット/u);
  });
});
