import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutomationTestApp, type AutomationTestApp } from '../../test/automation';
import { runBackgroundWork } from './runner';

let fixture: AutomationTestApp | undefined;

const requests = (host: string): string[] => {
  const stub = globalThis.fetch as unknown as { mock: { calls: [string][] } };
  return stub.mock.calls.map(([url]) => url).filter((url) => url.includes(host));
};

afterEach(() => {
  fixture?.close();
  fixture = undefined;
  vi.unstubAllGlobals();
});

describe('background runner', () => {
  it('reads no mail on its own: only an Automation whose time has come does', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 })));

    await runBackgroundWork(fixture.environment);

    expect(requests('gmail.googleapis.com')).toEqual([]);
    expect(fixture.account.rows('SELECT id FROM runs')).toEqual([]);
  });

  it('runs an Automation whose time has come', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    // 2026-08-01T00:00Z is 09:00 in Tokyo; the Automation was due at 05:00.
    fixture.account.execute("UPDATE automations SET next_run_at = '2026-07-31T20:00:00.000Z' WHERE id = 'automation-1'");
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '読むメールはありませんでした。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'test-model',
    }), { status: 200 })));

    await runBackgroundWork(fixture.environment);

    expect(requests('ai.example.com')).not.toEqual([]);
    expect(fixture.account.rows('SELECT trigger, automation_id FROM runs')).toEqual([{ trigger: 'schedule', automation_id: 'automation-1' }]);
  });
});
