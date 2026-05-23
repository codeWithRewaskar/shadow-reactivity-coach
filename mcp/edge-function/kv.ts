/**
 * kv.ts — Pluggable key/value abstraction for sessions + rate-limit counters.
 *
 * Two implementations are exposed:
 *   - DenoKvStore     — backed by `Deno.openKv()`. Uses Deno KV's `expireIn`
 *                       for TTL-based session expiry and Deno KV's atomic
 *                       operations for race-free rate-limit increments.
 *   - InMemoryKvStore — Map-backed fallback used when Deno KV is unavailable.
 *                       State is per-instance and resets on cold start.
 *
 * Why both?
 * Supabase Edge Functions historically did not enable Deno KV (the runtime
 * disables `Deno.openKv()` in some deployment contexts). Support is in flux;
 * the fallback exists so the function still boots and runs cleanly when KV
 * is unavailable. `pickKvStore()` probes once at module load and picks the
 * best backend.
 *
 * Deno KV is stable in Deno 2.x and does NOT require `--unstable-kv` on
 * Deno Deploy or recent Deno releases. We still wrap the `Deno.openKv()`
 * call in try/catch in case the runtime denies the operation.
 */

export interface Session {
  created_at: number;
  user_id?: string;
}

export interface KvStore {
  // --- sessions ---
  setSession(id: string, value: Session, ttlMs: number): Promise<void>;
  hasSession(id: string): Promise<boolean>;
  deleteSession(id: string): Promise<void>;

  // --- rate-limit counters ---
  /**
   * Atomically increment the counter for (namespace, key) and return the new
   * count plus the window end timestamp (epoch ms).
   *
   * If no window exists, or the existing window has already expired, a new
   * window is started with `windowEnd = Date.now() + ttlMs` and `count = 1`.
   *
   * The atomic semantics live inside this method on purpose: the caller does
   * not get a chance to insert a read-then-write race.
   */
  incrementCounter(
    namespace: "demo" | "auth",
    key: string,
    ttlMs: number,
  ): Promise<{ count: number; windowEnd: number }>;
}

// ---------------------------------------------------------------------------
// InMemoryKvStore — Map-backed, equivalent to the previous behavior.
// ---------------------------------------------------------------------------

interface CounterEntry {
  count: number;
  /** Epoch ms when this window ends. */
  windowEnd: number;
}

export class InMemoryKvStore implements KvStore {
  private readonly sessions = new Map<string, { value: Session; expiresAt: number }>();
  private readonly counters = new Map<string, CounterEntry>();

  setSession(id: string, value: Session, ttlMs: number): Promise<void> {
    this.sessions.set(id, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  hasSession(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return Promise.resolve(false);
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    return Promise.resolve();
  }

  incrementCounter(
    namespace: "demo" | "auth",
    key: string,
    ttlMs: number,
  ): Promise<{ count: number; windowEnd: number }> {
    const composite = `${namespace}:${key}`;
    const now = Date.now();
    const existing = this.counters.get(composite);

    if (!existing || existing.windowEnd <= now) {
      const fresh: CounterEntry = { count: 1, windowEnd: now + ttlMs };
      this.counters.set(composite, fresh);
      return Promise.resolve({ count: fresh.count, windowEnd: fresh.windowEnd });
    }

    existing.count += 1;
    return Promise.resolve({ count: existing.count, windowEnd: existing.windowEnd });
  }
}

// ---------------------------------------------------------------------------
// DenoKvStore — uses Deno's built-in distributed KV.
// ---------------------------------------------------------------------------

// Minimal structural types so this file compiles even when the Deno.Kv types
// aren't in scope (some Deno versions / lints). We only use a handful of
// methods so duck-typing is fine.
interface DenoKvHandle {
  get(key: readonly unknown[]): Promise<{ value: unknown; versionstamp: string | null }>;
  set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ ok: true }>;
  delete(key: readonly unknown[]): Promise<void>;
  atomic(): DenoKvAtomicHandle;
  close(): void;
}

interface DenoKvAtomicHandle {
  check(...checks: Array<{ key: readonly unknown[]; versionstamp: string | null }>): DenoKvAtomicHandle;
  set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicHandle;
  commit(): Promise<{ ok: boolean }>;
}

export class DenoKvStore implements KvStore {
  constructor(private readonly kv: DenoKvHandle) {}

