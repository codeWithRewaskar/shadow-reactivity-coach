/**
 * log_walk_test.ts — Tests for the log_walk tool handler.
 *
 * Strategy: dependency-inject a fake SupabaseClient. We don't go over the
 * network — the fake captures inserts and replays canned responses. The handler
 * accepts a `client?` param for exactly this purpose.
 *
 * Run: `deno task test` (== `deno test --allow-env --allow-net`).
 */

import { assert, assertEquals } from "@std/assert";
import { logWalk } from "./tools/log_walk.ts";
import type { AuthContext } from "./auth.ts";
import type { SupabaseClient } from "./db.ts";

// --- Fake Supabase client builder ---

interface InsertCall {
  table: string;
  rows: unknown;
}

interface FakeOptions {
  /** Per-table error to return from insert. */
  errorsByTable?: Record<
    string,
    { code?: string; message?: string; status?: number } | undefined
  >;
}

function buildFakeClient(opts: FakeOptions = {}): {
  client: SupabaseClient;
  calls: InsertCall[];
} {
  const calls: InsertCall[] = [];

  const client = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          calls.push({ table, rows });
          const err = opts.errorsByTable?.[table];
          return Promise.resolve({ data: null, error: err ?? null });
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

// --- Auth context fixtures ---

const authCtx: AuthContext = {
  kind: "oauth",
  user_id: "user-1",
  scopes: ["walks:write"],
  bearer_token: "fake.jwt.token",
};

const DOG_ID = "11111111-1111-4111-8111-111111111111";

// --- Tests ---

Deno.test("log_walk: aversive guardrail short-circuits before DB call", async () => {
  const { client, calls } = buildFakeClient();
  const result = await logWalk(
    {
      dog_id: DOG_ID,
      triggers: ["other dogs"],
      threshold_score: 3,
      notes: "Tried a shock collar today.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "force_free_violation");
  assertEquals(calls.length, 0, "DB must not be touched when guardrail triggers");
});

Deno.test("log_walk: happy path inserts walk_logs + N walk_triggers rows", async () => {
  const { client, calls } = buildFakeClient();
  const result = await logWalk(
    {
      dog_id: DOG_ID,
      triggers: ["bicycles", "joggers"],
      threshold_score: 3,
      notes: "Good session at the park.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, false);

  // 1 walk_logs insert + 1 walk_triggers insert (with array of 2 rows)
  assertEquals(calls.length, 2);
  assertEquals(calls[0].table, "walk_logs");
  assertEquals(calls[1].table, "walk_triggers");

  const walkRow = calls[0].rows as { id: string; dog_profile_id: string; notes: string | null };
  assertEquals(walkRow.dog_profile_id, DOG_ID);
  assertEquals(walkRow.notes, "Good session at the park.");
  // Client-generated UUID
  assert(/^[0-9a-f-]{36}$/i.test(walkRow.id), "walk id should be a UUID");

  const triggerRows = calls[1].rows as Array<{
    walk_log_id: string;
    trigger_type: string;
    severity: number;
  }>;
  assertEquals(triggerRows.length, 2);
  assertEquals(triggerRows[0].walk_log_id, walkRow.id);
  assertEquals(triggerRows[0].severity, 3);
  assertEquals(triggerRows[0].trigger_type, "bicycles");
  assertEquals(triggerRows[1].trigger_type, "joggers");
  assertEquals(triggerRows[1].severity, 3);

  // Response shape
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.walk_id, walkRow.id);
  assertEquals(body.dog_id, DOG_ID);
  assertEquals(body.threshold_score, 3);
  assertEquals(body.triggers, ["bicycles", "joggers"]);
  assert(typeof body.coaching_note === "string" && body.coaching_note.length > 0);
});

Deno.test("log_walk: empty triggers list inserts only walk_logs", async () => {
  const { client, calls } = buildFakeClient();
  const result = await logWalk(
    {
      dog_id: DOG_ID,
      triggers: [],
      threshold_score: 1,
    },
    authCtx,
    client
  );

  assertEquals(result.isError, false);
  assertEquals(calls.length, 1, "only walk_logs row should be inserted");
  assertEquals(calls[0].table, "walk_logs");

  const body = JSON.parse(result.content[0].text);
  assertEquals(body.triggers, []);
  assert(typeof body.coaching_note === "string");
});

Deno.test("log_walk: RLS denial (403) → permission_denied", async () => {
  const { client } = buildFakeClient({
    errorsByTable: {
      walk_logs: { status: 403, code: "PGRST301", message: "permission denied" },
    },
  });

  const result = await logWalk(
    {
      dog_id: DOG_ID,
      triggers: ["other dogs"],
      threshold_score: 2,
    },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "permission_denied");
  // Don't leak raw error text
  assert(!body.message.includes("permission denied"), "must not leak raw db message");
});

Deno.test("log_walk: missing bearer_token returns auth_required", async () => {
  const ctxNoToken: AuthContext = {
    kind: "oauth",
    user_id: "user-1",
    scopes: ["walks:write"],
    // bearer_token intentionally omitted
  };
  // No client injected — the handler must short-circuit before reaching DB.
  const result = await logWalk(
    {
      dog_id: DOG_ID,
      triggers: ["joggers"],
      threshold_score: 2,
    },
    ctxNoToken
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "auth_required");
});
