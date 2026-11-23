// OrangeAgent: math is not rendered (remark-math and KaTeX are cut), so no text is a formula and
// the composer never holds `$…$` back from mentions.
export function markdownMathRanges(_source: string): Array<{
  start: number;
  end: number;
  source: string;
  tex: string;
  display: boolean;
  inTable: boolean;
}> {
  return [];
}
