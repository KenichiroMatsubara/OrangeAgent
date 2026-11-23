/**
 * The Durable Object a Run Token reaches (`rendezvous.ts`). The run that
 * issued the token holds a WebSocket to it for as long as it thinks; the MCP
 * Server puts each call made with the token to it at `/entrance`, and it hands
 * the call to the run and waits for the run's answer. With no run on the
 * socket, or after the token's time, it answers 404, so the token stops
 * working the moment its run ends. It keeps nothing once the run is gone.
 */

import { DurableObject } from 'cloudflare:workers';

import { RUN_CALL_TIMEOUT_MS, type EntranceRequest, type ObjectMessage, type RunMessage, type WireAnswer } from './rendezvous';
import type { Bindings } from './types';

type Hello = Extract<RunMessage, { type: 'hello' }>;

const HELLO = 'hello';

export class RunCalls extends DurableObject<Bindings> {
  private readonly waiting = new Map<string, (answer: WireAnswer | null) => void>();

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/serve') {
      // One run holds one token: a second run is never handed the same object.
      if (this.ctx.getWebSockets().length) return new Response('This token is already held by a run.', { status: 409 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const asked = await request.json() as EntranceRequest;
    const socket = this.ctx.getWebSockets()[0];
    const hello = await this.ctx.storage.get<Hello>(HELLO);
    if (!socket || !hello || hello.accountId !== asked.accountId) return new Response(null, { status: 404 });
    if (Date.parse(hello.expiresAt) <= Date.now()) {
      socket.close(1000, 'The Run Token expired.');
      await this.forget();
      return new Response(null, { status: 404 });
    }
    if (asked.kind === 'list') return Response.json({ tools: hello.tools });
    const id = crypto.randomUUID();
    const answer = await new Promise<WireAnswer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, RUN_CALL_TIMEOUT_MS);
      this.waiting.set(id, (answered) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(answered);
      });
      socket.send(JSON.stringify({ type: 'call', id, name: asked.name, arguments: asked.arguments } satisfies ObjectMessage));
    });
    if (!answer) return new Response(null, { status: 504 });
    return Response.json({ answer });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data) as RunMessage;
    if (message.type === 'hello') {
      await this.ctx.storage.put(HELLO, message);
      socket.send(JSON.stringify({ type: 'ready' } satisfies ObjectMessage));
      return;
    }
    this.waiting.get(message.id)?.(message.answer);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      socket.close(1000, 'The run ended.');
    } catch {
      // Already closed from the run's side.
    }
    await this.forget();
  }

  override async webSocketError(): Promise<void> {
    await this.forget();
  }

  /** Ends every call still waiting and keeps nothing, since only a run that is still thinking answers. */
  private async forget(): Promise<void> {
    for (const resolve of [...this.waiting.values()]) resolve({ kind: 'error', message: 'The run this token was issued by ended before it answered this call.' });
    await this.ctx.storage.deleteAll();
  }
}
