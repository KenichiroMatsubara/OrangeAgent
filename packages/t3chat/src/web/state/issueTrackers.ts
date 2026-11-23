import { createIssueTrackerEnvironmentAtoms } from "@t3tools/client-runtime/state/issueTrackers.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const issueTrackerEnvironment = createIssueTrackerEnvironmentAtoms(connectionAtomRuntime);
