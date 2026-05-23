# manifest.json — Format Choice Notes

## Which discovery format was used, and why

`manifest.json` follows the **MCP Server Card** schema proposed in SEP-2127 (the evolution of
SEP-1649), tracked at https://modelcontextprotocol.io/community/server-card/charter and
https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127.

As of May 2026 this is a Working Group draft — not yet merged into the core spec — but it
has the broadest client momentum (Anthropic, GitHub, and others implementing it) and is the
format explicitly recommended by the Server Card Working Group led by Anthropic.

### The three options considered

| Option | Path | Status |
|--------|------|--------|
| **Server Card (SEP-2127)** | `/.well-known/mcp/server-card.json` | WG draft, highest adoption momentum |
| SEP-1960 discovery endpoint | `/.well-known/mcp` | Enumeration-focused, lower metadata richness |
| MCP Registry `server.json` | Registry submission only | No self-hosted discovery |

**We chose the Server Card format** because:

1. It is the richest pre-connection metadata format — tools list, auth info, transport, and
   human-readable fields in one document.
2. The Registry WG explicitly coordinates with the Server Card WG to keep `server.json` a
   superset, so this manifest can be submitted to the MCP Registry with minimal changes.
3. Clients that implement SEP-1960 endpoint enumeration will point to the same
   `server-card.json` URL anyway.

### Where to serve this file

Host this file at:

```
https://mcp.calming-paws.com/.well-known/mcp/server-card.json
```

Also serve it at the legacy path for broader compat:

```
https://mcp.calming-paws.com/.well-known/mcp.json
```

Both paths should return `Content-Type: application/json` with permissive CORS
(`Access-Control-Allow-Origin: *`).

### Transport field

The spec uses `"streamable-http"` as the canonical transport name (matching the
2025-03-26 MCP spec and forward-compatible with 2025-11-25). Claude Code also
accepts `"http"` as an alias.

### Auth notes

OAuth 2.1 with mandatory PKCE is required for all HTTP transports per the 2025-03-26 spec
update. `dynamicClientRegistration: true` signals that clients can self-register per
RFC 7591, eliminating the need to distribute a static client ID.

Protected resource metadata is served at `/.well-known/oauth-protected-resource` (RFC 9728),
which Claude Code and Claude Desktop use to auto-discover the authorization server.
