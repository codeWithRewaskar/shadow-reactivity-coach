# Shadow MCP Server — Edge Function

MCP server for [Shadow](https://calming-paws.com/), the reactive-dog training coach
built on Calming Paws. Deployed as a Supabase Edge Function (Deno runtime).

**MCP spec version targeted:** 2025-03-26 (Streamable HTTP transport)

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) v1.170+ — `brew install supabase/tap/supabase`
- [Deno](https://deno.com/) 2.0–2.2.x (Supabase Edge Runtime currently requires lockfile v4; Deno 2.3+ uses v5)
- A Supabase project (create at https://app.supabase.com/)

---

## Local development

### 1. Copy the env template

```bash
cp .env.example .env.local
# Edit .env.local — fill in SUPABASE_JWT_SECRET, JWKS_URL, ALLOWED_ISSUER, etc.
```

### 2. Start the local function server

```bash
supabase functions serve shadow-coach --env-file .env.local
```

The function will be available at `http://localhost:54321/functions/v1/shadow-coach`.

### 3. Run the test suite

```bash
deno test --allow-env lookup_breed_test.ts
```

Or using the deno.json task:

```bash
deno task test
```

---

## Quick smoke tests with curl

### Demo mode — no auth (only `lookup_breed` works)

#### 1. Initialize a session

```bash
curl -s -D - -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "clientInfo": { "name": "curl-test", "version": "1.0" },
      "capabilities": {}
    }
  }'
```

Copy the `Mcp-Session-Id` value from the response headers. Use it in all subsequent requests.

#### 2. List tools

```bash
SESSION_ID="<paste session id here>"

curl -s -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }' | jq .
```

#### 3. Call `lookup_breed` (public, no auth needed)

```bash
curl -s -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "lookup_breed",
      "arguments": { "breed": "Labrador Retriever" }
    }
  }' | jq '.result.content[0].text | fromjson'
```

#### 4. Try an auth-required tool in demo mode (should return auth_required error)

```bash
curl -s -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "get_dog_profile",
      "arguments": { "dog_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
    }
  }' | jq '.result.content[0].text | fromjson'
```

Expected: `{ "code": "auth_required", "message": "...", "cta": "https://calming-paws.com/" }`

### Authenticated mode — with a Supabase JWT

```bash
TOKEN="<supabase access token from your app>"

curl -s -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "get_dog_profile",
      "arguments": { "dog_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
    }
  }' | jq '.result.content[0].text | fromjson'
```

### Test the force-free guardrail

```bash
curl -s -X POST http://localhost:54321/functions/v1/shadow-coach \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "log_walk",
      "arguments": {
        "dog_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "triggers": ["other dogs"],
        "threshold_score": 3,
        "notes": "Used a shock collar to correct the barking"
      }
    }
  }' | jq '.result.content[0].text | fromjson'
```

Expected: `{ "code": "force_free_violation", "message": "..." }`

---

## Deploy to Supabase

### Link your project

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

### Set secrets (do not commit these)

```bash
supabase secrets set SUPABASE_JWT_SECRET="your-jwt-secret"
supabase secrets set JWKS_URL="https://<project-ref>.supabase.co/auth/v1/jwks"
supabase secrets set ALLOWED_AUDIENCE="https://mcp.calming-paws.com"  # NOT "authenticated" — that allows any Supabase user JWT (RFC 8707 confused-deputy risk)
supabase secrets set ALLOWED_ISSUER="https://<project-ref>.supabase.co/auth/v1"
supabase secrets set ALLOWED_ORIGINS="https://calming-paws.com"
# Optional: for BYO JWT server-to-server integrations
supabase secrets set BYO_JWT_SECRET="your-service-token-secret"
```

### Deploy

```bash
supabase functions deploy shadow-coach --project-ref <your-project-ref>
```

The function will be live at:
`https://<project-ref>.supabase.co/functions/v1/shadow-coach`

For production, configure a custom domain to point `mcp.calming-paws.com` at this URL.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes | HS256 secret from Supabase project dashboard (Settings > API > JWT Secret). Used to verify tokens from Supabase Auth. |
| `JWKS_URL` | For OAuth RS256/ES256 | JWKS endpoint URL. For Supabase: `https://<ref>.supabase.co/auth/v1/jwks` |
| `ALLOWED_AUDIENCE` | Yes | Expected `aud` claim. MUST be the MCP server's own audience (e.g. `https://mcp.calming-paws.com`), NOT Supabase's `"authenticated"` (RFC 8707 confused-deputy risk). Server fails closed if unset on OAuth path. |
| `ALLOWED_ISSUER` | Yes | Expected `iss` claim. Example: `https://<ref>.supabase.co/auth/v1` |
| `BYO_JWT_SECRET` | No | HS256 secret for long-lived service tokens. Leave blank to disable BYO JWT path. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins. Example: `https://calming-paws.com` |
| `DEMO_RATE_LIMIT_PER_HOUR` | No | Max requests/hour per IP in demo mode. Default: `20` |
| `AUTH_RATE_LIMIT_PER_HOUR` | No | Max requests/hour per authenticated user. Default: `200` |

---

## Architecture notes

### Auth flow

```
Request arrives
      │
      ├─ No Authorization header  → Demo mode (only lookup_breed works)
      │
      ├─ Bearer token, HS256, BYO_JWT_SECRET set  → BYO JWT path
      │    └─ Verifies with BYO_JWT_SECRET, checks exp
      │
      └─ Bearer token, HS256, no BYO_JWT_SECRET  → Supabase JWT path
           └─ Verifies with SUPABASE_JWT_SECRET, checks aud/iss/exp
           
      Bearer token, RS256/ES256  → OAuth 2.1 JWKS path
           └─ Fetches JWKS, verifies signature, checks aud/iss/exp
```

### Session + rate-limit storage (KvStore)

As of v2.1.4 both session lookup and rate-limit counters go through the
`KvStore` abstraction in `kv.ts`. `pickKvStore()` runs once at module
load:

- If `Deno.openKv()` is available (Deno Deploy, recent Deno standalone), uses
  `DenoKvStore` with native TTL on sessions and a CAS-loop atomic increment
  on counters — survives cold starts and works across instances.
- Otherwise (some Supabase Edge Function runtimes), falls back to
  `InMemoryKvStore` with a one-shot `console.warn`. Limits and sessions
  are then per-instance and reset on cold start.

The contract: `KvStore.setSession`, `KvStore.hasSession`, `KvStore.deleteSession`,
`KvStore.incrementCounter(namespace, key, ttlMs)`. To swap to Upstash Redis
later, add an `UpstashKvStore` class and extend `pickKvStore` — no caller changes.

`checkRateLimit(kind, key)` is now `async` (was sync in v2.1.3 and earlier).

### Real data vs mock — current status

| Tool | Status |
|---|---|
| `lookup_breed` | Reads the bundled 20-breed knowledge base (never needed a DB) |
| `log_walk` | **Real** — INSERTs into `walk_logs` + `walk_triggers` via user JWT (RLS-gated) |
| `get_progress` | **Real** — SELECTs `walk_logs` JOIN `walk_triggers` for the window, aggregates in-process |
| `get_dog_profile` | Mock — wire to `dog_profiles` SELECT next |
| `recommend_protocol` | Mock — wire after `get_dog_profile` so it can read the live profile |

Tool handlers use the **anon** Supabase key (set via `SUPABASE_URL` +
`SUPABASE_ANON_KEY`) combined with the caller's forwarded JWT — RLS does the
authz. The service-role key is **not** used in this layer (it would bypass
RLS and break the user-scoped model). See `db.ts:makeUserClient` for the
pattern. Wire remaining mock handlers by copying that pattern and mapping the
MCP-tool param names to schema column names per the Supabase schema doc.

---

## File structure

```
mcp/edge-function/
├── index.ts              # MCP Streamable HTTP entry point (Deno.serve)
├── auth.ts               # Auth middleware: demo / OAuth 2.1 / BYO JWT
├── kv.ts                 # KvStore (Deno KV + in-memory fallback) — sessions + counters
├── ratelimit.ts          # Async rate limiting on top of KvStore
├── db.ts                 # Supabase client factory (user-JWT + anon key, RLS-gated)
├── manifest.ts           # Tool definitions (tools/list response)
├── tools/
│   ├── lookup_breed.ts       # Public: breed profile lookup
│   ├── get_dog_profile.ts    # Auth: dog profile retrieval (mock)
│   ├── log_walk.ts           # Auth+force-free: walk session logging (real Supabase)
│   ├── get_progress.ts       # Auth: progress trend analytics (real Supabase)
│   └── recommend_protocol.ts # Auth+force-free: protocol recommendation (mock)
├── auth_test.ts          # 9 tests — demo/BYO/OAuth paths, fail-closed envs
├── ratelimit_test.ts     # 7 tests — bucket isolation, windows, session TTL
├── lookup_breed_test.ts  # 12 tests
├── log_walk_test.ts      # 5 tests — guardrail, happy path, RLS denial, missing token
├── get_progress_test.ts  # 4 tests — empty, improving trend, window, RLS
├── deno.json             # Import map + dev/test tasks
├── .env.example          # Env var template (no secrets)
└── README.md             # This file
```
