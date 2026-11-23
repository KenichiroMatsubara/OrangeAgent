// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { automationSwitch, executionMode, named, runStatus, suppressionWindow, trigger, word } from './labels';

describe('words for stored values', () => {
  it('names a stored value in Japanese with the tone it is shown in', () => {
    expect(named(runStatus, 'pending_approval')).toEqual({ label: '承認待ち', tone: 'warn' });
    expect(named(executionMode, 'unattended').label).toBe('自動で実行');
    expect(word(suppressionWindow, 'day')).toBe('1日');
    expect(automationSwitch(true)).toEqual({ label: 'オン', tone: 'brand' });
    expect(automationSwitch(false)).toEqual({ label: 'オフ', tone: 'muted' });
    expect(word(trigger, 'schedule')).toBe('決まった時刻に');
  });

  it('shows a value the table does not know yet as it is, rather than hiding it', () => {
    expect(named(runStatus, 'paused')).toEqual({ label: 'paused', tone: 'neutral' });
    expect(word(suppressionWindow, 'month')).toBe('month');
  });
});
