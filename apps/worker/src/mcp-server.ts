/**
 * OrangeAgent as an MCP Server.
 *
 * The third entrance to the engine, beside Operator Chat and the Trigger. An
 * outside agent presents an Access Token carrying one Tool Grant and one bound
 * Contact List, so no authorization concept is invented for it; a member's own
 * CLI presents an Operator Token and is the run Operator Chat is. Either way
 * the tools it is offered are selected from the product's one list as every
 * run's are.
 */

import { ACCESS_TOKEN_TOOLS, ACCESS_TOKEN_RUN, type ToolName, type ToolRun } from '@mail/domain';

import { decodeText, toBase64 } from './encoding';
import { FileAnswer, type ToolHandlers, type TurnFile } from './turns';
import type { RunCallTool } from './rendezvous';
import { describedTools } from './tools';

/**
 * The revisions this server speaks, newest first: the stateless one, which a
 * request names in its own `_meta`, then those a client opens with initialize.
 * A client learns them from server/discover, or from the refusal of a revision
 * not among them, so neither side pins the other's.
 */
export const SERVER_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;
const STATELESS_VERSIONS: readonly string[] = ['2026-07-28'];
const HANDSHAKE_VERSIONS: readonly string[] = SERVER_PROTOCOL_VERSIONS.filter((version) => !STATELESS_VERSIONS.includes(version));

/** Who answers: OrangeAgent, with the icon its GUI is served with, so a client can show the server as the product it is. */
const serverInfo = (origin: string) => {
  const base = origin.replace(/\/$/u, '');
  return {
    name: 'orangeagent',
    title: 'OrangeAgent',
    version: '1',
    icons: [
      { src: `${base}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
      { src: `${base}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
    ],
  };
};
const CAPABILITIES = { tools: {}, prompts: {} } as const;
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
/** The methods whose `params.name` a stateless request mirrors in its Mcp-Name header. */
const NAMED_METHODS: readonly string[] = ['tools/call', 'prompts/get'];

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;

/** How one request speaks: statelessly, naming its revision itself, or inside a session an initialize opened. */
export type McpEra = { kind: 'stateless'; version: string } | { kind: 'handshake' };

/** What the HTTP endpoint sends: a JSON-RPC answer under its status, or nothing for a notification. */
export interface McpServerReply {
  status: 200 | 202 | 400 | 404;
  body: JsonRpcResponse | null;
}

/** A file of a published Skill: its words when it is text, else its bytes as base64. */
export type McpServerPromptFile = { path: string; mediaType: string; text: string } | { path: string; mediaType: string; blob: string };

export interface McpServerPrompt {
  name: string;
  description: string;
  /** Reads the Skill's instructions and files, only when an outside agent asks for this prompt. */
  open: () => Promise<{ instructions: string; files: McpServerPromptFile[] }>;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Denies by default: only names that are both granted and an Access Token's to call, in the list's order. */
export const grantedServerTools = (grant: readonly string[]): ToolName[] => {
  const named = new Set(grant);
  return ACCESS_TOKEN_TOOLS.flatMap((tool) => named.has(tool.name) ? [tool.name] : []);
};

/** What an Access Token's run is: a run outside OrangeAgent, narrowed by its Tool Grant. */
export const accessTokenRun = (grant: readonly string[]): ToolRun => ({ ...ACCESS_TOKEN_RUN, grant: grantedServerTools(grant) });

const textContent = (value: unknown) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });

/** A file a tool read, such as a mail's attachment, handed over as itself: an image as an image, text as its words, anything else as its bytes. */
const fileContent = (file: TurnFile) => {
  if (file.mediaType.startsWith('image/')) return { type: 'image', data: toBase64(file.bytes), mimeType: file.mediaType };
  const uri = `orangeagent://files/${encodeURIComponent(file.filename)}`;
  return file.mediaType.startsWith('text/')
    ? { type: 'resource', resource: { uri, mimeType: file.mediaType, text: decodeText(file.bytes) } }
    : { type: 'resource', resource: { uri, mimeType: file.mediaType, blob: toBase64(file.bytes) } };
};

const toolResult = (value: unknown, isError = false): Record<string, unknown> => value instanceof FileAnswer
  ? { isError, content: [textContent(value.answer), ...value.files.map(fileContent)] }
  : { isError, content: [textContent(value)] };

const refusal = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null || (result as { isError?: unknown }).isError !== true) return null;
  const message = (result as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(result);
};

