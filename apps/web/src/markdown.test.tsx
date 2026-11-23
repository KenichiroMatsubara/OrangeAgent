import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from './markdown';

describe('Markdown', () => {
  it('names a code block by its language and copies the code alone', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<Markdown text={'見てください。\n\n```sql\nSELECT 1;\n```'} />);

    expect(screen.getByText('sql')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'コードをコピー' }));

    expect(writeText).toHaveBeenCalledWith('SELECT 1;');
    expect(await screen.findByRole('button', { name: 'コピーしました' })).toBeTruthy();
  });

  it('shows a checklist with which items are done, and strikes through text', () => {
    const markup = renderToStaticMarkup(<Markdown text={'- [x] 出欠を返信\n- [ ] 会費を振り込む\n\n~~中止~~'} />);

    expect(markup).toContain('aria-label="済み"');
    expect(markup).toContain('aria-label="未完了"');
    expect(markup).toContain('会費を振り込む');
    expect(markup).not.toContain('[ ]');
    expect(markup).toContain('<del>中止</del>');
  });
});
