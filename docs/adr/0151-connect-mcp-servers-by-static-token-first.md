# Connect MCP servers by static token first

An Account connects an MCP Server with a static bearer token or API key, stored under the Account's envelope encryption exactly as any other credential. OAuth for MCP — dynamic client registration, an authorization callback, and per-Account token refresh — is deferred.

Many hosted servers, including Cloudflare's own, are OAuth-only, so this genuinely narrows what can be connected to self-hosted servers and to services that still issue keys. It was accepted so that Operator Chat, released first to prove the Tool Grant and MCP client wiring under human observation, needed one connectable server rather than an OAuth implementation. The same holds for OrangeAgent's own MCP Server: Claude's custom connectors accept a static bearer token in a request header, so no OAuth authorization server has to be reachable from outside.
