// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { claudeCodeCommand, exchangeCommand, LoginCodeNotice } from './cli';

describe('Login Code', () => {
  const issued = {
    code: 'K7QF-2M9X',
    expiresAt: '2026-10-25T01:10:00.000Z',
    exchangeUrl: 'https://flarechat.example.workers.dev/api/public/organizations/org-1/operator-tokens',
    serverUrl: 'https://flarechat.example.workers.dev/api/public/organizations/org-1/mcp',
  };

  it('shows the code and until when it lasts, in Asia/Tokyo', () => {
    const markup = renderToStaticMarkup(<LoginCodeNotice issued={issued} />);

    expect(markup).toContain('K7QF-2M9X');
    expect(markup).toContain('10:10まで');
  });

  it('exchanges the code at the Account’s exchange URL', () => {
    expect(exchangeCommand(issued)).toBe(
      `curl -fsS -X POST -H 'Content-Type: application/json' -d '{"code":"K7QF-2M9X"}' ${issued.exchangeUrl}`,
    );
  });

  it('registers the MCP Server with Claude Code only when a token came back', () => {
    const command = claudeCodeCommand(issued);

    expect(command).toContain(exchangeCommand(issued));
    expect(command).toContain(`sed -nE 's/.*"token":"([^"]+)".*/\\1/p'`);
    expect(command).toContain('[ -n "$TOKEN" ] && claude mcp add --transport http flarechat');
    expect(command).toContain(`${issued.serverUrl} --header "Authorization: Bearer $TOKEN"`);
  });
});
