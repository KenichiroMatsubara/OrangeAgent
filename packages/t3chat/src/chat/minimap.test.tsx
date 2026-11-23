import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

// t3code's i18n runs in the browser build only; Node would resolve its server entry.

import { TimelineMinimap } from '~/components/chat/TimelineMinimap';
import { I18nProvider } from '~/i18n/I18nProvider';
import { startI18n, whenLocaleReady } from '~/i18n/runtime';

afterEach(cleanup);

const items = ['一つ目', '二つ目', '三つ目'].map((text, index) => ({ id: `m-${index}`, rowIndex: index * 2, userText: text, assistantText: null }));

describe('the timeline minimap', () => {
  it('draws each message as a dot on a rail, never as a short stroke that reads as 二 or 三', async () => {
    startI18n();
    await whenLocaleReady();
    const { container } = render(
      <I18nProvider>
        <TimelineMinimap hasPersistentGutter hitStripWidth={24} currentIndex={0} atEnd={false} items={items} stripMap={new Map()} onWheel={() => undefined} onSelect={() => undefined} />
      </I18nProvider>,
    );

    expect(container.querySelectorAll('[data-minimap-rail]')).toHaveLength(1);
    const marks = [...container.querySelectorAll('[data-minimap-strip]')];
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      expect(mark.className).toMatch(/\bsize-2\.5\b/u);
      expect(mark.className).toMatch(/\brounded-full\b/u);
      expect(mark.className).not.toMatch(/\bh-0\.5\b|\bw-6\b/u);
    }
  });
});
