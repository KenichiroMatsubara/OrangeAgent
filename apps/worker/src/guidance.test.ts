import { describe, expect, it } from 'vitest';
import { guidance } from './guidance';

describe('guidance', () => {
  it('answers in the language of the member\'s own words, never in that of FlareChat\'s English notes', () => {
    const told = guidance('');
    expect(told).toContain('Answer in the language of the member\'s own words');
    expect(told).toContain('a note FlareChat adds in brackets such as [FlareChat: …]');
    expect(told).toContain('when the member writes in Japanese, answer in Japanese.');
  });
});
