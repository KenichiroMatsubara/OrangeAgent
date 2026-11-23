import { createRelayEnvironmentDiscoveryAtoms } from "@t3tools/client-runtime/state/relayDiscovery.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayEnvironmentDiscovery: ReturnType<typeof createRelayEnvironmentDiscoveryAtoms> =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);
