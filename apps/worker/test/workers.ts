/**
 * The part of the Workers runtime's `cloudflare:workers` module the Worker's
 * Node tests construct: the Durable Object and entrypoint base classes, which
 * keep the state and the bindings the runtime hands them, and the Worker's
 * own exports, of which a Node test has none. Every Node test resolves the
 * module here (vitest.config.ts); the D1 suite runs in the real runtime.
 */
export class DurableObject<Env = unknown> {
  constructor(readonly ctx: DurableObjectState, readonly env: Env) {}
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  constructor(readonly ctx: ExecutionContext<Props>, readonly env: Env) {}
}

export const exports: Record<string, unknown> = {};
