import { describe, expect, it } from 'vitest';

import { isApple, labelOf } from './push';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0';

describe('this browser in words', () => {
  it('tells an iPhone or iPad, one that calls itself a Mac included, whose every browser needs the home screen', () => {
    expect(isApple(IPHONE, 'iPhone', 5)).toBe(true);
    expect(isApple(IPAD_DESKTOP, 'MacIntel', 5)).toBe(true);
    expect(isApple(IPAD_DESKTOP, 'MacIntel', 0)).toBe(false);
    expect(isApple(ANDROID, 'Linux armv8l', 5)).toBe(false);
  });

  it('names the system and the browser', () => {
    expect(labelOf(IPHONE, true)).toBe('iPhone の Safari');
    expect(labelOf(IPAD_DESKTOP, true)).toBe('iPad の Safari');
    expect(labelOf(ANDROID, false)).toBe('Android の Chrome');
    expect(labelOf(WINDOWS_EDGE, false)).toBe('Windows の Edge');
    expect(labelOf(MAC_FIREFOX, false)).toBe('Mac の Firefox');
    expect(labelOf('Something', false)).toBe('ブラウザ');
  });
});
