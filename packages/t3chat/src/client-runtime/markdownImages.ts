import {
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks.ts";

export {
  classifyMarkdownImageSource,
  type MarkdownImageSource,
} from "@t3tools/shared/markdownLinks.ts";

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}
