import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fragmentsOf, occurring, sourceText, trimCatalog } from './vite';

const translations = path.join(import.meta.dirname, 'src', 'web', 'i18n', 'translations');
const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(translations, name), 'utf8')) as Record<string, unknown>;

describe('the Japanese catalog the chat ships', () => {
  it('finds in one pass every pattern a text holds, as a search for each would', () => {
    const text = 'abracadabra, she said; abc and cab';
    const patterns = ['abra', 'cad', 'bra,', 'she', 'he said', 'abc', 'cab', 'dab', 'zebra', 'a', 'said; abc and cab!', 'ab'];
    expect(occurring(text, patterns)).toEqual(new Set(patterns.filter((pattern) => text.includes(pattern))));
  });

  it('keeps an entry whose English the sources write, as a string, as JSX with entities, or with ICU\'s doubled apostrophe, and drops the rest', () => {
    const english = {
      kept: 'Waiting for approval',
      jsx: ['Couldn\'t load output: ', { i: 1, k: '_gt_value_1', v: 'v' }],
      icu: "Open ''{name}''",
      dropped: 'Fetch base branch',
      partly: ['Clone ', { i: 1, k: '_gt_value_1', v: 'v' }, ' and bring the local files git does not track.'],
    };
    const japanese = { kept: '承認を待っています', jsx: ['出力を読めません: '], icu: '開く', dropped: 'ベースブランチをフェッチ', partly: ['クローン'] };
    const text = 'msg("Waiting for approval") <T>Couldn\'t load output: <Var>{e}</Var></T> gt("Open \'{name}\'") <T>Clone <Var/></T>';

    expect(Object.keys(trimCatalog(japanese, english, text))).toEqual(['kept', 'jsx', 'icu']);
    expect(fragmentsOf(english.partly)).toEqual(['Clone ', ' and bring the local files git does not track.']);
  });

  it('keeps what the chat says and drops most of t3code\'s other screens', () => {
    const japanese = read('ja.json');
    const english = read('en.json');
    const kept = trimCatalog(japanese, english, sourceText(path.join(import.meta.dirname, 'src')));
    const keysOf = (source: string): string[] => Object.keys(english).filter((key) => english[key] === source);

    for (const source of ['Waiting for approval', 'Working', 'Tool call failed', 'Completed']) {
      expect(keysOf(source).length).toBeGreaterThan(0);
      for (const key of keysOf(source)) expect(kept[key]).toBe(japanese[key]);
    }
    expect(Object.keys(kept).length).toBeLessThan(Object.keys(japanese).length / 2);
  });
});
