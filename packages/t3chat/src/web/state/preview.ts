import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
