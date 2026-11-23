// What `@mail/t3chat/fake` exports, declared apart from the copied code (see surface.types.ts).
import type { ChatTransport } from './api';

export interface FakeTransportOptions {
  /** Multiplies every delay; 0 plays the whole scenario at once. */
  readonly pace?: number;
}

export declare const FAKE_THREAD_ID: string;
export declare const FAKE_FORK_ID: string;
export declare const createFakeTransport: (options?: FakeTransportOptions) => ChatTransport;
