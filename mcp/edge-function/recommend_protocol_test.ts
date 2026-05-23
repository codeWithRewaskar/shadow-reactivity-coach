/**
 * recommend_protocol_test.ts — Tests for the recommend_protocol tool handler.
 *
 * Strategy: dependency-inject a fake SupabaseClient. The fake supports both
 * terminals the handler uses:
 *   - dog_profiles:  .from().select().eq().single()
 *   - walk_logs:     .from().select().eq().gte().limit()
 *
 * Run: `deno task test` (== `deno test --allow-env --allow-net`).
 */

import { assert, assertEquals } from "@std/assert";
import { recommendProtocol } from "./tools/recommend_protocol.ts";
import type { AuthContext } from "./auth.ts";
import type { SupabaseClient } from "./db.ts";

// --- Row shapes ---

interface DogTriggerRow {
  trigger_type: string;
  custom_label: string | null;
  severity: number | null;
  distance_threshold: number | null;
}

interface DogProfileRow {
  id: string;
  name: string;
  breed: string | null;
  notes: string | null;
  dog_triggers: DogTriggerRow[] | null;
}

interface WalkRow {
  id: string;
  date: string;
  walk_triggers: Array<{ trigger_type: string; severity: number | null }>;
}

interface QueryRecord {
  table: string;
  filters: Array<{ op: string; col: string; val: unknown }>;
  terminal: "single" | "limit" | null;
}

interface FakeOptions {
  dogRow?: DogProfileRow | null;
  dogError?: { code?: string; message?: string; status?: number };
  walkRows?: WalkRow[];
  walkError?: { code?: string; message?: string; status?: number };
}

function buildFakeClient(opts: FakeOptions = {}): {
  client: SupabaseClient;
  queries: QueryRecord[];
} {
  const queries: QueryRecord[] = [];

  const client = {
    from(table: string) {
      const q: QueryRecord = { table, filters: [], terminal: null };
      queries.push(q);

      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          q.filters.push({ op: "eq", col, val });
          return builder;
        },
        gte(col: string, val: unknown) {
          q.filters.push({ op: "gte", col, val });
          return builder;
        },
        single() {
          q.terminal = "single";
          return Promise.resolve({
            data: opts.dogError ? null : opts.dogRow ?? null,
            error: opts.dogError ?? null,
          });
        },
        limit(_n: number) {
          q.terminal = "limit";
          return Promise.resolve({
            data: opts.walkError ? null : opts.walkRows ?? [],
            error: opts.walkError ?? null,
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
  scopes: ["profile:read", "progress:read", "protocols:read"],
  bearer_token: "fake.jwt.token",
};

const DOG_ID = "44444444-4444-4444-8444-444444444444";

// --- Tests ---

Deno.test("recommend_protocol: aversive guardrail short-circuits before any DB call", async () => {
  const { client, queries } = buildFakeClient();

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "I want to try a prong collar for leash pulling.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "force_free_violation");
  assertEquals(queries.length, 0, "DB must not be touched when guardrail triggers");
});

Deno.test("recommend_protocol: happy path — uses profile, generates personalised protocol", async () => {
  const dogRow: DogProfileRow = {
    id: DOG_ID,
    name: "Pepper",
    breed: "Labrador Retriever",
    notes: "Pepper loves boiled chicken.",
    dog_triggers: [
      { trigger_type: "bicycles", custom_label: null, severity: 4, distance_threshold: 12 },
      { trigger_type: "other_dogs", custom_label: null, severity: 3, distance_threshold: 15 },
    ],
  };

  const { client, queries } = buildFakeClient({ dogRow, walkRows: [] });

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "Pepper pulls forward and lunges toward bicycles on our walks.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);

  // Wire-contract field names preserved
  assertEquals(body.dog_id, DOG_ID);
  assert(typeof body.protocol_name === "string" && body.protocol_name.length > 0);
  assert(body.protocol_name.includes("Pepper"), "protocol_name should be personalised with dog's name");
  assert(typeof body.reactivity_type_identified === "string");
  assert(typeof body.trigger_identified === "string");

  // Steps and equipment non-empty
  assert(Array.isArray(body.steps) && body.steps.length > 0, "steps non-empty");
  assert(Array.isArray(body.equipment) && body.equipment.length > 0, "equipment non-empty");

  // Lab is a recognised puller — breed equipment note should be prepended.
  assert(
    body.equipment[0].toLowerCase().includes("front-clip") &&
      body.equipment[0].toLowerCase().includes("labrador"),
    "should prepend breed-aware front-clip recommendation for Labrador"
  );

  // Treats note picks up the chicken hint from owner notes.
  assert(
    body.treats_recommendation.toLowerCase().includes("pepper") ||
      body.treats_recommendation.toLowerCase().includes("owner notes"),
    "treats note should reference owner notes when treat keywords appear"
  );

  // Coaching note present
  assert(
    typeof body.coaching_note === "string" && body.coaching_note.length > 0,
    "coaching_note non-empty"
  );

  // Should have hit both dog_profiles (single) and walk_logs (limit) tables.
  const tables = queries.map((q) => q.table);
  assert(tables.includes("dog_profiles"), "must fetch dog_profiles");
  // walk_logs lookup is best-effort; assert it's attempted.
  assert(tables.includes("walk_logs"), "should attempt recent-walks fetch");
});

Deno.test("recommend_protocol: dog not found (PGRST116) → not_found", async () => {
  const { client } = buildFakeClient({
    dogError: { code: "PGRST116", message: "no rows" },
  });

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "My dog reacts to joggers in the park.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "not_found");
});

Deno.test("recommend_protocol: dog has zero triggers — still generates protocol, acknowledges sparse data", async () => {
  const dogRow: DogProfileRow = {
    id: DOG_ID,
    name: "Bean",
    breed: "Mixed",
    notes: null,
    dog_triggers: [],
  };

  const { client } = buildFakeClient({ dogRow, walkRows: [] });

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "Bean barks and lunges at strangers on the sidewalk.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);

  assert(Array.isArray(body.steps) && body.steps.length > 0, "steps non-empty");
  assert(typeof body.coaching_note === "string" && body.coaching_note.length > 0);
  assert(
    body.coaching_note.toLowerCase().includes("don't have trigger data") ||
      body.coaching_note.toLowerCase().includes("trigger data for bean"),
    "coaching_note should acknowledge missing trigger data"
  );
});

Deno.test("recommend_protocol: RLS denial → permission_denied", async () => {
  const { client } = buildFakeClient({
    dogError: { status: 403, code: "PGRST301", message: "permission denied for table dog_profiles" },
  });

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "Reactive to other dogs in the neighbourhood.",
    },
    authCtx,
    client
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "permission_denied");
  assert(
    !body.message.includes("permission denied for table"),
    "must not leak raw db message"
  );
});

Deno.test("recommend_protocol: missing bearer_token → auth_required (no DB calls)", async () => {
  const ctxNoToken: AuthContext = {
    kind: "oauth",
    user_id: "user-1",
    scopes: ["profile:read"],
    // bearer_token intentionally omitted
  };

  const result = await recommendProtocol(
    {
      dog_id: DOG_ID,
      situation: "Pulls toward squirrels on every walk.",
    },
    ctxNoToken
  );

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "auth_required");
});
