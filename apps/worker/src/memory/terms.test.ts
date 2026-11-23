import { describe, expect, it } from 'vitest';

import { chunks, normalize, queryTerms, termsOf } from './terms';

const keys = (terms: Map<string, number>): string[] => [...terms.keys()].sort();

describe('Memory terms', () => {
  it('folds width, case, and katakana so the same word written two ways is one', () => {
    expect(normalize('ＡＢＣ　ﾃﾆｽ　テニス')).toBe('abc てにす てにす');
  });

  it('splits Japanese into character bigrams across kanji and kana, as the design example does', () => {
    expect(keys(termsOf('東京に引っ越し'))).toEqual(['っ越', 'に引', '京', '京に', '引', '引っ', '東', '東京', '越', '越し'].sort());
  });

  it('keeps a run of letters and digits as one word, and counts repeats', () => {
    const terms = termsOf('Zoom meeting, zoom ID 123');
    expect(terms.get('zoom')).toBe(2);
    expect(terms.get('123')).toBe(1);
    expect(terms.has('zo')).toBe(false);
  });

  it('indexes a lone kanji, so a one-character word is found', () => {
    expect(termsOf('猫が好き').has('猫')).toBe(true);
    expect(queryTerms('猫')).toEqual(['猫']);
  });

  it('asks with bigrams only, so 東京 does not match everything with 東 in it', () => {
    expect(queryTerms('東京の予定')).toEqual(['東京', '京の', 'の予', '予定']);
  });

  it('ignores punctuation and spaces between words', () => {
    expect(keys(termsOf('「和食」、好き。'))).toEqual(['和', '和食', '好', '好き', '食'].sort());
  });

  it('has no terms for empty or punctuation-only words', () => {
    expect(termsOf('').size).toBe(0);
    expect(queryTerms('、。！')).toEqual([]);
  });

  it('splits a list into pieces D1 can bind in one query', () => {
    const list = Array.from({ length: 200 }, (_, index) => index);
    expect(chunks(list, 90).map((piece) => piece.length)).toEqual([90, 90, 20]);
    expect(chunks([], 90)).toEqual([]);
  });
});
