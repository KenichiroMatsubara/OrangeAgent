// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SignedOutEntry } from './entry';

describe('signed-out application entry', () => {
  it('offers one way in, signing in with Google, with no separate Account creation', () => {
    const markup = renderToStaticMarkup(
      <SignedOutEntry busy={false} error="" onSignIn={vi.fn()} />,
    );

    expect(markup).toContain('Google でログイン');
    expect(markup).not.toContain('新しいAccountを作る');
    expect(markup).not.toContain('組織');
  });
});
