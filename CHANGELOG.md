# Changelog

All notable changes to Shadow Reactivity Coach are documented here.

## [2.1.5] - 2026-05-22 — All handlers wired + resources + transport polish

Closes every code-level item on the v2.1 UAT punchlist. No mock data
remains in any tool handler. MCP `resources` capability ships. Tool
`outputSchema` declarations land. Path routing moves from inline `if`
ladders to a small zero-dep `ROUTES` table.

### Data plane (the last two handlers)

- **`get_dog_profile` wired to Supabase.** Reads `dog_profiles` +
  embedded `dog_triggers` via the caller's JWT — RLS handles authz. The
  MCP `DogProfile` contract has three fields the schema doesn't yet
  model (`weight_kg`, `reactivity_type`, `active_protocols`); these are
  returned as safe defaults (`0`, `"mixed"`, `[]`) with inline
  `TODO (schema)` comments. Derived fields: `age_years` from
  `age_months → age → birthday`; `current_risk_level` from max trigger
  severity; `known_threshold_distance_feet` from min trigger
  `distance_threshold` (m → ft); `primary_triggers` from top-5 by severity.
- **`recommend_protocol` wired to Supabase.** Fetches dog profile +
  triggers, plus a tolerant last-14-days walk-log scan for recent
  setbacks. Existing protocol-selection logic is unchanged; inputs are
  now real. Force-free guardrail still short-circuits before any DB call.
  Breed-aware equipment hints (front-clip harness for known puller breeds);
  treat hints lift from owner notes when present. Zero-trigger dogs still
  receive a protocol (coaching note acknowledges sparse data).
- **12 new tests** added (`get_dog_profile_test.ts` × 6 +
  `recommend_protocol_test.ts` × 6). Total test count: 49 across 7 files.

### MCP resources capability

- **`resources/list` + `resources/read` dispatched** in `index.ts`. The
  `resources` capability flag flips to `true` in both
  `InitializeResult.capabilities` and `mcp/manifest.json`.
- **`resources.ts`** embeds the full SKILL.md content as a TS template
  literal constant (`SKILL_MD`), exports `SKILL_MD_VERSION` (mirrors
  CHANGELOG), `SKILL_MD_URI = "shadow://skill/SKILL.md"`, a `RESOURCE_LIST`
  catalog, and `readResource(uri)` returning the `{ contents }` shape
  the MCP spec defines. Self-contained — no runtime filesystem access
  needed in production.
- Unknown URIs return `RPC_INVALID_PARAMS` with a descriptive message.

### Tool outputSchema (5/5)

- `outputSchema` field added to every tool in `manifest.ts`, draft-07
  compatible, `additionalProperties: false`, matching each handler's
  TypeScript return interface. Forward-compatible with MCP 2025-06-18+
  clients; older clients ignore it.

### Transport polish

- **Zero-dep `ROUTES` table** replaces the inline path-matching `if`
  ladder in `handleRequest`. Each route is a `{ method, path, handler }`
  triple; tail-anchored matching works under Supabase's
  `/functions/v1/shadow-coach` prefix or a bare-domain mount. Every prior
  observable behavior is preserved: CORS preflight, 401 +
  `WWW-Authenticate` on unauthenticated GET, 405 on authenticated GET,
  DELETE session teardown, the full POST JSON-RPC dispatch.
- **`serverInfo.version`** bumped to `2.1.5` in both
  `InitializeResult` and `manifest.json`.

### Discovery + onboarding

- **`mcp/examples/`** added: `README.md` (typical flow), `curl-recipes.sh`
  (10 numbered copy-paste blocks covering session init, tools/list,
  resources/list, resources/read, lookup_breed, auth_required denial,
  authenticated get_dog_profile, log_walk, force-free guardrail trip,
  session teardown), `inspector.md` (running
  `@modelcontextprotocol/inspector` against the local server).
- **Badges** added to repo-root `README.md` and `mcp/README.md`:
  license, skill version, MCP server version, MCP spec, test count.

### Schema notes (recorded for the Calming Paws app team)

Three columns / tables would let `get_dog_profile` drop its current
defaults:

- `dog_profiles.weight_kg` (numeric)
- `dog_profiles.reactivity_type` (enum or text)
- An `active_protocols` representation (array column or join table)

Out of scope for the MCP server; logged here so the app team can add them.

## [2.1.4] - 2026-05-22 — First real tool + persistent state

Two big pieces of the should-fix backlog land in one pass: a vertical slice
of real data, and persistent session + rate-limit state.

### Data plane (vertical slice)

- **`log_walk` wired to Supabase `walk_logs` + `walk_triggers`.** The tool
  now performs a real INSERT against the project's Postgres schema using
  the calling user's JWT (forwarded to PostgREST). Authz is fully delegated
  to existing RLS policies (`is_owner_of_dog`) — the MCP server does not
  query `dog_profiles.owner_id` itself. Client-generated UUIDs are used
  to avoid the `.select().single()`-after-insert RLS race. The walk-level
  `threshold_score` from the MCP contract is stored as `severity` on every
  generated `walk_triggers` row (the schema has no walk-level severity
  column).
