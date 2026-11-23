import { asc, eq } from 'drizzle-orm';
import { RESERVED_TOOL_NAMESPACES, type McpOAuthClient, type McpServer, type McpServerInput, type McpServerTool, type McpServerToolResult } from '@mail/domain';

import { deleteChatServer, listChatServers, openChatServerClient, saveChatServer } from '../chat-store';
import { now } from '../clock';
import { callMcpTool, listMcpTools } from '../mcp';
import type { Providers } from '../providers';
import { beginMcpSignIn, McpSignInUnavailable } from '../mcp-oauth';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import { mcpServers } from '../storage/account-schema';
import { accountRoute } from './account';

const MCP_REVISIONS = ['2026-07-28', '2025-06-18'] as const;
type McpRevision = (typeof MCP_REVISIONS)[number];

/** The OAuth client a person entered, trimmed, or null when they entered none. */
const oauthClientOf = (value: McpServerInput['oauthClient'], token: string | null): McpOAuthClient | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('OAuth クライアントの指定が不正です。');
  const clientId = typeof value.clientId === 'string' ? value.clientId.trim() : '';
  const clientSecret = typeof value.clientSecret === 'string' ? value.clientSecret.trim() : '';
  const scope = typeof value.scope === 'string' ? value.scope.trim().split(/[\s,]+/u).filter(Boolean).join(' ') : '';
  if (!clientId) {
    if (clientSecret || scope) throw invalid('OAuth クライアントのシークレットやスコープを使うときは、クライアント ID も入力してください。');
    return null;
  }
  if (token) throw invalid('トークンと OAuth クライアントは、どちらか一方だけを入力してください。');
  return { clientId, clientSecret: clientSecret || null, scope: scope || null };
};

/** The remote MCP Servers an Account registered, and calling one for real. */
export const serverRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/mcp-servers', accountRoute(async ({ db }): Promise<McpServer[]> => {
    const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      revision: row.revision,
      authentication: row.oauthEnvelope ? 'oauth' : row.tokenEnvelope ? 'token' : 'none',
      ownOAuthClient: row.oauthClientEnvelope !== null,
      signInError: row.oauthError,
      updatedAt: row.updatedAt,
    }));
  }));

  /** The URL that starts signing this Account in to one of its MCP Servers by OAuth, for the person asking. */
  routes.post('/organizations/:accountId/mcp-servers/:serverId/authorize', accountRoute(async (request): Promise<{ authorizationUrl: string }> => {
    const serverId = request.params.serverId ?? '';
    const server = await request.db.select({ url: mcpServers.url, client: mcpServers.oauthClientEnvelope }).from(mcpServers).where(eq(mcpServers.id, serverId)).get();
    if (!server) throw notFound('その MCP Server は登録されていません。');
    const registered = await openChatServerClient({ accountKey: await request.key(), accountId: request.accountId, serverId, envelope: server.client });
    try {
      return { authorizationUrl: await beginMcpSignIn({
        env: request.env, fetch: providers.fetch, accountId: request.accountId, identityId: request.session.identity_id, serverId, url: server.url, registered,
      }) };
    } catch (error) {
      if (error instanceof McpSignInUnavailable) throw conflict(error.message);
      throw error;
    }
  }));

  routes.put('/organizations/:accountId/mcp-servers/:serverId', accountRoute<{ name?: string; url?: string; token?: string | null; oauthClient?: McpServerInput['oauthClient']; revision?: string | null }>(async (request) => {
    const name = request.body.name?.trim() ?? '';
    const url = request.body.url?.trim() ?? '';
    if (!/^[a-z0-9_-]+$/u.test(name)) {
      throw invalid('MCP Server 名は英小文字・数字・ハイフン・アンダースコアで入力してください。');
    }
    if (RESERVED_TOOL_NAMESPACES.includes(name)) {
      throw invalid(`「${name}」は OrangeAgent 自身の機能の名前なので、MCP Server 名には使えません。別の名前にしてください。`);
    }
    if (!/^https:\/\//u.test(url)) throw invalid('MCP Server の URL は https で始まる必要があります。');
    const revision = request.body.revision ?? null;
    if (revision !== null && !MCP_REVISIONS.includes(revision as McpRevision)) throw invalid('MCP のリビジョン指定が不正です。');
    const id = request.params.serverId ?? '';
    const token = request.body.token?.trim() || null;
    const oauthClient = oauthClientOf(request.body.oauthClient, token);
    await saveChatServer({
      database: request.database,
      accountKey: await request.key(),
      accountId: request.accountId,
      id,
      name,
      url,
      token,
      oauthClient,
      revision: revision as McpRevision | null,
      timestamp: now(),
    });
    return { id, name, url };
  }));

  routes.delete('/organizations/:accountId/mcp-servers/:serverId', accountRoute(async (request) => {
    const id = request.params.serverId ?? '';
    await deleteChatServer({ database: request.database, id });
    return { id, deleted: true };
  }));

  /**
   * Without a tool name this lists what the server offers, which is the cheapest
   * proof that the URL, the token and the revision are right. With one it calls
   * that tool with the arguments given and returns the server's own answer,
   * failures included, so a LINE MCP Server can be made to send a real message.
   */
  routes.post('/organizations/:accountId/mcp-servers/:serverId/tests', accountRoute<{ tool?: string; arguments?: unknown }>(async (request): Promise<{ server: string; tools: McpServerTool[] } | McpServerToolResult> => {
    const serverId = request.params.serverId ?? '';
    const servers = await listChatServers({ database: request.database, accountKey: await request.key(), accountId: request.accountId, fetch: providers.fetch });
    const server = servers.find(({ id }) => id === serverId);
    if (!server) throw notFound('その MCP Server は登録されていません。');
    const tool = request.body.tool?.trim() ?? '';
    if (!tool) return { server: server.name, tools: await listMcpTools({ connection: server.connection, fetch: providers.fetch }) };
    const argument = request.body.arguments;
    if (argument !== undefined && (typeof argument !== 'object' || argument === null || Array.isArray(argument))) {
      throw invalid('ツールの引数は JSON オブジェクトで指定してください。');
    }
    const result = await callMcpTool({
      connection: server.connection,
      fetch: providers.fetch,
      name: tool,
      arguments: (argument ?? {}) as Record<string, unknown>,
    });
    return { server: server.name, tool, isError: result.isError, text: result.text };
  }));

  return routes;
};
