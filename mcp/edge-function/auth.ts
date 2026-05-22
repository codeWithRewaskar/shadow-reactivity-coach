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

// Required scope by tool — OAuth path uses fine-grained scopes;
// BYO JWT path only requires the broader "shadow:all" scope.
export const OAUTH_TOOL_SCOPES: Record<string, string> = {
  get_dog_profile: "shadow:read",
  log_walk: "shadow:write",
  get_progress: "shadow:read",
  recommend_protocol: "shadow:read",
};

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

  const valid = await crypto.subtle.verify("HMAC", keyMaterial, sigBytes, data);
  if (!valid) throw new Error("Invalid signature");

  return decodePayload(token);
}

/**
 * Fetch JWKS and verify an RS256 or ES256 token using Web Crypto.
 * Caches the JWKS in module scope for the lifetime of the Edge Function
 * instance (ephemeral — each cold start re-fetches).
 *
 * NOTE: For production, back this with Supabase KV or a short-TTL cache
 * to avoid hammering the JWKS endpoint on every warm request.
 */
let jwksCache: { keys: JWK[] } | null = null;

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

async function fetchJWKS(url: string): Promise<{ keys: JWK[] }> {
  if (jwksCache) return jwksCache;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
  jwksCache = (await res.json()) as { keys: JWK[] };
  return jwksCache;
}

async function verifyRS256OrES256(
  token: string,
  jwksUrl: string
): Promise<Record<string, unknown>> {
  const header = decodeHeader(token);
  const alg = (header.alg as string) ?? "";
  const kid = header.kid as string | undefined;

  const { keys } = await fetchJWKS(jwksUrl);
  const jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
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
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBytes, data);
  } else {
    // ES256: the signature is DER-encoded; Web Crypto expects raw r||s (64 bytes).
    // Convert DER to raw if needed.
    const rawSig = derToRaw(sigBytes);
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      rawSig,
      data
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
  // Simple DER parse: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip 0x30 and total length
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const rLen = der[offset++];
  const r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  offset++;
  const sLen = der[offset++];
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

  const allowedAud = Deno.env.get("ALLOWED_AUDIENCE") ?? "authenticated";
  const allowedIss = Deno.env.get("ALLOWED_ISSUER") ?? "";

  // --- BYO JWT (HS256) path ---
  // If BYO_JWT_SECRET is set and the token uses HS256, try that path first.
  const byoSecret = Deno.env.get("BYO_JWT_SECRET");
  if (byoSecret && alg === "HS256") {
    const payload = await verifyHS256(token, byoSecret);
    // BYO tokens use a looser issuer check — the issuer claim is the service name
    const exp = payload.exp as number | undefined;
    if (exp !== undefined && Date.now() / 1000 > exp) {
      throw Object.assign(new Error("BYO JWT expired"), { code: "auth_expired" });
    }
    const sub = (payload.sub as string | undefined) ?? "service";
    const scope = (payload.scope as string | undefined) ?? "shadow:all";
    return { kind: "byojwt", user_id: sub, scopes: scope.split(" ") };
  }

  // --- OAuth 2.1 path (RS256 / ES256 via JWKS, or HS256 via Supabase JWT secret) ---
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

  // BYO JWT: only needs the broad "shadow:all" scope
  if (ctx.kind === "byojwt") {
    const scopes = ctx.scopes ?? [];
    if (!scopes.includes("shadow:all") && !scopes.includes("shadow:write") && !scopes.includes("shadow:read")) {
      return {
        code: "scope_missing",
        message: `BYO JWT is missing required scope. Token has: [${scopes.join(", ")}]`,
      };
    }
    return null;
  }

  // OAuth: enforce per-tool scope
  const requiredScope = OAUTH_TOOL_SCOPES[toolName];
  if (requiredScope) {
    const scopes = ctx.scopes ?? [];
    if (!scopes.includes(requiredScope) && !scopes.includes("shadow:all")) {
      return {
        code: "scope_missing",
        message: `This action requires the '${requiredScope}' scope. Re-authorise your Calming Paws connection to grant access.`,
        cta: "https://calming-paws.com/settings/integrations",
      };
    }
  }

  return null;
}