export const handleMcpServerRequest = async (input: {
  request: JsonRpcRequest;
  /**
   * What the caller's run is: an Access Token's, narrowed by its grant, or an
   * Operator Token's; or, for a Run Token, the tools of the run that issued
   * it, as that run offers them.
   */
  run: ToolRun | { tools: readonly RunCallTool[] };
  prompts: readonly McpServerPrompt[];
  /** The handlers the caller's run calls, already bounded as that run is. */
  handlers: ToolHandlers;
  /** How the request speaks; a request that names no revision of its own speaks inside a handshake's session. */
  era?: McpEra;
  /** Where the GUI is served, whose icon the server names itself with. */
  origin: string;
  /** What an outside caller is told, as Operator Chat is (`guidance.ts`). */
  instructions?: () => Promise<string>;
}): Promise<JsonRpcResponse> => {
  const id = input.request.id ?? null;
  const stateless = input.era?.kind === 'stateless';
  // A stateless result says it is complete and who answered; a list may be cached only by the token that asked for it.
  const reply = (result: Record<string, unknown>, cacheable = false): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    result: stateless
      ? { resultType: 'complete', ...result, ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}), _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo(input.origin) } }
      : result,
  });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
  const tools: readonly RunCallTool[] = 'tools' in input.run ? input.run.tools : describedTools(input.run);
  // Read only when a client opens or discovers the server, since it lists the Account's Skills.
  const instructed = async (): Promise<{ instructions?: string }> => input.instructions ? { instructions: await input.instructions() } : {};

  switch (input.request.method) {
    case 'server/discover':
      return reply({ supportedVersions: [...SERVER_PROTOCOL_VERSIONS], capabilities: CAPABILITIES, ...await instructed() }, true);
    case 'initialize': {
      // The client's revision is answered as itself when this server speaks it, else as the newest one a handshake opens.
      const requested = input.request.params?.protocolVersion;
      const protocolVersion = typeof requested === 'string' && HANDSHAKE_VERSIONS.includes(requested) ? requested : HANDSHAKE_VERSIONS[0];
      return reply({ protocolVersion, capabilities: CAPABILITIES, serverInfo: serverInfo(input.origin), ...await instructed() });
    }
    case 'notifications/initialized':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) }, true);
    case 'prompts/list':
      return reply({ prompts: input.prompts.map(({ name, description }) => ({ name, description })) }, true);
    case 'prompts/get': {
      const name = typeof input.request.params?.name === 'string' ? input.request.params.name : '';
      const prompt = input.prompts.find((candidate) => candidate.name === name);
      if (!prompt) return fail(-32602, `No published Skill is named ${name}.`);
      const opened = await prompt.open();
      return reply({
        description: prompt.description,
        messages: [
          { role: 'user', content: { type: 'text', text: opened.instructions } },
          // Each file is an embedded resource: text as its words, any other kind as its bytes.
          ...opened.files.map((file) => ({
            role: 'user',
            content: { type: 'resource', resource: { uri: `orangeagent://skills/${encodeURIComponent(prompt.name)}/${file.path.split('/').map(encodeURIComponent).join('/')}`, mimeType: file.mediaType, ...('text' in file ? { text: file.text } : { blob: file.blob }) } },
          })),
        ],
      });
    }
    case 'tools/call': {
      const name = typeof input.request.params?.name === 'string' ? input.request.params.name : '';
      const handler = tools.some((tool) => tool.name === name) ? input.handlers[name] : undefined;
      if (!handler) return fail(-32602, `This token may not call ${name}.`);
      const arguments_ = (input.request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await handler(arguments_);
        const refused = refusal(result);
        return reply(refused === null ? toolResult(result) : toolResult(refused, true));
      } catch (error) {
        return reply(toolResult(error instanceof Error ? error.message : `${name} failed.`, true));
      }
    }
    default:
      return fail(METHOD_NOT_FOUND, `${input.request.method} is not supported by this server.`);
  }
};

/** A header value as the client meant it: one carried as `=?base64?…?=` is decoded, and one that does not decode is no value. */
const headerValue = (value: string | null): string | null => {
  const encoded = value === null ? null : /^=\?base64\?(.*)\?=$/u.exec(value);
  if (!encoded) return value;
  try {
    return decodeText(Uint8Array.from(atob(encoded[1] ?? ''), (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
};

const mismatch = (id: number | string | null, message: string): McpServerReply => ({
  status: 400,
  body: { jsonrpc: '2.0', id, error: { code: HEADER_MISMATCH, message: `Header mismatch: ${message}` } },
});

/**
 * Reads which era a request speaks. One that names its revision in `_meta` is
 * stateless, and is refused when its headers disagree with its body or when it
 * names a revision this server does not speak, with the ones it does; any other
 * request, initialize among them, speaks inside a handshake's session.
 */
export const readEra = (request: JsonRpcRequest, headers: Headers): McpEra | McpServerReply => {
  const id = request.id ?? null;
  const meta = request.params?._meta;
  const declared = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META] : undefined;
  if (request.method === 'initialize' || declared === undefined) return { kind: 'handshake' };
  if (typeof declared !== 'string') return mismatch(id, `${PROTOCOL_VERSION_META} must be a string.`);
  const version = headers.get('MCP-Protocol-Version');
  if (version !== declared) return mismatch(id, `MCP-Protocol-Version header value '${version ?? ''}' does not match body value '${declared}'.`);
  if (!STATELESS_VERSIONS.includes(declared)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id, error: { code: UNSUPPORTED_PROTOCOL_VERSION, message: 'Unsupported protocol version', data: { supported: [...SERVER_PROTOCOL_VERSIONS], requested: declared } } },
    };
  }
  const method = headers.get('Mcp-Method');
  if (method !== request.method) return mismatch(id, `Mcp-Method header value '${method ?? ''}' does not match body value '${request.method}'.`);
  if (NAMED_METHODS.includes(request.method)) {
    const name = headerValue(headers.get('Mcp-Name'));
    const named = request.params?.name;
    if (name !== named) return mismatch(id, `Mcp-Name header value '${name ?? ''}' does not match body value '${typeof named === 'string' ? named : ''}'.`);
  }
  return { kind: 'stateless', version: declared };
};

/**
 * Serves one POST to the MCP endpoint in whichever era it speaks: a
 * notification is accepted with nothing to answer, a request whose headers or
 * revision are refused is answered 400, and a stateless request for a method
 * this server does not have is answered 404, as that revision requires.
 */
export const serveMcpServerRequest = async (input: {
  request: JsonRpcRequest;
  headers: Headers;
  answer: (era: McpEra) => Promise<JsonRpcResponse>;
}): Promise<McpServerReply> => {
  if (input.request.id === undefined) return { status: 202, body: null };
  const era = readEra(input.request, input.headers);
  if (!('kind' in era)) return era;
  const body = await input.answer(era);
  return { status: era.kind === 'stateless' && body.error?.code === METHOD_NOT_FOUND ? 404 : 200, body };
};
