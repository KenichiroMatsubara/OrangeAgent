import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/sourceControl.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);
