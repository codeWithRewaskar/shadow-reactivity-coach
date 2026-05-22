/**
 * auth.ts — Authentication middleware for the Shadow MCP server.
 *
 * Three authentication paths:
 *
 * 1. Demo mode  — No Authorization header. Only `lookup_breed` is callable.
 *                 All other tools return a structured auth-required error.
 *
 * 2. OAuth 2.1  — Bearer token validated via RS256/ES256 JWKS. Expects
 *                 `aud`, `iss`, `exp`, and a `scope` claim. This is the
 *                 primary path for Calming Paws app users.
 *
 * 3. BYO JWT    — HS256 Bearer token validated against BYO_JWT_SECRET.
 *                 Intended for long-lived server-to-server integrations.
 *                 Different scope expectations than OAuth tokens.
 *
 * Returns an AuthContext consumed by tool handlers to enforce per-tool
 * access control.
 */

// --- Types ---

export type AuthKind = "demo" | "oauth" | "byojwt";

export interface AuthContext {
  kind: AuthKind;
  /** Populated for oauth and byojwt kinds. */
  user_id?: string;
  /** Space-separated scopes extracted from the token. */
  scopes?: string[];
}

export interface AuthError {
  code: "auth_required" | "auth_invalid" | "auth_expired" | "scope_missing";
  message: string;
  cta?: string;
}

// Tools that require authentication (all except lookup_breed)
export const AUTH_REQUIRED_TOOLS = new Set([
  "get_dog_profile",
  "log_walk",
  "get_progress",
  "recommend_protocol",
]);

// Required scope(s) by tool — OAuth path uses fine-grained scopes that
// match `mcp/manifest.json` exactly. BYO JWT path accepts the broader
// "shadow:all" wildcard or any of the per-tool scopes.
//
// Canonical scope vocabulary (single source of truth — keep in sync with
// `mcp/manifest.json` and `mcp/oauth-flow.md`):
//   - profile:read    → read dog profile data
//   - walks:write     → create walk logs
//   - progress:read   → read aggregated progress analytics
//   - protocols:read  → read recommended training protocols
export const OAUTH_TOOL_SCOPES: Record<string, string[]> = {
  get_dog_profile: ["profile:read"],
  log_walk: ["walks:write"],
  get_progress: ["progress:read"],
  recommend_protocol: ["profile:read", "progress:read", "protocols:read"],
};

// Wildcard scope accepted on the BYO JWT path (and as an OAuth override).
export const WILDCARD_SCOPE = "shadow:all";

// --- JWT helpers ---

