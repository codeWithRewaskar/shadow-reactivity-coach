/**
 * get_progress_test.ts — Tests for the get_progress tool handler.
 *
 * Strategy: dependency-inject a fake SupabaseClient. We capture the chained
 * .from(...).select(...).eq(...).gte(...) call and replay canned rows. This
 * mirrors the PostgREST embedded-resource shape (walk_logs row carrying a
 * `walk_triggers` array).
 *
 * Run: `deno task test` (== `deno test --allow-env --allow-net`).
 */

import { assert, assertEquals } from "@std/assert";
import { getProgress } from "./tools/get_progress.ts";
import type { AuthContext } from "./auth.ts";
import type { SupabaseClient } from "./db.ts";

// --- Fake Supabase client builder ---

interface WalkRow {
  id: string;
  date: string;
  walk_triggers: Array<{ trigger_type: string; severity: number }>;
}

interface QueryRecord {
  table: string;
  select: string;
  filters: Array<{ op: string; col: string; val: unknown }>;
}

interface FakeOptions {
  rows?: WalkRow[];
  error?: { code?: string; message?: string; status?: number };
}

function buildFakeClient(opts: FakeOptions = {}): {
  client: SupabaseClient;
  queries: QueryRecord[];
} {
  const queries: QueryRecord[] = [];

  const client = {
    from(table: string) {
      const q: QueryRecord = { table, select: "", filters: [] };
      queries.push(q);

      const builder = {
        select(cols: string) {
          q.select = cols;
          return builder;
        },
        eq(col: string, val: unknown) {
          q.filters.push({ op: "eq", col, val });
          return builder;
        },
        gte(col: string, val: unknown) {
          q.filters.push({ op: "gte", col, val });
          // gte is the terminal call in our handler — return a thenable.
          return Promise.resolve({
            data: opts.error ? null : opts.rows ?? [],
            error: opts.error ?? null,
          });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, queries };
}

// --- Fixtures ---

const authCtx: AuthContext = {
  kind: "oauth",
  user_id: "user-1",
  scopes: ["progress:read"],
  bearer_token: "fake.jwt.token",
};

const DOG_ID = "22222222-2222-4222-8222-222222222222";

// Build a YYYY-MM-DD `n` days ago.
function daysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

// --- Tests ---

Deno.test("get_progress: empty result set → 0 sessions, stable, kind coaching note", async () => {
  const { client } = buildFakeClient({ rows: [] });
  const result = await getProgress(
    { dog_id: DOG_ID, window: "30d" },
    authCtx,
    client
  );

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.total_sessions, 0);
  assertEquals(body.threshold_trend, "stable");
  assertEquals(body.avg_threshold_score, 0);
  assertEquals(body.most_challenging_triggers, []);
  assertEquals(body.best_trigger, null);
  assertEquals(body.weekly_breakdown, []);
  assert(
    body.coaching_note.toLowerCase().includes("no walks") ||
      body.coaching_note.toLowerCase().includes("nothing to analyze"),
    "should be kind/empty-state coaching note"
  );
});

Deno.test("get_progress: improving trend across two halves", async () => {
  // First half (older): severity 4 — second half (newer): severity 2.
  // Delta = 2 - 4 = -2.0 ≤ -0.5 → improving
  const rows: WalkRow[] = [
    { id: "w1", date: daysAgoIso(20), walk_triggers: [{ trigger_type: "bicycles", severity: 4 }] },
    { id: "w2", date: daysAgoIso(18), walk_triggers: [{ trigger_type: "joggers", severity: 4 }] },
    { id: "w3", date: daysAgoIso(5),  walk_triggers: [{ trigger_type: "bicycles", severity: 2 }] },
    { id: "w4", date: daysAgoIso(2),  walk_triggers: [{ trigger_type: "joggers", severity: 2 }] },
  ];

  const { client } = buildFakeClient({ rows });
  const result = await getProgress(
    { dog_id: DOG_ID, window: "30d" },
    authCtx,
    client
  );

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.total_sessions, 4);
  assertEquals(body.threshold_trend, "improving");
  assertEquals(body.avg_threshold_score, 3);
  assert(Array.isArray(body.most_challenging_triggers));
  assert(body.best_trigger !== null);
  assert(body.weekly_breakdown.length > 0);
  assert(
    body.coaching_note.toLowerCase().includes("improving") ||
      body.coaching_note.includes("✅"),
    "improving coaching note should sound positive"
  );
});

Deno.test("get_progress: window=30d is respected in the gte filter", async () => {
  const { client, queries } = buildFakeClient({ rows: [] });
  await getProgress({ dog_id: DOG_ID, window: "30d" }, authCtx, client);

  assertEquals(queries.length, 1);
  const q = queries[0];
  assertEquals(q.table, "walk_logs");

  const eqFilter = q.filters.find((f) => f.op === "eq" && f.col === "dog_profile_id");
  assert(eqFilter, "must filter by dog_profile_id");
  assertEquals(eqFilter!.val, DOG_ID);

  const gteFilter = q.filters.find((f) => f.op === "gte" && f.col === "date");
  assert(gteFilter, "must filter by date >= now() - window");
  // The value should be a YYYY-MM-DD ~30 days ago. Sanity check it parses and
  // is within a day of expected.
  const filterDate = new Date(gteFilter!.val as string);
  const expected = new Date();
  expected.setUTCDate(expected.getUTCDate() - 30);
  const diffDays = Math.abs(
    (filterDate.getTime() - expected.getTime()) / (24 * 60 * 60 * 1000)
  );
  assert(diffDays < 1.5, `gte filter should be ~30d ago, was ${gteFilter!.val}`);
});

Deno.test("get_progress: RLS denial → permission_denied", async () => {
  const { client } = buildFakeClient({
    error: { status: 403, code: "PGRST301", message: "permission denied" },
  });

  const result = await getProgress(
    { dog_id: DOG_ID, window: "30d" },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "permission_denied");
  assert(!body.message.includes("permission denied"), "must not leak raw db message");
});
