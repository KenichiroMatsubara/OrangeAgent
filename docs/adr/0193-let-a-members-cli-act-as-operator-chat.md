# Let a member's CLI act as Operator Chat

A member can sign a CLI such as Claude Code into an Account for ninety days. The CLI then reaches the MCP Server as Operator Chat does: it holds the Automation Inbox's Google grant and the Account's Skills, reaches anyone, and has no Tool Grant. ADR 0152 kept the mailbox and the calendar away from every caller of the MCP Server. Access Tokens keep that rule. An Operator Token does not, because a different person is on the other end.

An Access Token is handed to an outside agent that acts on documents its operator never wrote, and nobody watches its reasoning. An Operator Token is held by a member of the Account who has signed in with Google. That member could already read the same mail and send the same messages in Operator Chat. Their own CLI decides each step as Operator Chat's administrator does, and Claude Code asks before it calls a tool. So the boundary that matters is who holds the credential, not which entrance it reaches. The Token is therefore bound to that member's Identity, and their membership is checked on every call.

The CLI is admitted by a Login Code that the signed-in member is shown and exchanges once. The Token itself is never shown on a screen.

## Considered Options

- **A key in the request URL.** The MCP authorization specification forbids an access token in a URL, and logs and referrers copy URLs.
- **The full MCP OAuth flow** (protected-resource metadata, dynamic client registration, PKCE). This is the standard, and Claude Code follows it by itself. It needs an authorization server built in front of the identity-only Google login. A Login Code gets the same outcome with one table and two routes, and it can be replaced by that flow later without changing the Token.
- **Mail as drafts only.** Rejected because the same member already sends from Operator Chat, so a narrower CLI would protect against no one.
- **A sliding expiry like the browser session.** Rejected so that a CLI left signed in on a forgotten machine stops working on a date someone can see.
