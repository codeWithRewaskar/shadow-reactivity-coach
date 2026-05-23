# Shadow MCP Server — OAuth Authentication Spec

**Document version:** 1.0  
**MCP spec targeted:** [2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
**OAuth draft targeted:** [draft-ietf-oauth-v2-1-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)  
**Backend assumption:** Calming Paws is built on [Supabase](https://supabase.com/), which provides a compliant OAuth 2.1 authorization server, JWKS endpoint, dynamic client registration, and RS256/ES256 JWT issuance out of the box. Supabase's auth base URL for the project is `https://<project-ref>.supabase.co/auth/v1`. All references below to the authorization server point at that base URL. If the backend is ever migrated off Supabase, every endpoint listed here must be re-verified; the trust model does not change, only the host.

---

## Table of Contents

1. [Auth Modes Overview](#1-auth-modes-overview)
2. [OAuth 2.1 Endpoints](#2-oauth-21-endpoints)
3. [Scopes and Consent](#3-scopes-and-consent)
4. [End-to-End Flow — Sequence Diagram](#4-end-to-end-flow--sequence-diagram)
5. [Token Lifecycle](#5-token-lifecycle)
6. [BYO JWT Fallback](#6-byo-jwt-fallback)
7. [Security Threats and Mitigations](#7-security-threats-and-mitigations)
8. [Subscription Tier Enforcement](#8-subscription-tier-enforcement)
9. [Operational Concerns](#9-operational-concerns)

---

## 1. Auth Modes Overview

Three mutually exclusive authentication modes govern every inbound request to `mcp.calming-paws.com`.

| Mode | Trigger condition | Tokens involved | Tool access |
|------|-------------------|-----------------|-------------|
| **OAuth 2.1** | `Authorization: Bearer <oauth-access-token>` where token `iss` == Supabase auth issuer | Short-lived (15 min) access token + rotating refresh token | All tools matching granted scopes |
| **BYO JWT** | `Authorization: Bearer <service-token>` where token `iss` == `https://calming-paws.com` and `token_type` claim == `service` | Long-lived (90 day) static JWT | All scopes, no refresh |
| **Demo mode** | No `Authorization` header, or header absent | None | `lookup_breed` only, rate-limited per-IP |

The MCP server inspects the `Authorization` header on every request, including repeated requests within the same logical session (per MCP spec §5.1.1 requirement).

Mode detection order:
1. No header present → Demo mode.
2. Header present → decode JWT header (without verification) → read `iss` claim.
   - `iss` == Supabase project issuer → OAuth mode validation path.
   - `iss` == `https://calming-paws.com` and `token_type` == `service` → BYO JWT validation path.
   - Anything else → reject with 401.

---

## 2. OAuth 2.1 Endpoints

### 2.1 MCP Server — Protected Resource Metadata

The MCP server (`mcp.calming-paws.com`) itself exposes two endpoints required by the 2025-03-26 spec.

#### `GET /.well-known/oauth-protected-resource`

Required by RFC 9728. Served by the MCP server (not the authorization server). This is the first document a compliant MCP client fetches after receiving a 401.

**Response (200 OK, `Content-Type: application/json`):**

```json
{
  "resource": "https://mcp.calming-paws.com",
  "authorization_servers": [
    "https://<project-ref>.supabase.co/auth/v1"
  ],
  "scopes_supported": [
    "openid",
    "profile",
    "email",
    "profile:read",
    "walks:write",
    "progress:read",
    "protocols:read"
  ],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://calming-paws.com/docs/mcp"
}
```

**Notes:**
- `bearer_methods_supported: ["header"]` explicitly prohibits query-string token delivery (per OAuth 2.1 §5.1).
- The `resource` value must exactly match the canonical URI sent as the `resource` parameter in authorization and token requests (RFC 8707).

#### `GET /mcp` (unauthenticated hit triggers 401 + WWW-Authenticate)

When any request arrives with no token or an invalid token, respond:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="Shadow MCP",
                  resource_metadata="https://mcp.calming-paws.com/.well-known/oauth-protected-resource"
```

This conforms to RFC 9728 §5.1. The `resource_metadata` parameter points the MCP client to the protected resource metadata document above.

---

### 2.2 Authorization Server Endpoints (Supabase Auth)

Supabase exposes these at `https://<project-ref>.supabase.co/auth/v1`. The MCP server does not implement these; it delegates entirely to Supabase.

#### `GET /.well-known/oauth-authorization-server` (Authorization Server Metadata — RFC 8414)

Full URL: `https://<project-ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`

**Response shape (200 OK):**

```json
{
  "issuer": "https://<project-ref>.supabase.co/auth/v1",
  "authorization_endpoint": "https://<project-ref>.supabase.co/auth/v1/oauth/authorize",
  "token_endpoint": "https://<project-ref>.supabase.co/auth/v1/oauth/token",
  "registration_endpoint": "https://<project-ref>.supabase.co/auth/v1/oauth/register",
  "revocation_endpoint": "https://<project-ref>.supabase.co/auth/v1/oauth/revoke",
  "jwks_uri": "https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json",
  "userinfo_endpoint": "https://<project-ref>.supabase.co/auth/v1/oauth/userinfo",
  "scopes_supported": [
    "openid", "profile", "email",
    "profile:read", "walks:write", "progress:read", "protocols:read"
  ],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "response_modes_supported": ["query"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "require_pushed_authorization_requests": false
}
```

**Important:** The MCP client discovers this document by appending `/.well-known/oauth-authorization-server` to the authorization server base URL found in the protected resource metadata. MCP clients MUST follow RFC 8414 to parse this — they must not hardcode individual endpoint paths.

---

#### `POST /oauth/register` (Dynamic Client Registration — RFC 7591)

MCP clients use this to self-register without manual setup. This is SHOULD-level in the spec, but practically required for Claude Desktop "one-click" onboarding.

**Request (public client, no client secret):**

```
POST https://<project-ref>.supabase.co/auth/v1/oauth/register
Content-Type: application/json

{
  "client_name": "Claude Desktop",
  "client_uri": "https://claude.ai",
  "redirect_uris": ["https://claude.ai/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "openid profile email profile:read walks:write progress:read protocols:read",
  "application_type": "native"
}
```

**Response (201 Created):**

```json
{
  "client_id": "cpa_XXXXXXXXXXXXXXXX",
  "client_id_issued_at": 1748000000,
  "client_name": "Claude Desktop",
  "redirect_uris": ["https://claude.ai/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "openid profile email profile:read walks:write progress:read protocols:read",
  "registration_access_token": "rat_XXXXXXXXXXXXXXXX",
  "registration_client_uri": "https://<project-ref>.supabase.co/auth/v1/oauth/register/cpa_XXXXXXXXXXXXXXXX"
}
```

**Notes:**
- `token_endpoint_auth_method: "none"` marks this as a public client. PKCE is mandatory for all public clients per OAuth 2.1.
- The `registration_access_token` is used if the client needs to update or delete its registration.
- Registration should be rate-limited: max 10 registrations per IP per hour.
- Supabase enables dynamic client registration via dashboard toggle: Authentication → OAuth Server → Dynamic Client Registration.

---

#### `GET /oauth/authorize` (Authorization Endpoint)

Opens in the user's browser. Claude Desktop constructs this URL and redirects the user's system browser to it.

**Request parameters:**

| Parameter | Required | Value / Notes |
|-----------|----------|---------------|
| `response_type` | REQUIRED | `code` |
| `client_id` | REQUIRED | Registered `client_id` from DCR step |
| `redirect_uri` | REQUIRED | Exact match to registered URI |
| `scope` | REQUIRED | Space-separated scope string |
| `state` | REQUIRED | Cryptographically random, min 128 bits, stored by client |
| `code_challenge` | REQUIRED | BASE64URL(SHA256(code_verifier)) |
| `code_challenge_method` | REQUIRED | `S256` |
| `resource` | REQUIRED | `https://mcp.calming-paws.com` (RFC 8707) |

**Example URL:**

```
https://<project-ref>.supabase.co/auth/v1/oauth/authorize
  ?response_type=code
  &client_id=cpa_XXXXXXXXXXXXXXXX
  &redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcallback
  &scope=openid%20profile%20email%20profile%3Aread%20walks%3Awrite%20progress%3Aread%20protocols%3Aread
  &state=abc123def456...
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
  &resource=https%3A%2F%2Fmcp.calming-paws.com
```

**Consent screen behavior:**
- Supabase renders the built-in consent screen, augmented with a Calming Paws logo and branding (set via dashboard).
- The consent screen must list human-readable scope descriptions (see Section 3).
- If the user already has an active Supabase session, the login step is skipped.
- The consent screen appears every time a new client requests access to a scope the user hasn't previously approved. Previously-granted scopes for the same client are silently re-consented (stored in Supabase's OAuth approvals table).

**Success redirect:**

```
https://claude.ai/oauth/callback
  ?code=AUTH_CODE_HERE
  &state=abc123def456...
```

**Error redirect:**

```
https://claude.ai/oauth/callback
  ?error=access_denied
  &error_description=User+denied+access
  &state=abc123def456...
```

---

#### `POST /oauth/token` (Token Endpoint)

Exchanges authorization code for tokens, or refreshes an existing access token.

**Authorization code exchange:**

```
POST https://<project-ref>.supabase.co/auth/v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE_HERE
&redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcallback
&client_id=cpa_XXXXXXXXXXXXXXXX
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
&resource=https%3A%2F%2Fmcp.calming-paws.com
```

**Response (200 OK):**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "rt_XXXXXXXXXXXXXXXX",
  "scope": "openid profile email profile:read walks:write progress:read protocols:read",
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0..."
}
```

**Refresh token request:**

```
POST https://<project-ref>.supabase.co/auth/v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=rt_XXXXXXXXXXXXXXXX
&client_id=cpa_XXXXXXXXXXXXXXXX
&resource=https%3A%2F%2Fmcp.calming-paws.com
```

**Refresh response (200 OK):**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0yIn0...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "rt_YYYYYYYYYYYYYYYY",
  "scope": "openid profile email profile:read walks:write progress:read protocols:read"
}
```

Note: Supabase rotates refresh tokens on each use. The old refresh token is immediately invalidated. Clients must update stored refresh tokens on every refresh response.

---

#### `POST /oauth/revoke` (Token Revocation — RFC 7009)

```
POST https://<project-ref>.supabase.co/auth/v1/oauth/revoke
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:)

token=rt_XXXXXXXXXXXXXXXX
&token_type_hint=refresh_token
```

**Response:** `200 OK` (empty body) — success. RFC 7009 requires returning 200 even if token was already invalid, to prevent enumeration.

Revoking a refresh token must invalidate all access tokens issued from that grant. Supabase handles this through its session invalidation mechanism.

---

#### `GET /.well-known/jwks.json` (JWKS — RFC 7517)

Full URL: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`

**Response (200 OK):**

```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1",
      "n": "...",
      "e": "AQAB"
    },
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-2",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

Multiple keys are present during key rotation periods. The MCP server selects the correct key using the `kid` header in the JWT. JWKS responses should be cached with a max age of 1 hour; the cache must be invalidated immediately if a JWT presents an unknown `kid`.

---

#### `GET /oauth/userinfo` (UserInfo — OIDC Core §5.3)

```
GET https://<project-ref>.supabase.co/auth/v1/oauth/userinfo
Authorization: Bearer <access-token>
```

**Response (200 OK):**

```json
{
  "sub": "user-uuid-here",
  "email": "owner@example.com",
  "email_verified": true,
  "name": "Jane Smith"
}
```

The MCP server should not call this endpoint on every request; user metadata should come from the JWT claims.

---

## 3. Scopes and Consent

### 3.1 Scope Definitions

| Scope | Maps to tool(s) | Human-readable label on consent screen | Auth required |
|-------|----------------|----------------------------------------|---------------|
| *(none)* | `lookup_breed` | — (no auth, demo mode) | No |
| `profile:read` | `get_dog_profile` | "Read your dog's profile, breed, and reactivity history" | Yes |
| `walks:write` | `log_walk` | "Log walks and trigger events on your behalf" | Yes |
| `progress:read` | `get_progress` | "Read your training progress and session history" | Yes |
| `protocols:read` | `recommend_protocol` | "Generate personalised training protocol recommendations" | Yes |
| `openid` | (OIDC — token identity) | Implicit, not shown separately | Yes |
| `profile` | (OIDC — name, picture) | "Read your basic profile information" | Yes |
| `email` | (OIDC — email address) | "Read your email address" | Yes |

### 3.2 Default Consent Bundle (shown on first connect)

The default OAuth request includes all Shadow-specific scopes bundled together:

```
openid profile email profile:read walks:write progress:read protocols:read
```

Rationale: Shadow is a coaching app — a user who connects Shadow to Claude Desktop almost certainly wants the full coaching experience. Fragmenting consent across five separate browser redirects would be a poor UX with no meaningful security benefit. All scopes are shown on a single consent screen with clear descriptions.

### 3.3 Incremental Consent (future expansion)

If Shadow adds tools post-launch that require new scopes (e.g., `social:write` for sharing progress to a community feed), those scopes MUST NOT be included in the initial bundle. The MCP server should return `HTTP 403` with a `WWW-Authenticate: Bearer error="insufficient_scope", scope="social:write"` header when the new tool is called without the required scope. The MCP client will then trigger a fresh authorization request for the incremental scope only. This pattern avoids forcing all existing users through re-consent for features they haven't asked for.

### 3.4 Scope Enforcement on the MCP Server

Every tool call is gated by a middleware check before handler execution:

```
Tool: get_dog_profile
Required scope: profile:read
Check: parsed_token.scopes.includes("profile:read")
On failure: HTTP 403, body: {"error": "insufficient_scope", "required": "profile:read"}
```

The scope list in the access token is authoritative. Never infer scopes from the user's plan tier alone.

---

## 4. End-to-End Flow — Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CD as Claude Desktop<br/>(MCP Client)
    participant MCP as mcp.calming-paws.com<br/>(MCP Server / Resource Server)
    participant AS as Supabase Auth<br/>(Authorization Server)
    participant Browser as User's Browser

    Note over CD,MCP: Step 1 — Initial connection attempt (no token yet)
    CD->>MCP: GET /mcp (no Authorization header)
    MCP-->>CD: 401 Unauthorized\nWWW-Authenticate: Bearer resource_metadata="https://mcp.calming-paws.com/.well-known/oauth-protected-resource"

    Note over CD,AS: Step 2 — Discovery
    CD->>MCP: GET /.well-known/oauth-protected-resource
    MCP-->>CD: 200 OK\n{ "authorization_servers": ["https://<ref>.supabase.co/auth/v1"], ... }
    CD->>AS: GET /.well-known/oauth-authorization-server/auth/v1
    AS-->>CD: 200 OK\n{ "authorization_endpoint": "...", "token_endpoint": "...", "registration_endpoint": "...", "jwks_uri": "...", ... }

    Note over CD,AS: Step 3 — Dynamic Client Registration (first time only)
    CD->>AS: POST /auth/v1/oauth/register\n{ "client_name": "Claude Desktop", "redirect_uris": [...], "token_endpoint_auth_method": "none", ... }
    AS-->>CD: 201 Created\n{ "client_id": "cpa_XXX", ... }
    Note over CD: Client stores client_id locally.<br/>No re-registration on subsequent connects.

    Note over CD,Browser: Step 4 — Authorization request
    CD->>CD: Generate code_verifier (128-bit random)\nCompute code_challenge = BASE64URL(SHA256(verifier))\nGenerate state (128-bit random)\nStore verifier + state locally
    CD->>Browser: Open system browser to /auth/v1/oauth/authorize\n?response_type=code&client_id=cpa_XXX\n&redirect_uri=...&scope=openid+profile+email+profile:read+walks:write+progress:read+protocols:read\n&state=abc123&code_challenge=E9M...&code_challenge_method=S256\n&resource=https://mcp.calming-paws.com

    Note over Browser,AS: Step 5 — User authentication and consent
    Browser->>AS: GET /auth/v1/oauth/authorize (all params above)
    AS->>Browser: Show Calming Paws login/consent page
    User->>Browser: Signs in (email+password or social) and approves scopes
    Browser->>AS: POST consent approval
    AS-->>Browser: 302 Redirect to https://claude.ai/oauth/callback?code=AUTH_CODE&state=abc123

    Note over CD,AS: Step 6 — Authorization code exchange
    Browser->>CD: Delivers code=AUTH_CODE, state=abc123 via redirect
    CD->>CD: Verify state matches stored value\nRetrieve stored code_verifier
    CD->>AS: POST /auth/v1/oauth/token\ngrant_type=authorization_code&code=AUTH_CODE\n&redirect_uri=...&client_id=cpa_XXX\n&code_verifier=dBj...&resource=https://mcp.calming-paws.com
    AS->>AS: Verify: code valid, not expired, PKCE matches,\nredirect_uri exact match, resource indicator matches
    AS-->>CD: 200 OK\n{ "access_token": "eyJ...", "expires_in": 900, "refresh_token": "rt_XXX", "scope": "...", "id_token": "eyJ..." }

    Note over CD,MCP: Step 7 — Authenticated MCP tool call
    CD->>MCP: POST /mcp\nAuthorization: Bearer eyJ...\n{ "method": "tools/call", "params": { "name": "get_dog_profile", "arguments": {...} } }

    Note over MCP: Step 8 — Token validation (server-side)
    MCP->>MCP: 1. Decode JWT header → read kid\n2. Fetch JWKS (cached), find key by kid\n3. Verify RS256 signature\n4. Check iss == Supabase issuer\n5. Check aud contains "https://mcp.calming-paws.com"\n6. Check exp > now\n7. Check scope contains "profile:read"\n8. Check subscription tier allows tool (see §8)
    MCP-->>CD: 200 OK\n{ "result": { "dog": { "name": "Koda", "breed": "Australian Shepherd", ... } } }

    Note over CD,AS: Step 9 — Silent token refresh (when access token nears expiry)
    CD->>AS: POST /auth/v1/oauth/token\ngrant_type=refresh_token&refresh_token=rt_XXX\n&client_id=cpa_XXX&resource=https://mcp.calming-paws.com
    AS-->>CD: 200 OK\n{ "access_token": "eyJ...(new)", "expires_in": 900, "refresh_token": "rt_YYY(new)" }
    Note over CD: Old refresh token rt_XXX is now invalid.\nStore rt_YYY for next refresh.
```

---

## 5. Token Lifecycle

### 5.1 Access Token TTL

**Recommendation: 15 minutes (900 seconds).**

Rationale:
- A typical Claude Desktop session involving Shadow tools lasts 5–30 minutes. A 15-minute access token means most short conversations complete within a single access token's lifetime, avoiding mid-conversation refresh interruptions.
- If the token leaks (screenshot, log scrape, shared config), it expires quickly.
- 15 minutes is the default Supabase OAuth access token TTL and is consistent with OIDC best practices for public-facing consumer apps.

An alternative of 5 minutes provides more security but increases refresh frequency. 1 hour is too long for a public consumer API. 15 minutes is the appropriate balance for this use case.

### 5.2 Refresh Token Handling

- **TTL:** 30 days of absolute expiry; also invalidated if unused for 7 days (rolling window).
- **Rotation:** Supabase rotates refresh tokens on every use. The server issues a new refresh token with each successful refresh, and the old one is immediately invalidated. The MCP client must persist the new refresh token.
- **Detection of replay attacks:** Supabase detects refresh token reuse (a rotated token being presented again) and treats it as a compromise signal. On detection: invalidate the entire refresh token family for the user-client pair and force re-authentication.
- **Storage on client side:** Claude Desktop stores the refresh token in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). It must not be stored in plaintext config files.

### 5.3 Token Expiry Mid-Conversation

When an access token expires during an active Claude conversation:

1. The MCP server returns `HTTP 401` with `WWW-Authenticate: Bearer error="invalid_token", error_description="Token expired"`.
2. The MCP client detects the 401 and attempts a silent refresh using the stored refresh token.
3. If the refresh succeeds: the client retries the failed tool call transparently with the new access token. The user sees no interruption.
4. If the refresh token has also expired or been revoked (e.g., user revoked access from the Calming Paws settings page): the MCP client returns an error to the conversation UI ("Shadow needs to reconnect to Calming Paws — please re-authenticate") and prompts re-authorization.

The MCP server MUST NOT cache the 401 state or close the connection on the first 401. It must remain open for the client to retry.

**Proactive refresh:** MCP clients SHOULD refresh the access token when `expires_in` falls below 60 seconds, rather than waiting for a 401. This prevents mid-tool-call token expiry for tools that have slow execution.

### 5.4 Revocation

Users can revoke Shadow's access from:
- **Calming Paws settings page** → "Connected Apps" → Revoke.
- **Supabase Auth API** (admin use): `DELETE /auth/v1/oauth/sessions/{session_id}`.

The `POST /oauth/revoke` endpoint (RFC 7009) is also available to the MCP client itself for user-initiated "disconnect" from Claude Desktop settings.

After revocation:
- All access tokens from that grant are immediately invalid (Supabase uses short-lived tokens, so the worst case is 15 minutes of residual validity before the next natural expiry — this is acceptable).
- The refresh token is invalidated immediately.
- Subsequent tool calls return `HTTP 401`.

---

## 6. BYO JWT Fallback

### 6.1 Use Case

Power users (Claude Code developers, teams building on top of Shadow's MCP API) want a static long-lived token they can paste into a config file without going through a browser OAuth flow. This is analogous to personal access tokens in GitHub, GitLab, or Supabase's own service role keys.

### 6.2 Token Generation

Users navigate to `https://calming-paws.com/settings/api-keys` and click "Generate MCP Token." The backend:

1. Creates a JWT signed with the Calming Paws private key (RS256, separate key pair from the Supabase OAuth key — see §6.4 on distinguishing tokens).
2. Embeds all Shadow scopes by default: `profile:read walks:write progress:read protocols:read`.
3. Sets `iss: "https://calming-paws.com"`, `aud: "https://mcp.calming-paws.com"`, `token_type: "service"`, and `sub: <user_uuid>`.
4. Sets `exp` to 90 days from issuance.
5. Returns the JWT to the user exactly once. The JWT is not stored server-side in recoverable form — only a hash is stored for revocation checks.

**Example decoded payload:**

```json
{
  "iss": "https://calming-paws.com",
  "sub": "user-uuid-here",
  "aud": "https://mcp.calming-paws.com",
  "iat": 1748000000,
  "exp": 1755776000,
  "token_type": "service",
  "scope": "profile:read walks:write progress:read protocols:read",
  "plan": "pro",
  "key_id": "cpk_XXXXXXXXXXXXXXXX"
}
```

### 6.3 User Configuration

In Claude Code's `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "shadow": {
      "url": "https://mcp.calming-paws.com/mcp",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImNwLWtleS0xIn0..."
      }
    }
  }
}
```

### 6.4 How the MCP Server Distinguishes BYO JWT from OAuth Tokens

The server checks the `iss` claim before touching the signature:

| Check | OAuth token | BYO JWT |
|-------|------------|---------|
| `iss` | `https://<project-ref>.supabase.co/auth/v1` | `https://calming-paws.com` |
| `token_type` claim | absent (or `access`) | `service` |
| Signing key | Supabase RS256 JWKS | Calming Paws RS256 JWKS (separate endpoint) |
| JWKS URL | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` | `https://calming-paws.com/.well-known/jwks.json` |
| Refresh possible | Yes | No — token is static |
| Revocation check | Supabase session table | Calming Paws key revocation hash table |

The MCP server maintains two JWKS cache entries and two validation paths. It MUST NOT accept a BYO JWT validated against the Supabase JWKS, and vice versa — cross-validation paths must be blocked.

### 6.5 Recommended TTL and Rotation

- **TTL:** 90 days. Short enough to limit blast radius if leaked, long enough to not create CI/CD rotation headaches.
- **Rotation guidance:**
  - The settings page shows the creation date and expiry date for each key.
  - 14 days before expiry, the user receives an email reminder.
  - 7 days before expiry, Shadow in Claude Code emits a soft warning in the tool result: `"Note: your Calming Paws API key expires in 7 days. Visit https://calming-paws.com/settings/api-keys to rotate."`.
  - At expiry, all tool calls return `HTTP 401` with `error_description: "Service token expired"`. The user must generate a new key.
  - Keys should be rotated immediately if accidentally committed to a public repository. The settings page allows immediate revocation by key ID.
- **Max concurrent keys:** 5 per user. This supports multiple integrations (Claude Code, custom scripts, CI pipelines) without unbounded proliferation.

### 6.6 Scopes on BYO JWTs

BYO JWTs carry all scopes by default. There is no incremental consent flow. This is appropriate for a developer token where the user explicitly generated the key and understands the access level. Future versions may allow scope-restricted service tokens (e.g., read-only keys), but that is out of scope for v1.

---

## 7. Security Threats and Mitigations

### 7.1 Token Leakage in Shared Screenshots

**Threat:** A user shares a screenshot of their terminal, Claude Code config, or a conversation log that includes a `Bearer` token value.

**Mitigations:**
- Access tokens have a 15-minute TTL. A leaked access token has a short window of exploitability.
- BYO JWTs are long-lived (90 days) — this is the higher-risk case.
- The Calming Paws settings page provides one-click revocation by key ID. Users can verify which key is active and revoke any key immediately.
- The MCP server should never echo the `Authorization` header value in responses, logs, or error messages. Tokens MUST NOT appear in response bodies.
- Token values in error messages (e.g., "invalid token: eyJ...") are explicitly prohibited.
- Documentation should warn users not to share screenshots of `~/.claude/mcp.json`.

### 7.2 CSRF on the Authorization Endpoint

**Threat:** An attacker tricks a logged-in user into visiting a crafted URL that initiates an authorization flow the attacker can complete (classic OAuth CSRF).

**Mitigations:**
- The `state` parameter is REQUIRED. Claude Desktop generates a cryptographically random 128-bit `state` value before redirecting the user, stores it in memory/local state, and verifies it matches on callback before proceeding. Responses that omit `state` or where `state` doesn't match are discarded with no token exchange attempted.
- The authorization server (Supabase) validates that the `redirect_uri` exactly matches the registered value. An attacker cannot redirect to their own URI.
- PKCE (`code_challenge_method=S256`) prevents authorization code interception attacks — even if the code is stolen, it cannot be exchanged without the `code_verifier` that only the legitimate client holds.

### 7.3 Redirect URI Spoofing

**Threat:** An attacker registers a client with a lookalike redirect URI (e.g., `https://c1aude.ai/oauth/callback` instead of `https://claude.ai/oauth/callback`) or exploits wildcard matching.

**Mitigations:**
- The authorization server MUST perform exact string matching on redirect URIs. Substring matching, wildcard matching, and prefix matching are all prohibited.
- Dynamic client registration (RFC 7591) requires clients to supply explicit redirect URIs. Registrations with URIs containing wildcards (`*`, `**`) MUST be rejected at registration time.
- Calming Paws should add a secondary validation layer: the MCP server itself can be configured with an allowlist of known MCP clients (Claude Desktop, Claude.ai) and their expected redirect URI patterns. Unknown clients registered via DCR should be subject to user confirmation before their first authorization request is approved.

### 7.4 Downgrade Attacks

**Threat:** An attacker intercepts the authorization request and strips `code_challenge` / `code_challenge_method` parameters, or injects `response_type=token` to attempt an implicit flow.

**Mitigations:**
- The Supabase authorization server MUST reject any authorization request that lacks `code_challenge` and `code_challenge_method=S256`. This is enforced at the OAuth 2.1 level — PKCE is mandatory for all public clients and is not optional.
- `response_type=token` (implicit grant) is not in `response_types_supported` in the server metadata. Any request with `response_type=token` returns `error=unsupported_response_type`.
- All authorization server endpoints are HTTPS-only. HTTP is rejected with 301 at the load balancer level. HSTS headers with a minimum `max-age=31536000` are set on all auth endpoints.
- The server metadata document lists only `code` in `response_types_supported` and does not list `implicit` in `grant_types_supported`.

### 7.5 Demo Mode Abuse

**Threat:** A bad actor hammers `lookup_breed` from multiple IPs to scrape the breed knowledge base, or uses demo mode as a vector to probe MCP server internals.

**Mitigations:**
- Rate limit: 10 requests per IP per minute, 100 per IP per hour, enforced at the CDN/edge layer (Cloudflare or equivalent) before requests reach the MCP server. Response: `429 Too Many Requests` with a `Retry-After` header.
- `lookup_breed` in demo mode returns only the breed knowledge content already publicly available in `SKILL.md`. It does not touch any Supabase data.
- Demo mode requests are logged with IP and timestamp but no user identity (no PII logged).
- If an IP triggers the hourly limit repeatedly over multiple days, it is added to an auto-block list reviewed weekly.
- The demo mode endpoint should be served from a separate route handler that has zero access to the authenticated tool handlers — structural isolation, not just a flag check.

### 7.6 JWT Algorithm Confusion (RS256 vs HS256)

**Threat:** An attacker obtains the server's RS256 public key (which is public — that's the point of JWKS), then forges a token signed with HS256 using that public key as the HMAC secret. A naive JWT library that doesn't validate `alg` will verify this.

**Mitigations:**
- The JWT validation library MUST be configured with an explicit algorithm allowlist: `["RS256"]` for OAuth tokens, `["RS256"]` for BYO JWTs. The `alg` claim in the JWT header must be checked against this allowlist before any cryptographic verification is attempted.
- Never use `algorithm: "auto"` or `algorithm: "any"` in the JWT library configuration.
- The JWKS endpoint specifies `"alg": "RS256"` on each key. The validator must also check that the `alg` on the key object matches the expected algorithm.
- In code review and CI, flag any use of `jwt.verify(token, secret)` without an explicit `algorithms` option as a blocking issue.

### 7.7 Audience Confusion (Token Reuse Across Services)

**Threat:** A token issued for a different Calming Paws service (e.g., the REST API at `api.calming-paws.com`) is presented to the MCP server. If both services share the same issuer, a naive server will accept it.

**Mitigations:**
- The MCP server MUST validate the `aud` claim: it MUST contain `https://mcp.calming-paws.com` (the canonical resource URI used in the RFC 8707 `resource` parameter). Tokens with a different or missing `aud` are rejected with `HTTP 401`.
- The authorization request and token request both include `resource=https://mcp.calming-paws.com`. Supabase uses this to bind the issued token's `aud` to that specific resource. Tokens issued for other audiences cannot be used here.
- The MCP server MUST NOT pass received tokens to upstream APIs (Supabase REST API, PostgREST, etc.). It exchanges them for its own service-role credentials to call upstream. This is explicitly required by MCP spec §5.2 ("MCP servers MUST NOT accept or transit any other tokens").

### 7.8 Additional Threats (Brief)

**PKCE code verifier brute force:** The code verifier must be at least 43 characters (spec minimum). Require minimum 64 characters in practice. Authorization codes expire after 10 minutes (Supabase default). After one failed exchange attempt, the code should be invalidated.

**Refresh token leakage:** Refresh tokens are stored in OS credential stores, not config files. They are long random strings (256 bits of entropy). If a refresh token is presented from an unexpected IP or user-agent and the original token family was already rotated, treat as a family compromise and invalidate all tokens for that grant.

**Subdomain takeover via resource metadata:** The `resource` URI `https://mcp.calming-paws.com` must always resolve to a controlled server. Monitor DNS records. If the MCP service is decommissioned, the DNS record must be removed before the subdomain can be claimed by an attacker.

---

## 8. Subscription Tier Enforcement

### 8.1 The Decision: JWT Claims vs Runtime Entitlement Lookup

**Recommendation: enforce subscription tier via a runtime entitlement lookup on every tool call, with the JWT providing identity and scope only.**

Argument:

| Approach | Pros | Cons |
|----------|------|------|
| **JWT claims** (embed `plan: "pro"` in the token) | Zero extra latency per call; no DB query | Stale data: user downgrades mid-token-lifetime; hard to update without token rotation; 15-minute lag on plan changes |
| **Runtime lookup** (query subscription table on each call) | Always current; instant enforcement on downgrade/cancellation | +1 DB query per tool call (~1-5ms on Supabase with connection pooling) |

The 15-minute access token TTL means a JWT-claims approach would allow up to 15 minutes of unauthorized access after a downgrade or cancellation. For a subscription product, this is unacceptable — a cancelled user could continue using paid tools for up to 15 minutes. The 1-5ms lookup cost is negligible compared to the LLM inference latency (typically 200-2000ms per tool call response).

**Implementation:**

```
On each authenticated tool call:
1. Validate JWT (signature, iss, aud, exp, scope) — pure in-memory, ~0.1ms
2. Extract user UUID from sub claim
3. Query: SELECT plan, active FROM user_subscriptions WHERE user_id = $1
   (cached per user UUID with 30-second TTL in a Redis or Supabase edge cache)
4. If plan == "free" AND tool requires paid tier → return HTTP 403
   { "error": "plan_required", "required_plan": "pro", "upgrade_url": "https://calming-paws.com/upgrade" }
```

The 30-second cache on the subscription lookup is a deliberate balance: it adds a maximum of 30 seconds of lag on a mid-session downgrade (acceptable) while reducing DB load by ~99% for active users.

### 8.2 Tier-to-Tool Mapping

| Tool | Free tier | Pro tier |
|------|-----------|----------|
| `lookup_breed` | Yes (demo, no auth) | Yes |
| `get_dog_profile` | Yes (1 dog profile) | Yes (unlimited dogs) |
| `log_walk` | Yes (10 walks/month) | Yes (unlimited) |
| `get_progress` | No | Yes |
| `recommend_protocol` | No (1 free trial per user) | Yes |

### 8.3 Where Tier Information Lives

- The canonical source of truth is the `user_subscriptions` table in Supabase (Postgres).
- The JWT carries `scope` claims (access control) but NOT the plan tier (authorization state that can change independently).
- BYO JWTs embed the `plan` claim at issuance time but the MCP server still performs a runtime lookup and ignores the JWT's `plan` claim. The JWT `plan` is only used for early fast-fail logging (to generate useful metrics), never for enforcement.

---

## 9. Operational Concerns

### 9.1 Key Rotation

**Supabase OAuth signing keys (RS256):**
- Supabase supports rolling key rotation via the dashboard (Authentication → Signing Keys). A new key pair is generated with a new `kid`, added to the JWKS endpoint alongside the old key. The old key remains in JWKS for a grace period to allow in-flight tokens to continue validating.
- **Recommended rotation schedule:** Every 90 days, or immediately on suspected compromise.
- **Procedure:**
  1. Generate new key pair in Supabase dashboard.
  2. Verify new key appears in JWKS endpoint with new `kid`.
  3. Wait 15 minutes (one access token TTL) for all tokens signed with old key to expire or be refreshed.
  4. Remove old key from JWKS endpoint.
  5. Verify no 401 errors attributable to unknown `kid` in monitoring.

**Calming Paws BYO JWT signing keys:**
- Stored in a secrets manager (e.g., AWS Secrets Manager, Doppler, or Supabase Vault).
- Exposed at `https://calming-paws.com/.well-known/jwks.json`.
- Rotation procedure is the same as above but requires also invalidating all BYO JWTs signed with the old key. Since BYO JWTs are long-lived (90 days), key rotation must be coordinated with forced re-issuance of service tokens. Users should be notified 14 days in advance of a key rotation that requires re-issuance.

**Key compromise response:**
- If either signing key is suspected compromised: revoke immediately, rotate, and force all users to re-authenticate (OAuth) or re-issue service tokens (BYO JWT). This is a P0 incident.

### 9.2 JWKS Endpoint Caching

- The MCP server caches JWKS responses in memory with a 1-hour TTL.
- Cache is invalidated immediately if a JWT presents a `kid` not present in the cached JWKS (triggers a fresh JWKS fetch).
- JWKS fetches must have a 5-second timeout and a circuit breaker: if JWKS is unreachable, fail closed (reject all tokens) after 3 consecutive failures. Do not cache stale keys past their TTL as a fallback — this prevents a JWKS outage from becoming a security bypass.

### 9.3 Monitoring and Alerting

**Metrics to track:**

| Metric | Alert threshold | Notes |
|--------|----------------|-------|
| `auth.401_rate` by endpoint | > 5% of requests in a 5-minute window | Indicates credential stuffing, token expiry mishandling, or a misconfigured client rollout |
| `auth.403_rate` by scope | Spike > 10x baseline | Indicates a broken client sending incorrect scopes |
| `auth.jwks_cache_miss_rate` | > 10% in 5-minute window | May indicate key rotation in progress or attacker probing with forged `kid` values |
| `auth.demo_rate_limit_hit` | > 1000/hour from single IP | Indicates scraping attempt |
| `auth.refresh_reuse_detected` | Any occurrence | Compromise signal — alert immediately, invalidate token family |
| `auth.byo_jwt_expiring_soon` | 14 days to expiry | Trigger user email notification |
| `auth.token_validation_latency_p99` | > 50ms | Indicates JWKS fetch overhead or clock skew issue |

**Dashboards:** Maintain a live Grafana or Datadog dashboard with these metrics. Auth failure rates should be part of the weekly operational review.

### 9.4 What to Log

**DO log:**
- Timestamp
- User UUID (`sub` claim) — anonymized in shared dashboards
- `client_id` from the JWT
- Requested scope
- Tool name called
- Response status code (200/401/403/429)
- IP address (for rate limiting and security analysis)
- JWT `kid` (for key usage tracking)
- Subscription tier at time of call (from runtime lookup)
- Duration of request

**DO NOT log:**
- The token string itself (access token, refresh token, BYO JWT value)
- The `code_verifier` or `code_challenge` from OAuth flows
- User email address in application logs (only in dedicated audit logs with restricted access)
- Any PII in free-form log fields
- Request/response body content from tool calls (may contain sensitive dog/health information)

**Audit log (separate, restricted-access, write-once):**
- OAuth grant creations and revocations
- BYO JWT issuances and revocations
- Plan tier changes correlated with tool access denials
- Refresh token reuse detections
- JWKS key rotations and the `kid` values involved

Audit logs must be retained for minimum 90 days and stored separately from application logs.

### 9.5 Clock Skew

JWT `exp` validation must tolerate a clock skew of up to 60 seconds. Supabase-issued tokens use server time; the MCP server's system clock must be synchronized via NTP and monitored for drift > 5 seconds.

### 9.6 Dependency Versions

The JWT library used by the MCP server must:
- Be actively maintained with a security disclosure process.
- Support explicit `algorithms` parameter (reject libraries that don't).
- Be pinned to a specific version in package lock files, with automated Dependabot/Renovate PRs for security updates.
- Be reviewed for CVEs on every deployment.

---

## Appendix A — Token JWT Payload Examples

### OAuth Access Token (Supabase-issued)

```json
{
  "iss": "https://<project-ref>.supabase.co/auth/v1",
  "sub": "user-uuid-here",
  "aud": "https://mcp.calming-paws.com",
  "iat": 1748000000,
  "exp": 1748000900,
  "scope": "openid profile email profile:read walks:write progress:read protocols:read",
  "client_id": "cpa_XXXXXXXXXXXXXXXX",
  "amr": [{"method": "pwd", "timestamp": 1748000000}]
}
```

### BYO JWT (Calming Paws-issued)

```json
{
  "iss": "https://calming-paws.com",
  "sub": "user-uuid-here",
  "aud": "https://mcp.calming-paws.com",
  "iat": 1748000000,
  "exp": 1755776000,
  "token_type": "service",
  "scope": "profile:read walks:write progress:read protocols:read",
  "plan": "pro",
  "key_id": "cpk_XXXXXXXXXXXXXXXX"
}
```

---

## Appendix B — MCP Server Token Validation Pseudocode

```python
def validate_token(authorization_header: str) -> TokenClaims:
    if not authorization_header.startswith("Bearer "):
        raise Unauthorized("Missing or malformed Authorization header")

    token = authorization_header[7:]

    # Step 1: Decode header without verification to determine path
    header = jwt.get_unverified_header(token)
    if header.get("alg") not in ALLOWED_ALGORITHMS:  # ["RS256"]
        raise Unauthorized(f"Algorithm {header['alg']} not permitted")

    # Step 2: Decode payload without verification to check issuer
    unverified = jwt.decode(token, options={"verify_signature": False})
    iss = unverified.get("iss")

    if iss == SUPABASE_ISSUER:
        jwks_url = SUPABASE_JWKS_URL
        expected_aud = MCP_CANONICAL_URI
    elif iss == CALMING_PAWS_ISSUER:
        if unverified.get("token_type") != "service":
            raise Unauthorized("Invalid token_type for issuer")
        jwks_url = CALMING_PAWS_JWKS_URL
        expected_aud = MCP_CANONICAL_URI
    else:
        raise Unauthorized(f"Untrusted issuer: {iss}")

    # Step 3: Fetch public key from JWKS (cached)
    kid = header.get("kid")
    public_key = get_jwks_key(jwks_url, kid)  # raises if kid not found

    # Step 4: Full verification
    claims = jwt.decode(
        token,
        public_key,
        algorithms=["RS256"],  # explicit allowlist, never "auto"
        audience=expected_aud,
        issuer=iss,
        leeway=60  # 60-second clock skew tolerance
    )

    return claims


def check_scope(claims: TokenClaims, required_scope: str):
    granted = claims.get("scope", "").split()
    if required_scope not in granted:
        raise Forbidden(f"Insufficient scope. Required: {required_scope}")


def check_subscription(claims: TokenClaims, tool_name: str):
    user_id = claims["sub"]
    plan = get_user_plan(user_id)  # cached 30s
    if tool_name in PAID_TOOLS and plan == "free":
        raise Forbidden("plan_required", upgrade_url="https://calming-paws.com/upgrade")
```

---

## Appendix C — References

- MCP Authorization Spec 2025-03-26: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
- OAuth 2.1 Draft: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13
- RFC 8414 — Authorization Server Metadata: https://datatracker.ietf.org/doc/html/rfc8414
- RFC 7591 — Dynamic Client Registration: https://datatracker.ietf.org/doc/html/rfc7591
- RFC 9728 — Protected Resource Metadata: https://datatracker.ietf.org/doc/html/rfc9728
- RFC 8707 — Resource Indicators: https://www.rfc-editor.org/rfc/rfc8707.html
- RFC 7009 — Token Revocation: https://datatracker.ietf.org/doc/html/rfc7009
- Supabase OAuth 2.1 Server: https://supabase.com/docs/guides/auth/oauth-server
- Supabase MCP Authentication: https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- Supabase Custom Access Token Hook: https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
