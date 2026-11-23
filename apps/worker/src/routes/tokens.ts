import { asc, eq, inArray } from 'drizzle-orm';
import { OPERATOR_TOKEN_RUN, withoutMailbox, type AccessToken, type IssuedAccessToken, type IssuedLoginCode, type McpEndpoint, type OperatorToken, type OperatorTokenGrant } from '@mail/domain';

import { accessTokenHash, generateAccessToken, presentedToken } from '../access-token';
import { bearerChallenge, mcpUrl } from '../authorization';
import { channelCredentials } from '../channel';
import { now } from '../clock';
import { guidance } from '../guidance';
import { hasAutomationInbox, openInbox, type InboxSession } from '../inbox';
import { accessTokenRun, grantedServerTools, handleMcpServerRequest, serveMcpServerRequest, type JsonRpcRequest, type McpServerReply } from '../mcp-server';
import {
  authenticateAccessToken,
  publishedPrompts,
  recordAccessTokenUse,
  suppressionPort,
} from '../mcp-server-store';
import {
  authenticateOperatorToken,
  exchangeLoginCode,
  isActiveMember,
  issueLoginCode,
  listOperatorTokens,
  memberName,
  recordOperatorTokenUse,
  revokeOperatorToken,
} from '../operator';
import { memoryStoreOf } from '../memory/store';
import type { Providers } from '../providers';
import { gone, invalid, noAccess, notFound } from '../refusal';
import { json, resource } from '../response';
import { accessTokens, accessTokenTools, contactLists } from '../storage/account-schema';
import { accountDatabase as drizzleAccountDatabase } from '../storage/database';
import { SUPPRESSION_WINDOWS, type SuppressionWindow } from '../suppression';
import { activeAccountDatabase } from './request-context';
import { accountKeyFor } from '../keys';
import { accountRoute, publicAccount } from './account';
import { channelPorts } from '../sending';
import { isRunToken, reachRun } from '../rendezvous';
import { runSkills, type SkillStore } from '../skills';
import { toolHandlers } from '../tools';
import type { Bindings } from '../types';

/** Where a member's CLI exchanges a Login Code for an Operator Token. */
const exchangeUrl = (env: Bindings, accountId: string): string =>
  `${env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/operator-tokens`;

