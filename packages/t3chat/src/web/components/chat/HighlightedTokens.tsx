// FlareChat: shell-command and JSON token highlighting is cut (it pulled in the unbash parser and
// a grammar per language). The code is shown as plain text with the same props.
export function HighlightedTokens({
  code,
  wordClassName,
}: {
  code: string;
  language: string;
  embedded?: ReadonlyArray<unknown>;
  theme: "light" | "dark";
  wordClassName?: string;
}) {
  return <span className={wordClassName}>{code}</span>;
}
