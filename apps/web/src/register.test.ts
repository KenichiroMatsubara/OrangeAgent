import { describe, expect, it } from 'vitest';

import { destinationOf, reloadTarget } from './register';

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('where a navigation that lets a new release take over goes', () => {
  it('is the screen a navigation is loading, with its query and fragment', () => {
    expect(destinationOf({ location: at('/chat'), navigation: { state: 'loading', location: at('/home', '?tab=1', '#x') } }, '/chat')).toBe('/home?tab=1#x');
  });

  it('is the screen a navigation landed on without loading anything, and nothing while the screen stays', () => {
    expect(destinationOf({ location: at('/more'), navigation: { state: 'idle' } }, '/chat')).toBe('/more');
    expect(destinationOf({ location: at('/chat'), navigation: { state: 'idle' } }, '/chat')).toBeNull();
    expect(destinationOf({ location: at('/chat'), navigation: { state: 'submitting' } }, '/chat')).toBeNull();
    expect(reloadTarget(at('/chat/thread-1', '?a=1'))).toBe('/chat/thread-1?a=1');
  });
});