- **`get_progress` wired to a real `walk_logs` JOIN `walk_triggers`
  aggregation** over the requested window (`7d` / `30d` / `90d`). Computes
  total sessions, avg threshold score, improving/stable/worsening trend
  (half-vs-half delta ≥ 0.5), top-3 most challenging triggers, best
  trigger, and a per-ISO-week breakdown. `threshold_distance_change_pct`
  is `0` for v1 with a TODO until `dog_triggers.distance_threshold` is
  surfaced.
- **`AuthContext.bearer_token`** added — populated on OAuth and BYO JWT
  paths so tool handlers can forward the verified JWT to Supabase.
- **`db.ts`** — `makeUserClient(jwt)` factory. Uses the **anon** key (not
  service-role) so RLS does the gating. Service-role usage is explicitly
  documented as forbidden in this layer.
- **Error mapping.** Raw Postgres errors are never returned to MCP
  callers. Mapped to four safe codes (`permission_denied`, `not_found`,
  `upstream_error`, `internal_error`) with operator-only logging via
  `console.error`.
- **9 new tests** added (5 `log_walk_test.ts` + 4 `get_progress_test.ts`)
  covering force-free guardrail, happy path, empty triggers, RLS denial,
  missing bearer token, trend detection, and window scoping. All pass
  under Deno 2.x with stubbed Supabase clients.
- **`.env.example`** now has a `SUPABASE_URL` + `SUPABASE_ANON_KEY`
  block with a "do not use service-role key" warning.

### Storage layer

- **`kv.ts`** — new `KvStore` abstraction with two implementations:
  `DenoKvStore` (atomic CAS-loop counters + Deno KV TTLs) and
  `InMemoryKvStore` (the previous behavior). `pickKvStore()` probes
  `Deno.openKv` at boot, falls back to in-memory with a `console.warn`
  if KV is unavailable (some Supabase Edge Function runtimes still
  don't ship Deno KV). One singleton `kv` Promise is shared across
  the module.
- **`sessions` Map removed** from `index.ts`. The three call sites
  (set on initialize, delete on session end, has-check on dispatch) now
  go through `kv.setSession` / `kv.deleteSession` / `kv.hasSession`.
  Sessions get a 24h TTL.
- **`ratelimit.ts`** rewritten to be async + atomic. `checkRateLimit`
  is now `async (kind, key) => Promise<RateLimitResult>`. The
  read-then-write race in the in-memory version is gone because the
  windowed counter is incremented inside the KV store's atomic
  operation. Public shape (`RateLimitResult`, `getClientIP`) unchanged.
- **5 new ratelimit tests** + the 3 pre-existing tests updated to `await`
  (7 total). Covers bucket isolation, window rollover, session TTL
  expiry, and concurrent-increment safety on the in-memory impl. An opt-in
  `KV_TEST=1` integration suite for `DenoKvStore` is flagged as TODO.

### Caller updates

- `dispatchToolCall` in `index.ts` already `async`; one `await` added at
  the `checkRateLimit` call site.

## [2.1.3] - 2026-05-22 — Drift cleanup + CI guard

Third pass on the UAT findings. Closes the residual drift the v2.1.1+v2.1.2
patches left behind, adds a CI guard so it can't regress.

- **Legacy scope cleanup.** `tools-schema.md` (4 spots) and `oauth-flow.md`
  example URL no longer reference `dogs:read` / `coaching:read`. All four
  contract files now agree on `profile:read` / `walks:write` /
  `progress:read` / `protocols:read` (+ `shadow:all` BYO-JWT wildcard).
- **CORS spec alignment.** `Access-Control-Allow-Headers` in `index.ts` now
  lists `MCP-Protocol-Version` — spec-compliant clients send this header on
  every request and were being CORS-blocked.
- **Server version aligned.** `InitializeResult.serverInfo.version` bumped
  to `2.1.2` to match `manifest.json` (was `2.1.0`).
- **Protocol version strings unified.** `mcp/README.md` (was `2025-06-18`),
  `install.md` (was `2025-11-25`), and `manifest.notes.md` (was `2025-11-25`)
  now consistently say `2025-03-26` with explicit "tracking 2025-11-25
  RFC 9728/8707 adoption" language.
- **Unsafe `ALLOWED_AUDIENCE` default removed.** `.env.example` and
  `edge-function/README.md` no longer tell operators to set
  `ALLOWED_AUDIENCE="authenticated"` — that value would re-open the
  confused-deputy hole v2.1.2 fail-closed against. New default is
  `https://mcp.calming-paws.com` with an inline RFC 8707 warning.
- **Duplicated CHANGELOG paragraph at 2.1.1 deduplicated.**
- **CI drift guard added.** `scripts/check-mcp-drift.ts` (Deno) +
  `.github/workflows/mcp-drift.yml` fail PRs that re-introduce legacy
  scopes, server-name / protocol-version drift across the four contract
  files, missing `MCP-Protocol-Version` in CORS, or unsafe
  `ALLOWED_AUDIENCE` defaults.

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
