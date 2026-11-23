import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review.ts";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
