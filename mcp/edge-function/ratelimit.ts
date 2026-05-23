/**
 * ratelimit.ts — Per-IP (demo) and per-user (auth'd) rate limiting.
 *
 * Backed by the KvStore abstraction in `./kv.ts`. When Deno KV is available
 * (Deno Deploy, recent Deno) the counters are stored there with atomic
 * compare-and-swap semantics so concurrent requests cannot double-count or
 * lose a window-reset. When Deno KV is unavailable (some Supabase Edge
 * Function deployments) the abstraction transparently falls back to an
 * in-memory Map and limits are per-instance.
 *
 * Public surface kept stable for callers:
 *   - `checkRateLimit(kind, key)` — note: now async, callers must `await`.
 *   - `getClientIP(req)`          — unchanged.
 *   - `RateLimitResult` interface — unchanged shape.
 */

import { kv } from "./kv.ts";

export interface RateLimitResult {
  allowed: boolean;
  /** If not allowed, the number of seconds until the window resets. */
  retry_after?: number;
  remaining: number;
}

const WINDOW_SECONDS = 3600; // 1 hour fixed window
const WINDOW_MS = WINDOW_SECONDS * 1000;

function getLimit(kind: "demo" | "auth"): number {
  if (kind === "demo") {
    return parseInt(Deno.env.get("DEMO_RATE_LIMIT_PER_HOUR") ?? "20", 10);
  }
  return parseInt(Deno.env.get("AUTH_RATE_LIMIT_PER_HOUR") ?? "200", 10);
}

/**
 * Check and increment the rate-limit counter for a caller.
 *
 * @param kind  "demo" for unauthenticated IP-keyed callers, "auth" for
 *              authenticated user-keyed callers.
 * @param key   The IP address (demo) or user_id (auth).
 *
 * NOTE: This function is async because the underlying store can be remote
 * (Deno KV). Callers MUST `await` it.
 */
export async function checkRateLimit(
  kind: "demo" | "auth",
  key: string,
): Promise<RateLimitResult> {
  const store = await kv;
  const limit = getLimit(kind);
  const { count, windowEnd } = await store.incrementCounter(kind, key, WINDOW_MS);

  if (count > limit) {
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = Math.floor(windowEnd / 1000);
    const retryAfter = Math.max(1, endSec - nowSec);
    return {
      allowed: false,
      retry_after: retryAfter,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    remaining: limit - count,
  };
}

/**
 * Extract a best-effort client IP from the request.
 * Edge Functions typically receive the real IP in X-Forwarded-For.
 */
export function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}