/** The Access Tokens outside agents hold, the Operator Tokens members' CLIs hold, and the MCP Server both reach. */
export const tokenRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/access-tokens', accountRoute(async ({ db }): Promise<AccessToken[]> => {
    const rows = await db.select().from(accessTokens).orderBy(asc(accessTokens.name)).all();
    const grants = rows.length
      ? await db.select().from(accessTokenTools).where(inArray(accessTokenTools.tokenId, rows.map(({ id }) => id))).all()
      : [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      contactListId: row.contactListId,
      suppressionWindow: row.suppressionWindow,
      lastUsedAt: row.lastUsedAt,
      tools: grantedServerTools(grants.flatMap((grant) => grant.tokenId === row.id ? [grant.tool] : [])),
    }));
  }));

  /** Issues a Token once; the credential is shown here and never again, because only its hash is stored. */
  routes.post('/organizations/:accountId/access-tokens', accountRoute<{ name?: string; contactListId?: string; tools?: unknown; suppressionWindow?: string }>(async ({ db, env, accountId, body }): Promise<IssuedAccessToken> => {
    const name = body.name?.trim() ?? '';
    const contactListId = body.contactListId?.trim() ?? '';
    if (!name) throw invalid('Access Token 名を入力してください。');
    if (!contactListId) throw invalid('到達できる Contact List を選んでください。');
    const requested = Array.isArray(body.tools) ? body.tools.filter((tool): tool is string => typeof tool === 'string') : [];
    const tools = grantedServerTools(requested);
    if (!tools.length) throw invalid('許可するツールを1つ以上選んでください。');
    const window = body.suppressionWindow ?? 'day';
    if (!SUPPRESSION_WINDOWS.includes(window as SuppressionWindow)) throw invalid('重複抑止の窓の指定が不正です。');
    const list = await db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, contactListId)).get();
    if (!list) throw notFound('指定された Contact List が見つかりません。');
    const token = generateAccessToken();
    const id = crypto.randomUUID();
    const timestamp = now();
    await db.insert(accessTokens).values({
      id,
      accountId,
      name,
      tokenHash: await accessTokenHash(token),
      contactListId,
      suppressionWindow: window as SuppressionWindow,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    for (const tool of tools) await db.insert(accessTokenTools).values({ tokenId: id, tool }).run();
    return {
      id,
      name,
      tools,
      token,
      url: mcpUrl(env, accountId),
    };
  }));

  routes.delete('/organizations/:accountId/access-tokens/:tokenId', accountRoute(async ({ db, params }) => {
    const tokenId = params.tokenId ?? '';
    await db.delete(accessTokens).where(eq(accessTokens.id, tokenId)).run();
    return { id: tokenId, revoked: true };
  }));

  /**
   * Shows the signed-in member a Login Code their CLI exchanges for an Operator
   * Token. Their Google sign-in is what admits the CLI, so the long-lived
   * credential is never shown on a screen, only handed to the CLI that asks.
   */
  routes.post('/organizations/:accountId/login-codes', accountRoute(async ({ db, env, accountId, session }): Promise<IssuedLoginCode> => {
    const issued = await issueLoginCode({ db, identityId: session.identity_id, at: new Date() });
    return { ...issued, exchangeUrl: exchangeUrl(env, accountId), serverUrl: mcpUrl(env, accountId) };
  }));

  routes.get('/organizations/:accountId/operator-tokens', accountRoute(async ({ db, env }): Promise<OperatorToken[]> =>
    listOperatorTokens({ db, control: env.CONTROL_DB, at: new Date() })));

  /** The URL a member gives Claude or another app to connect, exactly as its OAuth metadata names it. */
  routes.get('/organizations/:accountId/mcp-endpoint', accountRoute(async ({ env, accountId }): Promise<McpEndpoint> => ({ url: mcpUrl(env, accountId) })));

  routes.delete('/organizations/:accountId/operator-tokens/:tokenId', accountRoute(async ({ db, params }) => {
    const tokenId = params.tokenId ?? '';
    await revokeOperatorToken({ db, tokenId });
    return { id: tokenId, revoked: true };
  }));

  /** A member's CLI exchanges the Login Code it was given for its Operator Token, once. */
  routes.post('/public/organizations/:accountId/operator-tokens', async (context) => {
    const accountId = context.req.param('accountId');
    const { db } = await publicAccount(context.env, accountId, 'Operator Token');
    const body = await context.req.json<{ code?: unknown }>().catch(() => ({ code: undefined }));
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) throw invalid('ログインコードを送ってください。');
    const exchanged = await exchangeLoginCode({ db, presented: code, at: new Date() });
    if (!exchanged) throw gone('ログインコードが違うか、期限が切れたか、すでに使われています。接続画面で新しいコードを表示してください。');
    if (!await isActiveMember({ control: context.env.CONTROL_DB, accountId, identityId: exchanged.identityId })) {
      await revokeOperatorToken({ db, tokenId: exchanged.id });
      throw noAccess('このログインコードを発行したメンバーは、このアカウントに参加していません。');
    }
    return json<OperatorTokenGrant>(context, { token: exchanged.token, expiresAt: exchanged.expiresAt, url: mcpUrl(context.env, accountId) });
  });

  /**
   * The MCP Server. An outside agent presents an Access Token, a member's CLI
   * an Operator Token, and a program a run handed one a Run Token, each in the
   * Authorization header alone; it answers in JSON-RPC even when it refuses, in
   * whichever revision the request speaks. A Run Token's calls are answered by
   * the run that issued it, as its own calls are (ADR 0199).
   */
  routes.post('/public/organizations/:accountId/mcp', async (context) => {
    const rpcError = (code: number, message: string, status: 200 | 401 | 403 | 429 | 503) =>
      context.json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);
    const send = (reply: McpServerReply) => reply.body ? context.json(reply.body, reply.status) : context.body(null, reply.status);
    try {
      const env = context.env;
      const accountId = context.req.param('accountId');
      const presented = presentedToken(context.req.raw);
      // A 401 names where the authorization server is, so an OAuth client such as Claude can sign the member in.
      if (!presented) {
        context.header('WWW-Authenticate', bearerChallenge(env, accountId, false));
        return rpcError(-32001, 'An Access Token, an Operator Token, or a Run Token must be presented in the Authorization header.', 401);
      }
      // A Run Token names its run's object by its hash and needs nothing of the Account's database.
      const ran = isRunToken(presented) && env.RUN_CALLS ? await reachRun({ namespace: env.RUN_CALLS, presented, accountId }) : null;
      if (ran) {
        const request = await context.req.json<JsonRpcRequest>();
        return send(await serveMcpServerRequest({ request, headers: context.req.raw.headers, answer: (era) => handleMcpServerRequest({
          request,
          era,
          origin: env.WEB_ORIGIN || env.APP_URL,
          run: { tools: ran.tools },
          prompts: [],
          handlers: Object.fromEntries(ran.tools.map(({ name }) => [name, (arguments_: Record<string, unknown>) => ran.call(name, arguments_)])),
        }) }));
      }
      const database = await activeAccountDatabase(env, accountId);
      if (!database) return rpcError(-32003, 'This Account is not available.', 503);
      const db = drizzleAccountDatabase(database);
      const at = new Date();
      const token = await authenticateAccessToken({ database, presented });
      const operator = token ? null : await authenticateOperatorToken({ db, presented, at });
      if (!token && !operator) {
        context.header('WWW-Authenticate', bearerChallenge(env, accountId, true));
        return rpcError(-32001, 'This token is not recognised, or it has expired.', 401);
      }
      if (operator && !await isActiveMember({ control: env.CONTROL_DB, accountId, identityId: operator.identityId })) {
        return rpcError(-32002, 'The member this Operator Token acts as is no longer in this Account.', 403);
      }

      const request = await context.req.json<JsonRpcRequest>();
      if (token) await recordAccessTokenUse({ database, token, at });
      if (operator) await recordOperatorTokenUse({ db, tokenId: operator.id, at });

      const accountKey = await accountKeyFor(env, accountId);
      const ports = channelPorts({ database, credentials: await channelCredentials({ database, accountKey, accountId }) });
      const prompts = await publishedPrompts({ db, bucket: env.RECOVERY_RECEIPTS, accountId });
      let session: Promise<InboxSession> | undefined;
      const inbox = (): Promise<InboxSession> => {
        session ??= openInbox({ env, accountId, database, google: providers.google });
        return session;
      };
      const skills: SkillStore = { db, bucket: env.RECOVERY_RECEIPTS, accountId };
      const mailbox = await hasAutomationInbox(database);
      // What a memory is kept under, so 記憶 shows which key or whose CLI wrote it.
      const author = { kind: 'cli' as const, name: token ? token.name : await memberName({ control: env.CONTROL_DB, identityId: operator?.identityId ?? '' }) };
      // Both keys reach what Operator Chat reaches; an Access Token is narrowed by its grant and its Contact List.
      const shared = {
        database, accountId, mail: { kind: 'mailbox' as const },
        google: { provider: providers.google, session: inbox }, ports,
        origin: { automationId: null, sourceMessageId: null }, skills, at: () => at,
        memory: { store: memoryStoreOf(env, db, accountId), author },
      };
      const reached = token ? accessTokenRun(token.grant) : OPERATOR_TOKEN_RUN;
      const run = mailbox ? reached : withoutMailbox(reached);
      const handlers = token
        ? toolHandlers({ ...shared, reach: { kind: 'contact_list', holder: 'this Access Token', contactIds: token.contactIds, emails: [], roster: 'list' } }, {
          ...suppressionPort({ database, scope: token.id, window: token.suppressionWindow, at }),
          scope: token.id,
          window: token.suppressionWindow,
          holder: 'this Access Token',
        })
        : toolHandlers({ ...shared, reach: { kind: 'anyone' } });
      return send(await serveMcpServerRequest({ request, headers: context.req.raw.headers, answer: (era) => handleMcpServerRequest({
        request,
        era,
        origin: env.WEB_ORIGIN || env.APP_URL,
        run,
        prompts,
        // Every outside caller is told what Operator Chat is told, with the same Skills listed.
        instructions: async () => guidance((await runSkills(skills, [])).instructions),
        handlers,
      }) }));
    } catch (error) {
      return rpcError(-32603, error instanceof Error ? error.message : 'The MCP Server failed.', 503);
    }
  });

  /** The endpoint takes only POST: a client of an older revision that opens a stream or ends a session is told so. */
  routes.on(['GET', 'DELETE'], '/public/organizations/:accountId/mcp', (context) => context.body(null, 405, { Allow: 'POST' }));

  return routes;
};
