/**
 * ratelimit_test.ts — Tests for the rate limiter and the in-memory KvStore
 * fallback. The Deno KV backend is not tested here because `Deno.openKv()`
 * requires `--unstable-kv` on some Deno versions and adds permission
 * complexity that isn't worth pulling into the default test path.
 *
 * Run: `deno task test`        (the project task)
 *   or `deno test --allow-env --allow-net mcp/edge-function/ratelimit_test.ts`
 *
 * TODO: Add an opt-in integration suite that exercises `DenoKvStore` when
 *       the `KV_TEST=1` environment variable is set.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkRateLimit, getClientIP } from "./ratelimit.ts";
import { InMemoryKvStore } from "./kv.ts";

// ---------------------------------------------------------------------------
// checkRateLimit — exercises the public async API end-to-end against the
// module-level KvStore singleton (which falls back to InMemoryKvStore in the
// default test environment because Deno.openKv is gated).
// ---------------------------------------------------------------------------

Deno.test("demo path: allows up to DEMO_RATE_LIMIT_PER_HOUR then blocks", async () => {
  Deno.env.set("DEMO_RATE_LIMIT_PER_HOUR", "3");
  const key = `ip-${crypto.randomUUID()}`;
  for (let i = 0; i < 3; i += 1) {
    assert((await checkRateLimit("demo", key)).allowed, `request ${i + 1} should pass`);
  }
  const blocked = await checkRateLimit("demo", key);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.remaining, 0);
  assert((blocked.retry_after ?? 0) > 0, "retry_after should be positive");
});

Deno.test("auth path: independent counter from demo path", async () => {
  Deno.env.set("DEMO_RATE_LIMIT_PER_HOUR", "1");
  Deno.env.set("AUTH_RATE_LIMIT_PER_HOUR", "2");
  const key = `user-${crypto.randomUUID()}`;
  assert((await checkRateLimit("auth", key)).allowed);
  assert((await checkRateLimit("auth", key)).allowed);
  assertEquals((await checkRateLimit("auth", key)).allowed, false);
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

// ---------------------------------------------------------------------------
// InMemoryKvStore — direct unit tests covering the contract that
// `ratelimit.ts` relies on.
// ---------------------------------------------------------------------------

Deno.test("InMemoryKvStore: demo and auth buckets are isolated", async () => {
  const store = new InMemoryKvStore();
  const key = `iso-${crypto.randomUUID()}`;

  const d1 = await store.incrementCounter("demo", key, 60_000);
  const d2 = await store.incrementCounter("demo", key, 60_000);
  const a1 = await store.incrementCounter("auth", key, 60_000);

  assertEquals(d1.count, 1);
  assertEquals(d2.count, 2);
  assertEquals(a1.count, 1, "auth bucket must be independent of demo bucket");
});

Deno.test("InMemoryKvStore: window rolls over after TTL", async () => {
  const store = new InMemoryKvStore();
  const key = `roll-${crypto.randomUUID()}`;
  const ttlMs = 25;

  const first = await store.incrementCounter("demo", key, ttlMs);
  assertEquals(first.count, 1);

  // Sleep past the window end. Add a small margin to avoid flakiness.
  await new Promise((r) => setTimeout(r, ttlMs + 15));

  const afterRoll = await store.incrementCounter("demo", key, ttlMs);
  assertEquals(afterRoll.count, 1, "counter must reset once window has elapsed");
  assert(afterRoll.windowEnd > first.windowEnd, "windowEnd must advance on roll-over");
});

Deno.test("InMemoryKvStore: session set / has / delete + TTL expiry", async () => {
  const store = new InMemoryKvStore();
  const id = `sess-${crypto.randomUUID()}`;

  assertEquals(await store.hasSession(id), false);
  await store.setSession(id, { created_at: Date.now() }, 50);
  assertEquals(await store.hasSession(id), true);

  await store.deleteSession(id);
  assertEquals(await store.hasSession(id), false);

  // TTL expiry
  const id2 = `sess-${crypto.randomUUID()}`;
  await store.setSession(id2, { created_at: Date.now() }, 20);
  await new Promise((r) => setTimeout(r, 35));
  assertEquals(await store.hasSession(id2), false, "session should expire after TTL");
});

Deno.test("InMemoryKvStore: concurrent increments do not double-count", async () => {
  // Note: this is single-threaded JS so it documents the contract more than
  // it stress-tests it. The atomic increment-and-create-window-on-first-touch
  // semantics live inside the implementation, so Promise.all on the same key
  // must produce exactly N increments.
  const store = new InMemoryKvStore();
  const key = `concur-${crypto.randomUUID()}`;
  const N = 25;

  const results = await Promise.all(
    Array.from({ length: N }, () => store.incrementCounter("auth", key, 60_000)),
  );

  const counts = results.map((r) => r.count).sort((a, b) => a - b);
  assertEquals(counts, Array.from({ length: N }, (_, i) => i + 1));
  // Final stored value must equal N when read once more.
  const final = await store.incrementCounter("auth", key, 60_000);
  assertEquals(final.count, N + 1);
});
