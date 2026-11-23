import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests.ts";

import { sourceControlClients } from "./sourceControlClients.ts";

export {
  threadPullRequestSearchTerms,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests.ts";
export {
  pullRequestListLines,
  type PullRequestListLine,
  type ThreadCurrentPullRequest,
  type ThreadPullRequestBadge,
  type ThreadPullRequestChain,
} from "@t3tools/source-control-core/shared/threadPullRequests.ts";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadCurrentPullRequest,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  resolveThreadPullRequestBadge,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlClients);
