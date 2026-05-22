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
supabase secrets set ALLOWED_AUDIENCE="authenticated"
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
| `ALLOWED_AUDIENCE` | Yes | Expected `aud` claim. Supabase tokens use `"authenticated"`. |
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

### Rate limiting

The in-memory rate limiter in `ratelimit.ts` is intentionally ephemeral. For
production, replace it with Upstash Redis (`npm:@upstash/redis`) or a
Supabase KV store. The `checkRateLimit(kind, key)` interface stays the same.

### Mock data

All tool handlers return mock data. To wire them to real Supabase data:
1. Import `@supabase/supabase-js` via `jsr:@supabase/supabase-js@2`
2. Initialize the client with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
3. Replace the mock return values with the SQL queries documented in each handler's
   `TODO (production)` comment

---

## File structure

```
mcp/edge-function/
├── index.ts              # MCP Streamable HTTP entry point (Deno.serve)
├── auth.ts               # Auth middleware: demo / OAuth 2.1 / BYO JWT
├── ratelimit.ts          # In-memory rate limiting (swap for Redis in prod)
├── manifest.ts           # Tool definitions (tools/list response)
├── tools/
│   ├── lookup_breed.ts   # Public: breed profile lookup
│   ├── get_dog_profile.ts  # Auth: dog profile retrieval
│   ├── log_walk.ts       # Auth+force-free: walk session logging
│   ├── get_progress.ts   # Auth: progress trend analytics
│   └── recommend_protocol.ts  # Auth+force-free: protocol recommendation
├── lookup_breed_test.ts  # Deno.test suite for lookup_breed handler
├── deno.json             # Import map + dev/test tasks
├── .env.example          # Env var template (no secrets)
└── README.md             # This file
```
