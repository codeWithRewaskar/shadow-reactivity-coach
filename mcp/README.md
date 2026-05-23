# Shadow MCP Server

[![License: CC-BY-4.0](https://img.shields.io/badge/License-CC--BY--4.0-lightgrey)](../LICENSE) [![Skill version](https://img.shields.io/badge/Skill-v2.1-blue)](../CHANGELOG.md) [![MCP server](https://img.shields.io/badge/MCP_server-v2.1.5-blue)](./edge-function/) [![MCP spec](https://img.shields.io/badge/MCP%20spec-2025--03--26-green)](https://modelcontextprotocol.io/specification/2025-03-26) [![tests](https://img.shields.io/badge/tests-49%20passing-brightgreen)](./edge-function/)

Everything needed to deploy `mcp.calming-paws.com` — the productized backend that turns the Shadow markdown skill into a live MCP server. Exposes 5 tools (breed lookup, dog profile, walk logging, progress analytics, protocol recommendations), a `resources/` surface that serves SKILL.md to clients on demand, OAuth 2.1 + protected-resource-metadata discovery, and per-user rate limiting — all on a single Supabase Edge Function.

## What's in this directory

| File | Purpose |
|------|---------|
| [`tools-schema.md`](./tools-schema.md) | Public contract — every tool, its inputs, returns, error codes, rate limits, and worked examples |
| [`oauth-flow.md`](./oauth-flow.md) | Auth spec — OAuth 2.1 default, BYO JWT fallback, scopes, threats, and operational guidance (targets MCP 2025-03-26; tracking 2025-11-25 RFC 9728/8707 adoption) |
| [`manifest.json`](./manifest.json) | The MCP Server Card published at `/.well-known/mcp/server-card.json` |
| [`manifest.notes.md`](./manifest.notes.md) | Why we picked the Server Card format and what the trade-offs are |
| [`install.md`](./install.md) | User-facing install page (Claude Desktop, Claude Code, Cursor) — drop into the repo README or calming-paws.com |
| [`edge-function/`](./edge-function/) | Runnable Supabase Edge Function (Deno + TypeScript strict, Zod, real `log_walk` + `get_progress` over Supabase RLS, KV-backed sessions + rate limit) |

## Read in this order

1. **`tools-schema.md`** — what the server promises to do
2. **`oauth-flow.md`** — how authentication works end-to-end
3. **`manifest.json`** + **`manifest.notes.md`** — how Claude Desktop discovers the server
4. **`edge-function/README.md`** — how to run it locally and deploy
5. **`install.md`** — what users see when adding it to Claude

## Open work before shipping

All code-level UAT items from the v2.1 review are closed. Remaining items are
operational and product decisions:

- ~~Wire all five tool handlers to real Supabase tables~~ ✅ all 5 wired:
  `lookup_breed` (bundled KB), `log_walk` + `get_progress` (v2.1.4),
  `get_dog_profile` + `recommend_protocol` (v2.1.5) — all user-JWT + RLS-gated.
- ~~Replace in-memory sessions Map and rate limiter~~ ✅ v2.1.4
  (`KvStore` abstraction with Deno KV + in-memory fallback in `kv.ts`).
- ~~Add MCP `resources` capability exposing SKILL.md~~ ✅ v2.1.5
  (`resources.ts` + `resources/list` + `resources/read`).
- ~~Add `outputSchema` per tool~~ ✅ v2.1.5 (all 5 tools, draft-07).
- ~~Path routing cleanup~~ ✅ v2.1.5 (zero-dep `ROUTES` table replacing inline ifs).
- ~~Examples directory with curl + inspector recipes~~ ✅ v2.1.5 (`mcp/examples/`).
- ~~README badges~~ ✅ v2.1.5 (license, version, spec, tests).
- ~~Confirm Anthropic's current "Add to Claude Desktop" / .mcpb format~~ ✅ v2.1.3.
- ~~Add a CI drift check~~ ✅ v2.1.3 (`scripts/check-mcp-drift.ts` + workflow).

Remaining (not code work):

- **Operational:** Stand up the OAuth 2.1 authorization server endpoints in the
  Calming Paws app per `oauth-flow.md`. The MCP server is fully ready to verify
  tokens against the issuer + audience; it just needs the app to mint them.
- **Operational:** Verify `Deno.openKv()` availability on the target Supabase
  Edge Function runtime. If unavailable, `KvStore` falls back to in-memory with
  a `console.warn`; consider adding an `UpstashKvStore` if you outgrow that.
- **Product:** Decide subscription gating for `get_progress` and
  `recommend_protocol` (currently spec'd as pro-tier).
- **Pre-launch:** Pen-test demo mode rate limits.
- **Schema (Calming Paws app):** Add `weight_kg`, `reactivity_type`, and an
  active-protocols representation to `dog_profiles` so `get_dog_profile` can
  stop returning `0` / `"mixed"` / `[]` defaults for those fields.

---

🐾 Powered by [Calming Paws](https://calming-paws.com/)
