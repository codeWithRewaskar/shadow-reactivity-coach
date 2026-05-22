# Changelog

All notable changes to Shadow Reactivity Coach are documented here.

## [2.1.2] - 2026-05-22 — MCP hardening + tests

Second pass on the UAT findings. No breaking changes to the wire contract;
this patch closes security defaults, fixes a latent DER parser bug, and adds
test coverage for the auth and rate-limit layers.

- **Fail-closed auth defaults.** `ALLOWED_AUDIENCE` and `ALLOWED_ISSUER` are
  now required env vars. Previous defaults (`"authenticated"` / `""`) silently
  accepted any Supabase user JWT for any project — a confused-deputy hole per
  RFC 8707 §1. Boot-time misconfig now throws `auth_invalid`.
- **OAuth host mismatch resolved.** `manifest.json` no longer hardcodes
  non-existent `calming-paws.com/oauth/*` URLs. Endpoints point at the
  deployment's Supabase project (`<project-ref>.supabase.co/auth/v1/*`) with an
  inline `_comment` directing deployers to substitute the project ref; spec
  clients should prefer `protectedResourceMetadata` discovery anyway.
- **JWKS cache TTL + key-rotation refresh.** JWKS is now cached for
  `JWKS_CACHE_TTL_SECONDS` (default 600s) instead of forever. On a `kid` cache
  miss the cache is force-refreshed once before failing — survives provider
  key rotation without restart.
- **`derToRaw` bounds-checked.** ECDSA DER parser now handles long-form length
  bytes (0x81 / 0x82) and validates r/s lengths against buffer size before
  slicing — previously could read past the end on malformed sigs.
- **TS typing fix.** `crypto.subtle.verify` calls cast `Uint8Array` arguments
  to `BufferSource`, removing the long-standing TypeScript error in `auth.ts`.
- **Tests added.** `auth_test.ts` covers demo, BYO JWT happy/expired/scope-missing,
  OAuth happy path, wrong-audience rejection, fail-closed misconfig, and Bearer
  scheme enforcement. `ratelimit_test.ts` covers the demo/auth bucket isolation
  and `getClientIP` precedence.
- **Mock-data callout in `install.md`.** Deployers are now warned upfront that
  tool handlers return illustrative responses and must be wired to a real
  backend before production use.

## [2.1.1] - 2026-05-22 — MCP contract alignment

Bridges four breaking contract gaps in the MCP server scaffold:

Bridges four breaking contract gaps in the MCP server scaffold:

- **Single scope vocabulary** across `manifest.json`, `manifest.ts`, `auth.ts`,
  and `oauth-flow.md`: `profile:read`, `walks:write`, `progress:read`,
  `protocols:read` (with `shadow:all` as the BYO-JWT wildcard).
  `OAUTH_TOOL_SCOPES` is now `Record<string, string[]>` and requires *all*
  listed scopes per tool.
- **Server identity unified** to `shadow-coach` v2.1.0 across
  `InitializeResult.serverInfo`, `deno.json` task, README curl examples, and
  log prefixes (previously split across `shadow-mcp` v1.0.0 and
  `shadow-coach` v2.1.0).
- **Protocol version unified** to `2025-03-26` in both the server's
  `InitializeResult` and `oauth-flow.md` (the 06-18 doc made promises —
  PRM, RFC 8707 resource indicators — the server did not yet keep).
- **Protected Resource Metadata + 401 discovery hint**:
  `GET /.well-known/oauth-protected-resource` returns the RFC 9728
  document, and auth failures (plus unauthenticated GETs) now emit
  `WWW-Authenticate: Bearer resource_metadata="…"` so spec-compliant MCP
  clients can discover the authorization server automatically.

## [2.1] - 2026-05-22

### Added
- Standalone SKILL.md for use in Claude, ChatGPT, and MCP without the Calming Paws app
- 10 example conversations demonstrating Shadow in action
- README with 3 install paths (Claude, ChatGPT, MCP)
- CC-BY-4.0 license for open knowledge sharing

### Changed
- Expanded breed knowledge base to 20 breed profiles with full reactivity-type breakdowns
- Enhanced RAG synonym map with 40+ colloquial phrase expansions (e.g. "goes crazy on leash" maps to barrier frustration)
- Improved three-type reactivity framework with diagnostic shortcuts and recovery time data

## [2.0] - 2026-04-15

### Added
- Three-type reactivity framework (fear / frustration / excitement) across all knowledge topics
- Breed-specific knowledge base: 20 breeds with reactivity profiles, training nuances, and threshold notes
- `get_breed_knowledge` tool for breed-aware personalisation
- Synonym-aware RAG scoring with multi-word phrase matching
- Frustration vs fear vs excitement identification topic with full diagnostic guide
- Cortisol vacation and nervous system reset topic
- Puppy prevention and socialisation topic
- 6 new breed profiles: Shetland Sheepdog, Australian Cattle Dog, Vizsla, French Bulldog, Poodle, Corgi

### Changed
- RAG pipeline moved server-side to Supabase edge function
- Knowledge base refactored into shared module (`knowledgeBase.ts`) imported by edge functions
- System prompt updated with breed-awareness rules and tool usage guidelines
- Guardrails strengthened with regex-based hard blocks for aversive and medical queries

## [1.0] - 2026-02-01

### Added
- Initial Shadow companion with 12 training knowledge topics
- System prompt with force-free-only rules and risk escalation
- RAG pipeline with keyword-based scoring
- 5 tools: `lookup_training_knowledge`, `get_recommended_exercises`, `get_dog_context`, `check_safety_level`, `get_training_resources`
- Floating chat UI with quick prompts and typing indicator
- Safety mode mapping (green/yellow/orange/red) based on risk level
- Guardrail footer on all responses
