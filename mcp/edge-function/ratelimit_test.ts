/**
 * ratelimit_test.ts — Tests for the in-memory rate limiter.
 *
 * Run: `deno test --allow-env mcp/edge-function/ratelimit_test.ts`
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkRateLimit, getClientIP } from "./ratelimit.ts";

Deno.test("demo path: allows up to DEMO_RATE_LIMIT_PER_HOUR then blocks", () => {
  Deno.env.set("DEMO_RATE_LIMIT_PER_HOUR", "3");
  const key = `ip-${crypto.randomUUID()}`;
  for (let i = 0; i < 3; i += 1) {
    assert(checkRateLimit("demo", key).allowed, `request ${i + 1} should pass`);
  }
  const blocked = checkRateLimit("demo", key);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.remaining, 0);
  assert((blocked.retry_after ?? 0) > 0, "retry_after should be positive");
});

Deno.test("auth path: independent counter from demo path", () => {
  Deno.env.set("DEMO_RATE_LIMIT_PER_HOUR", "1");
  Deno.env.set("AUTH_RATE_LIMIT_PER_HOUR", "2");
  const key = `user-${crypto.randomUUID()}`;
  assert(checkRateLimit("auth", key).allowed);
  assert(checkRateLimit("auth", key).allowed);
  assertEquals(checkRateLimit("auth", key).allowed, false);
});

Deno.test("getClientIP prefers x-forwarded-for, then cf-connecting-ip, then 'unknown'", () => {
  const xff = new Request("https://x/", {
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
  });
  assertEquals(getClientIP(xff), "1.2.3.4");

  const cf = new Request("https://x/", { headers: { "cf-connecting-ip": "9.9.9.9" } });
  assertEquals(getClientIP(cf), "9.9.9.9");

  const none = new Request("https://x/");
  assertEquals(getClientIP(none), "unknown");
});
