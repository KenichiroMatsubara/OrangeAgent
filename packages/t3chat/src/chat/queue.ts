/**
 * How the copied QueuedRunsControl reaches OrangeAgent (OrangeAgent's own file). t3code's control sends
 * its queue commands over Effect RPC and reads a queued picture through its asset service; here it
 * reads both from this context, which ChatSurface fills from its transport.
 */
import { createContext } from 'react';

import type { ChatQueueChange } from './api.ts';

export interface QueueCommands {
  /** Changes a queued message; resolves once the change was taken, and says what it refused itself. */
  readonly change: (change: ChatQueueChange) => Promise<void>;
  /** Where a queued message's picture is read, by its id, when the transport knows. */
  readonly attachmentUrl: (id: string) => string | null;
}

const NOTHING: QueueCommands = {
  change: async () => undefined,
  attachmentUrl: () => null,
};

export const QueueContext = createContext<QueueCommands>(NOTHING);