  async setSession(id: string, value: Session, ttlMs: number): Promise<void> {
    await this.kv.set(["session", id], value, { expireIn: ttlMs });
  }

  async hasSession(id: string): Promise<boolean> {
    const res = await this.kv.get(["session", id]);
    return res.value !== null && res.value !== undefined;
  }

  async deleteSession(id: string): Promise<void> {
    await this.kv.delete(["session", id]);
  }

  async incrementCounter(
    namespace: "demo" | "auth",
    key: string,
    ttlMs: number,
  ): Promise<{ count: number; windowEnd: number }> {
    const kvKey = ["ratelimit", namespace, key];

    // Optimistic concurrency loop: read current entry, attempt atomic update,
    // retry on commit failure. Bound the retries to avoid pathological loops.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.kv.get(kvKey);
      const now = Date.now();
      const existing = current.value as CounterEntry | null;

      let next: CounterEntry;
      let expireIn: number;
      if (!existing || existing.windowEnd <= now) {
        next = { count: 1, windowEnd: now + ttlMs };
        expireIn = ttlMs;
      } else {
        next = { count: existing.count + 1, windowEnd: existing.windowEnd };
        // Keep the KV row alive until the existing window ends.
        expireIn = Math.max(1000, existing.windowEnd - now);
      }

      const commit = await this.kv
        .atomic()
        .check({ key: kvKey, versionstamp: current.versionstamp })
        .set(kvKey, next, { expireIn })
        .commit();

      if (commit.ok) {
        return { count: next.count, windowEnd: next.windowEnd };
      }
      // Contention — retry.
    }

    // Pathological contention: fall back to a best-effort non-atomic write so
    // we still emit a sensible answer instead of throwing. This is extremely
    // unlikely in practice for a single-IP / single-user counter.
    const current = await this.kv.get(kvKey);
    const now = Date.now();
    const existing = current.value as CounterEntry | null;
    const next: CounterEntry =
      !existing || existing.windowEnd <= now
        ? { count: 1, windowEnd: now + ttlMs }
        : { count: existing.count + 1, windowEnd: existing.windowEnd };
    await this.kv.set(kvKey, next, { expireIn: Math.max(1000, next.windowEnd - now) });
    return { count: next.count, windowEnd: next.windowEnd };
  }
}

// ---------------------------------------------------------------------------
// Backend selection — runs once at module load.
// ---------------------------------------------------------------------------

async function pickKvStore(): Promise<KvStore> {
  // `Deno.openKv` may not exist in some runtimes; treat it as optional.
  const denoNs = (globalThis as { Deno?: { openKv?: () => Promise<DenoKvHandle> } }).Deno;
  const opener = denoNs?.openKv;

  if (typeof opener === "function") {
    try {
      const handle = await opener.call(denoNs);
      console.log("[shadow-coach] kv: using Deno KV backend");
      return new DenoKvStore(handle);
    } catch (err) {
      console.warn(
        "[shadow-coach] kv: Deno.openKv() failed, falling back to in-memory store " +
          "(state is per-instance and resets on cold start). Error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    console.warn(
      "[shadow-coach] kv: Deno.openKv unavailable; using in-memory store " +
        "(state is per-instance and resets on cold start).",
    );
  }
  return new InMemoryKvStore();
}

/**
 * Module-level singleton, resolved eagerly at first import.
 * Callers `await kv` (it's a Promise) to get the chosen KvStore.
 */
export const kv: Promise<KvStore> = pickKvStore();
