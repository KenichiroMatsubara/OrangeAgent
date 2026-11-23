import { createMcpAppEnvironmentAtoms } from "@t3tools/client-runtime/state/mcpApps.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const mcpAppEnvironment = createMcpAppEnvironmentAtoms(connectionAtomRuntime);