/** Decode the payload of a JWT without verifying the signature. */
function decodePayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  // Pad the base64url segment before decoding
  const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const json = atob(pad(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  return JSON.parse(json) as Record<string, unknown>;
}

/** Decode the header of a JWT to read the algorithm. */
function decodeHeader(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const json = atob(pad(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Verify an HS256 JWT using the Web Crypto API (available in Deno).
 * Returns the decoded payload on success, throws on failure.
 */
async function verifyHS256(
  token: string,
  secret: string
): Promise<Record<string, unknown>> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const sigBytes = Uint8Array.from(
    atob(pad(parts[2].replace(/-/g, "+").replace(/_/g, "/"))),
    (c) => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    keyMaterial,
    sigBytes as BufferSource,
    data as BufferSource
  );
  if (!valid) throw new Error("Invalid signature");

  return decodePayload(token);
}

/**
 * Fetch JWKS and verify an RS256 or ES256 token using Web Crypto.
 *
 * Cache strategy:
 *   - Cached in module scope with a TTL (default 10 minutes, overridable via
 *     JWKS_CACHE_TTL_SECONDS).
 *   - On `kid` cache miss (key rotation), the cache is force-refreshed once
 *     before giving up.
 */
let jwksCache: { keys: JWK[]; expiresAt: number } | null = null;

interface JWK {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

async function fetchJWKS(url: string, force = false): Promise<{ keys: JWK[] }> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && jwksCache && jwksCache.expiresAt > nowSec) return jwksCache;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
  const ttl = parseInt(Deno.env.get("JWKS_CACHE_TTL_SECONDS") ?? "600", 10);
  const body = (await res.json()) as { keys: JWK[] };
  jwksCache = { keys: body.keys, expiresAt: nowSec + ttl };
  return jwksCache;
}

async function verifyRS256OrES256(
  token: string,
  jwksUrl: string
): Promise<Record<string, unknown>> {
  const header = decodeHeader(token);
  const alg = (header.alg as string) ?? "";
  const kid = header.kid as string | undefined;

  // First try cached JWKS; on kid miss, force-refresh once (key rotation).
  let { keys } = await fetchJWKS(jwksUrl);
  let jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
  if (!jwk && kid) {
    ({ keys } = await fetchJWKS(jwksUrl, true));
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error("No matching JWK found");

  let algorithm: RsaHashedImportParams | EcKeyImportParams;
  if (alg === "RS256") {
    algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  } else if (alg === "ES256") {
    algorithm = { name: "ECDSA", namedCurve: "P-256" };
  } else {
    throw new Error(`Unsupported algorithm: ${alg}`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    algorithm,
    false,
    ["verify"]
  );

  const enc = new TextEncoder();
  const parts = token.split(".");
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const sigBytes = Uint8Array.from(
    atob(pad(parts[2].replace(/-/g, "+").replace(/_/g, "/"))),
    (c) => c.charCodeAt(0)
  );

  let valid: boolean;
  if (alg === "RS256") {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      sigBytes as BufferSource,
      data as BufferSource
    );
  } else {
    // ES256: the signature is DER-encoded; Web Crypto expects raw r||s (64 bytes).
    const rawSig = derToRaw(sigBytes);
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      rawSig as BufferSource,
      data as BufferSource
    );
  }

  if (!valid) throw new Error("Invalid signature");
  return decodePayload(token);
}

/**
 * Convert a DER-encoded ECDSA signature to the raw r||s format that
 * Web Crypto's ECDSA verify expects.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // If it's already 64 bytes, assume it's already raw
  if (der.length === 64) return der;
  if (der.length < 8 || der[0] !== 0x30) throw new Error("Invalid DER signature");

  // Skip 0x30 + length. Length may be short-form (1 byte) or long-form
  // (0x81/0x82 + N bytes).
  let offset = 1;
  if (der[offset] & 0x80) {
    const lenBytes = der[offset] & 0x7f;
    if (lenBytes < 1 || lenBytes > 2) throw new Error("Invalid DER length");
    offset += 1 + lenBytes;
  } else {
    offset += 1;
  }

  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const rLen = der[offset++];
  if (offset + rLen > der.length) throw new Error("Invalid DER r length");
  const r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const sLen = der[offset++];
  if (offset + sLen > der.length) throw new Error("Invalid DER s length");
  const s = der.slice(offset, offset + sLen);

  // Pad or trim each component to 32 bytes
  const pad32 = (b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(32);
    const start = Math.max(0, b.length - 32);
    out.set(b.slice(start), 32 - (b.length - start));
    return out;
  };

  const raw = new Uint8Array(64);
  raw.set(pad32(r), 0);
  raw.set(pad32(s), 32);
  return raw;
}

// --- Standard claim validation ---

function validateClaims(
  payload: Record<string, unknown>,
  expectedAud: string,
  expectedIss: string
): void {
  // Expiry
  const exp = payload.exp as number | undefined;
  if (exp !== undefined && Date.now() / 1000 > exp) {
    throw Object.assign(new Error("Token expired"), { code: "auth_expired" });
  }

  // Audience — Supabase puts a single string, not an array
  const aud = payload.aud;
  const audOk =
    aud === expectedAud ||
    (Array.isArray(aud) && aud.includes(expectedAud));
  if (!audOk) throw new Error(`Invalid audience: ${String(aud)}`);

  // Issuer
  if (payload.iss !== expectedIss) {
    throw new Error(`Invalid issuer: ${String(payload.iss)}`);
  }
}

// --- Public resolve function ---

/**
 * Resolve the AuthContext from the incoming request headers.
 *
 * This does NOT enforce per-tool access control — that happens in the
 * tool dispatcher in index.ts using AUTH_REQUIRED_TOOLS and
 * OAUTH_TOOL_SCOPES.
 */
export async function resolveAuth(req: Request): Promise<AuthContext> {
  const authHeader = req.headers.get("Authorization");

  // --- Demo mode ---
  if (!authHeader) {
    return { kind: "demo" };
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw Object.assign(
      new Error("Authorization header must use Bearer scheme"),
      { code: "auth_invalid" }
    );
  }

  const token = authHeader.slice(7).trim();
  const header = decodeHeader(token);
  const alg = header.alg as string | undefined;

  // --- BYO JWT (HS256) path ---
  // If BYO_JWT_SECRET is set and the token uses HS256, try that path first.
  // BYO tokens don't need ALLOWED_AUDIENCE / ALLOWED_ISSUER — they're verified
  // by shared secret and identified by their own iss/sub semantics.
  const byoSecret = Deno.env.get("BYO_JWT_SECRET");
  if (byoSecret && alg === "HS256") {
    const payload = await verifyHS256(token, byoSecret);
    const exp = payload.exp as number | undefined;
    if (exp !== undefined && Date.now() / 1000 > exp) {
      throw Object.assign(new Error("BYO JWT expired"), { code: "auth_expired" });
    }
    const sub = (payload.sub as string | undefined) ?? "service";
    const scope = (payload.scope as string | undefined) ?? "shadow:all";
    return { kind: "byojwt", user_id: sub, scopes: scope.split(" ") };
  }

  // --- OAuth 2.1 path ---
  // Fail-closed: require operators to set both ALLOWED_AUDIENCE and
  // ALLOWED_ISSUER. The previous defaults ("authenticated" / "") meant any
  // valid Supabase user JWT for any project was accepted as an MCP token —
  // a classic confused-deputy hole (RFC 8707 §1).
  const allowedAud = Deno.env.get("ALLOWED_AUDIENCE");
  const allowedIss = Deno.env.get("ALLOWED_ISSUER");
  if (!allowedAud || !allowedIss) {
    throw Object.assign(
      new Error(
        "Server misconfigured: ALLOWED_AUDIENCE and ALLOWED_ISSUER env vars must be set"
      ),
      { code: "auth_invalid" }
    );
  }

  // Supabase Auth can issue HS256 tokens too — fall back to SUPABASE_JWT_SECRET.
  let payload: Record<string, unknown>;

  if (alg === "HS256") {
    const supabaseSecret = Deno.env.get("SUPABASE_JWT_SECRET");
    if (!supabaseSecret) {
      throw Object.assign(
        new Error("No SUPABASE_JWT_SECRET configured to verify HS256 token"),
        { code: "auth_invalid" }
      );
    }
    payload = await verifyHS256(token, supabaseSecret);
  } else {
    // RS256 or ES256 — verify via JWKS
    const jwksUrl = Deno.env.get("JWKS_URL");
    if (!jwksUrl) {
      throw Object.assign(
        new Error("No JWKS_URL configured to verify asymmetric token"),
        { code: "auth_invalid" }
      );
    }
    payload = await verifyRS256OrES256(token, jwksUrl);
  }

  validateClaims(payload, allowedAud, allowedIss);

  const sub = (payload.sub as string | undefined) ?? "";
  const scope = (payload.scope as string | undefined) ?? "";
  return { kind: "oauth", user_id: sub, scopes: scope.split(" ").filter(Boolean) };
}

/**
 * Check whether the given AuthContext is permitted to call a specific tool.
 * Returns an AuthError if access should be denied, or null if allowed.
 */
export function checkToolAccess(
  ctx: AuthContext,
  toolName: string
): AuthError | null {
  if (!AUTH_REQUIRED_TOOLS.has(toolName)) {
    // lookup_breed is public — no auth needed
    return null;
  }

  if (ctx.kind === "demo") {
    return {
      code: "auth_required",
      message:
        "🐾 This tool requires a Calming Paws account. Sign up to track your dog's walks, triggers, and progress over time.",
      cta: "https://calming-paws.com/",
    };
  }

  // BYO JWT: accepts the wildcard scope or any per-tool scope
  if (ctx.kind === "byojwt") {
    const scopes = ctx.scopes ?? [];
    const anyKnownScope =
      scopes.includes(WILDCARD_SCOPE) ||
      Object.values(OAUTH_TOOL_SCOPES).some((needed) =>
        needed.some((s) => scopes.includes(s))
      );
    if (!anyKnownScope) {
      return {
        code: "scope_missing",
        message: `BYO JWT is missing required scope. Token has: [${scopes.join(", ")}]`,
      };
    }
    return null;
  }

  // OAuth: enforce per-tool scope(s). All required scopes must be present
  // (or the wildcard "shadow:all").
  const required = OAUTH_TOOL_SCOPES[toolName] ?? [];
  if (required.length > 0) {
    const scopes = ctx.scopes ?? [];
    const hasAll =
      scopes.includes(WILDCARD_SCOPE) ||
      required.every((s) => scopes.includes(s));
    if (!hasAll) {
      return {
        code: "scope_missing",
        message: `This action requires scope(s) [${required.join(", ")}]. Re-authorise your Calming Paws connection to grant access.`,
        cta: "https://calming-paws.com/settings/integrations",
      };
    }
  }

  return null;
}
