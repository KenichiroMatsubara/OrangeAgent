# Let Claude connect by OAuth, granting an Operator Token

Claude on the web, desktop, and mobile reaches a remote MCP Server only by OAuth unless its organization has the request-header beta, so FlareChat's Worker now includes an OAuth authorization server in front of the MCP Server. An approval grants the same Operator Token a Login Code yields (ADR 0193), bound to the approving member's Identity and checked against their membership on every call. Google sign-in stays the only way a person is identified; the authorization server only records what a signed-in member approved on the authorization screen.

The grant ends ninety days after the approval, as every Operator Token does, so an app a member stopped using stops working on a date someone can see. Within them the app holds an access token for an hour and a refresh token that is replaced on every use, as OAuth 2.1 asks of a public client.

Clients register by Dynamic Client Registration (RFC 7591). A registration is sealed into the client_id itself with the deployment's credential key instead of being stored, because Claude registers a new client on every fresh connection and a stored table would only grow. Removing the key, or changing the client_id format, would make every connected app register again.

## Considered Options

- **Only the request-header beta.** It needs no authorization server, but most organizations cannot see it, everyone in a Team organization shares one member's credential, and it cannot be renewed: the connector has to be removed and added again every ninety days.
- **Client ID Metadata Documents instead of registration.** Claude recommends it and it stores nothing either, but it makes the Worker fetch a URL a client names. Registration was chosen; a client_id that is a URL can be accepted beside it later.
- **A sliding grant renewed by every refresh.** Rejected for the same reason ADR 0193 rejected one for the CLI.
- **A table of registered clients.** It allows revoking a client, but approvals are revoked per grant on 接続, and the table would grow with every connection.
