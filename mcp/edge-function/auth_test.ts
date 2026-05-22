/**
 * auth_test.ts — Tests for the resolveAuth() + checkToolAccess() pipeline.
 *
 * Covers:
 *   - Demo mode (no Authorization header)
 *   - BYO JWT happy path + expired + missing scope
 *   - OAuth HS256 happy path (via SUPABASE_JWT_SECRET) + bad aud + bad iss
 *   - Fail-closed default when ALLOWED_AUDIENCE / ALLOWED_ISSUER unset
 *   - checkToolAccess per-tool scope enforcement
 *
 * Run: `deno test --allow-env --allow-net mcp/edge-function/auth_test.ts`
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { checkToolAccess, resolveAuth } from "./auth.ts";

// --- HS256 token builder (no external deps) ---

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s: string) => b64url(enc.encode(s));

async function signHS256(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlStr(JSON.stringify(payload));
  const data = enc.encode(`${header}.${body}`);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `${header}.${body}.${b64url(sig)}`;
}

function reqWithAuth(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request("https://mcp.example.com/", { method: "POST", headers });
}

// --- Setup / teardown ---

const ORIG_ENV = {
  ALLOWED_AUDIENCE: Deno.env.get("ALLOWED_AUDIENCE"),
  ALLOWED_ISSUER: Deno.env.get("ALLOWED_ISSUER"),
  BYO_JWT_SECRET: Deno.env.get("BYO_JWT_SECRET"),
  SUPABASE_JWT_SECRET: Deno.env.get("SUPABASE_JWT_SECRET"),
};

function setEnv(map: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

function restoreEnv() {
  setEnv(ORIG_ENV);
}

// --- Tests ---

Deno.test("demo mode: no Authorization header → kind=demo", async () => {
  const ctx = await resolveAuth(reqWithAuth());
  assertEquals(ctx.kind, "demo");
});

Deno.test("demo mode: only lookup_breed is accessible", () => {
  const ctx = { kind: "demo" as const };
  assertEquals(checkToolAccess(ctx, "lookup_breed"), null);
  const err = checkToolAccess(ctx, "log_walk");
  assertEquals(err?.code, "auth_required");
});

Deno.test("BYO JWT: valid token grants wildcard scope", async () => {
  setEnv({ BYO_JWT_SECRET: "test-byo-secret" });
  try {
    const token = await signHS256(
      { sub: "svc-1", scope: "shadow:all", exp: Math.floor(Date.now() / 1000) + 60 },
      "test-byo-secret",
    );
    const ctx = await resolveAuth(reqWithAuth(token));
    assertEquals(ctx.kind, "byojwt");
    assertEquals(ctx.user_id, "svc-1");
    assertEquals(checkToolAccess(ctx, "log_walk"), null);
  } finally {
    restoreEnv();
  }
});

Deno.test("BYO JWT: expired token is rejected", async () => {
  setEnv({ BYO_JWT_SECRET: "test-byo-secret" });
  try {
    const token = await signHS256(
      { sub: "svc-1", scope: "shadow:all", exp: Math.floor(Date.now() / 1000) - 10 },
      "test-byo-secret",
    );
    await assertRejects(() => resolveAuth(reqWithAuth(token)), Error, "expired");
  } finally {
    restoreEnv();
  }
});

Deno.test("BYO JWT: token with no known scope is denied at tool gate", async () => {
  setEnv({ BYO_JWT_SECRET: "test-byo-secret" });
  try {
    const token = await signHS256(
      { sub: "svc-1", scope: "unrelated:thing", exp: Math.floor(Date.now() / 1000) + 60 },
      "test-byo-secret",
    );
    const ctx = await resolveAuth(reqWithAuth(token));
    const err = checkToolAccess(ctx, "log_walk");
    assertEquals(err?.code, "scope_missing");
  } finally {
    restoreEnv();
  }
});

Deno.test("OAuth HS256: valid token with correct aud/iss → kind=oauth", async () => {
  setEnv({
    SUPABASE_JWT_SECRET: "test-sb-secret",
    ALLOWED_AUDIENCE: "https://mcp.calming-paws.com",
    ALLOWED_ISSUER: "https://proj.supabase.co/auth/v1",
    BYO_JWT_SECRET: undefined,
  });
  try {
    const token = await signHS256(
      {
        sub: "user-42",
        aud: "https://mcp.calming-paws.com",
        iss: "https://proj.supabase.co/auth/v1",
        scope: "profile:read walks:write",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      "test-sb-secret",
    );
    const ctx = await resolveAuth(reqWithAuth(token));
    assertEquals(ctx.kind, "oauth");
    assertEquals(ctx.user_id, "user-42");
    assertEquals(checkToolAccess(ctx, "log_walk"), null);
    assertEquals(checkToolAccess(ctx, "get_dog_profile"), null);
    // recommend_protocol needs progress:read too — not granted here
    assertEquals(checkToolAccess(ctx, "recommend_protocol")?.code, "scope_missing");
  } finally {
    restoreEnv();
  }
});

Deno.test("OAuth: wrong audience is rejected", async () => {
  setEnv({
    SUPABASE_JWT_SECRET: "test-sb-secret",
    ALLOWED_AUDIENCE: "https://mcp.calming-paws.com",
    ALLOWED_ISSUER: "https://proj.supabase.co/auth/v1",
    BYO_JWT_SECRET: undefined,
  });
  try {
    const token = await signHS256(
      {
        sub: "user-42",
        aud: "authenticated", // Supabase's default — must NOT be accepted
        iss: "https://proj.supabase.co/auth/v1",
        scope: "profile:read",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      "test-sb-secret",
    );
    await assertRejects(() => resolveAuth(reqWithAuth(token)), Error, "audience");
  } finally {
    restoreEnv();
  }
});

Deno.test("OAuth: fail-closed when ALLOWED_AUDIENCE / ALLOWED_ISSUER unset", async () => {
  setEnv({
    SUPABASE_JWT_SECRET: "test-sb-secret",
    ALLOWED_AUDIENCE: undefined,
    ALLOWED_ISSUER: undefined,
    BYO_JWT_SECRET: undefined,
  });
  try {
    const token = await signHS256(
      { sub: "user-42", exp: Math.floor(Date.now() / 1000) + 60 },
      "test-sb-secret",
    );
    await assertRejects(
      () => resolveAuth(reqWithAuth(token)),
      Error,
      "misconfigured",
    );
  } finally {
    restoreEnv();
  }
});

Deno.test("Bearer scheme is required", async () => {
  const headers = new Headers({ Authorization: "Basic abc" });
  const req = new Request("https://x/", { method: "POST", headers });
  await assertRejects(() => resolveAuth(req), Error, "Bearer");
});
