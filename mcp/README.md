# Shadow MCP Server

Everything needed to deploy `mcp.calming-paws.com` — the productized backend that turns the Shadow markdown skill into a live tool with personalized dog data, walk logging, and progress analytics.

## What's in this directory

| File | Purpose |
|------|---------|
| [`tools-schema.md`](./tools-schema.md) | Public contract — every tool, its inputs, returns, error codes, rate limits, and worked examples |
| [`oauth-flow.md`](./oauth-flow.md) | Auth spec — OAuth 2.1 default, BYO JWT fallback, scopes, threats, and operational guidance (targets MCP 2025-06-18) |
| [`manifest.json`](./manifest.json) | The MCP Server Card published at `/.well-known/mcp/server-card.json` |
| [`manifest.notes.md`](./manifest.notes.md) | Why we picked the Server Card format and what the trade-offs are |
| [`install.md`](./install.md) | User-facing install page (Claude Desktop, Claude Code, Cursor) — drop into the repo README or calming-paws.com |
| [`edge-function/`](./edge-function/) | Runnable Supabase Edge Function scaffold (Deno + TypeScript strict, Zod validation, mock data) |

## Read in this order

1. **`tools-schema.md`** — what the server promises to do
2. **`oauth-flow.md`** — how authentication works end-to-end
3. **`manifest.json`** + **`manifest.notes.md`** — how Claude Desktop discovers the server
4. **`edge-function/README.md`** — how to run it locally and deploy
5. **`install.md`** — what users see when adding it to Claude

## Open work before shipping

- Wire the edge function tool handlers to real Supabase tables (currently mock data)
- Stand up the OAuth 2.1 authorization server endpoints in the Calming Paws app per `oauth-flow.md`
- Confirm Anthropic's current "Add to Claude Desktop" deep-link / .mcpb format and update `install.md`
- Add a CI drift check that diffs `manifest.ts` against `tools-schema.md`
- Decide subscription gating for `get_progress` and `recommend_protocol` (currently spec'd as pro-tier)
- Pen-test demo mode rate limits before public launch

---

🐾 Powered by [Calming Paws](https://calming-paws.com/)
