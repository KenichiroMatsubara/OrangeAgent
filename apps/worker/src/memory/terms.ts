/**
 * The keywords a memory is found by, in place of an FTS5 virtual table, which
 * D1 cannot export (ADR 0197). Text is folded first (NFKC, lower case,
 * katakana as hiragana), then a run of Japanese is cut into character bigrams
 * and a run of letters and digits is kept as one word. A memory also keeps
 * each kanji alone, so a one-character word such as 猫 is found; a query asks
 * with bigrams only, and with a lone character only where that is all a run
 * holds, so 東京 does not match every memory with 東 in it.
 */

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々〆]+/gu;
const WORD = /[\p{Script=Latin}\p{Nd}]+/gu;
const HAN = /\p{Script=Han}|[々〆]/u;

/** Katakana as hiragana: ア (U+30A2) and あ (U+3042) are 0x60 apart, through ヶ. */
const hiragana = (text: string): string =>
  text.replace(/[ァ-ヶ]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));

export const normalize = (text: string): string => hiragana(text.normalize('NFKC').toLowerCase());

const bigrams = (run: string): string[] => {
  const characters = [...run];
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
};

const count = (terms: Map<string, number>, term: string): void => {
  terms.set(term, (terms.get(term) ?? 0) + 1);
};

/** Every keyword of a memory's words, with how often it occurs. */
export const termsOf = (text: string): Map<string, number> => {
  const folded = normalize(text);
  const terms = new Map<string, number>();
  for (const [word] of folded.matchAll(WORD)) count(terms, word);
  for (const [run] of folded.matchAll(JAPANESE)) {
    const characters = [...run];
    if (characters.length === 1) {
      count(terms, run);
      continue;
    }
    for (const bigram of bigrams(run)) count(terms, bigram);
    for (const character of characters) if (HAN.test(character)) count(terms, character);
  }
  return terms;
};

/** The keywords a search asks with, each once, in the order the query holds them. */
export const queryTerms = (text: string): string[] => {
  const folded = normalize(text);
  const terms: string[] = [];
  const add = (term: string): void => {
    if (!terms.includes(term)) terms.push(term);
  };
  for (const [run] of folded.matchAll(JAPANESE)) {
    if ([...run].length === 1) add(run);
    else for (const bigram of bigrams(run)) add(bigram);
  }
  for (const [word] of folded.matchAll(WORD)) add(word);
  return terms;
};

/** A list cut into pieces of at most `size`, since D1 binds at most 100 values to one query. */
export const chunks = <T>(list: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, index * size + size));
