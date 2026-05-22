/**
 * ratelimit.ts — Per-IP (demo) and per-user (auth'd) rate limiting.
 *
 * SCAFFOLD NOTE: This implementation uses an in-memory Map, which means:
 *   - Limits reset on every cold start (each Edge Function instance is fresh).
 *   - Concurrent instances do NOT share state — limits are per-instance.
 *
 * TODO (production): Replace the in-memory store with one of:
 *   - Upstash Redis (https://upstash.com/) via `npm:@upstash/redis`
 *   - Supabase KV (when generally available)
 *   - A Supabase Postgres table with a pg_cron sweep to clear old windows
 *
 * The public interface (checkRateLimit) stays the same regardless of backend.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** If not allowed, the number of seconds until the window resets. */
  retry_after?: number;
  remaining: number;
}

interface BucketEntry {
  count: number;
  /** Epoch seconds when this window expires. */
  windowEnd: number;
}

// Separate stores for demo (key = IP) and auth'd (key = user_id) callers.
const demoStore = new Map<string, BucketEntry>();
const authStore = new Map<string, BucketEntry>();

const WINDOW_SECONDS = 3600; // 1 hour sliding window

function getLimit(kind: "demo" | "auth"): number {
  if (kind === "demo") {
    return parseInt(Deno.env.get("DEMO_RATE_LIMIT_PER_HOUR") ?? "20", 10);
  }
  return parseInt(Deno.env.get("AUTH_RATE_LIMIT_PER_HOUR") ?? "200", 10);
}

function getBucket(
  store: Map<string, BucketEntry>,
  key: string
): BucketEntry {
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = store.get(key);

  if (!existing || existing.windowEnd <= nowSec) {
    // Start a fresh window
    const fresh: BucketEntry = { count: 0, windowEnd: nowSec + WINDOW_SECONDS };
    store.set(key, fresh);
    return fresh;
  }
  return existing;
}

/**
 * Check and increment the rate limit counter for a caller.
 *
 * @param kind   "demo" for unauthenticated IP-keyed callers,
 *               "auth" for authenticated user-keyed callers.
 * @param key    The IP address (demo) or user_id (auth).
 */
export function checkRateLimit(
  kind: "demo" | "auth",
  key: string
): RateLimitResult {
  const store = kind === "demo" ? demoStore : authStore;
  const limit = getLimit(kind);
  const bucket = getBucket(store, key);

  if (bucket.count >= limit) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      allowed: false,
      retry_after: bucket.windowEnd - nowSec,
      remaining: 0,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: limit - bucket.count,
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
