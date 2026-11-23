import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections.ts";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
