/**
 * get_dog_profile_test.ts — Tests for the get_dog_profile tool handler.
 *
 * Strategy: dependency-inject a fake SupabaseClient. We capture the chained
 * .from(...).select(...).eq(...).single() call and replay canned rows that
 * mirror the PostgREST embedded-resource shape (dog_profiles row carrying a
 * `dog_triggers` array).
 *
 * Run: `deno task test` (== `deno test --allow-env --allow-net`).
 */

import { assert, assertEquals } from "@std/assert";
import { getDogProfile } from "./tools/get_dog_profile.ts";
import type { AuthContext } from "./auth.ts";
import type { SupabaseClient } from "./db.ts";

// --- Fake Supabase client builder ---

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
  age: number | null;
  age_months: number | null;
  age_is_approximate: boolean | null;
  age_unknown: boolean | null;
  birthday: string | null;
  notes: string | null;
  dog_triggers: DogTriggerRow[] | null;
}

interface QueryRecord {
  table: string;
  select: string;
  filters: Array<{ op: string; col: string; val: unknown }>;
  terminal: "single" | null;
}

interface FakeOptions {
  row?: DogProfileRow | null;
  error?: { code?: string; message?: string; status?: number };
}

function buildFakeClient(opts: FakeOptions = {}): {
  client: SupabaseClient;
  queries: QueryRecord[];
} {
  const queries: QueryRecord[] = [];

  const client = {
    from(table: string) {
      const q: QueryRecord = { table, select: "", filters: [], terminal: null };
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
        single() {
          q.terminal = "single";
          return Promise.resolve({
            data: opts.error ? null : opts.row ?? null,
            error: opts.error ?? null,
          });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, queries };
}

// --- Auth context fixtures ---

const authCtx: AuthContext = {
  kind: "oauth",
  user_id: "user-1",
  scopes: ["profile:read"],
  bearer_token: "fake.jwt.token",
};

const DOG_ID = "33333333-3333-4333-8333-333333333333";

// --- Tests ---

Deno.test("get_dog_profile: happy path — derives age, risk, triggers, distance", async () => {
  const row: DogProfileRow = {
    id: DOG_ID,
    name: "Pepper",
    breed: "Border Collie",
    age: null,
    age_months: 42, // 3.5 years
    age_is_approximate: false,
    age_unknown: false,
    birthday: null,
    notes: "Recovering from a bad incident last month.",
    dog_triggers: [
      { trigger_type: "bicycles", custom_label: null, severity: 4, distance_threshold: 12 }, // ~39 ft
      { trigger_type: "other_dogs", custom_label: "joggers with dogs", severity: 3, distance_threshold: 9 }, // ~30 ft
      { trigger_type: "squirrels", custom_label: null, severity: 2, distance_threshold: 20 }, // ~66 ft
    ],
  };

  const { client, queries } = buildFakeClient({ row });
  const result = await getDogProfile({ dog_id: DOG_ID }, authCtx, client);

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);

  // Wire-contract field names preserved
  assertEquals(body.dog_id, DOG_ID);
  assertEquals(body.name, "Pepper");
  assertEquals(body.breed, "Border Collie");
  assertEquals(body.age_years, 3.5);

  // Risk = max severity = 4
  assertEquals(body.current_risk_level, 4);

  // Threshold = min(12, 9, 20) = 9m × 3.28084 ≈ 30 ft (rounded)
  assertEquals(body.known_threshold_distance_feet, Math.round(9 * 3.28084));

  // Triggers sorted severity DESC, length 3, custom_label wins when set
  assertEquals(body.primary_triggers.length, 3);
  assertEquals(body.primary_triggers[0], "bicycles");
  assertEquals(body.primary_triggers[1], "joggers with dogs");
  assertEquals(body.primary_triggers[2], "squirrels");

  // weight_kg stubbed (schema gap)
  assertEquals(body.weight_kg, 0);
  // active_protocols stubbed (schema gap)
  assertEquals(body.active_protocols, []);

  assertEquals(body.notes, "Recovering from a bad incident last month.");
  assert(typeof body.coaching_note === "string" && body.coaching_note.length > 0);

  // Query shape sanity
  assertEquals(queries.length, 1);
  assertEquals(queries[0].table, "dog_profiles");
  assertEquals(queries[0].terminal, "single");
  const idFilter = queries[0].filters.find((f) => f.op === "eq" && f.col === "id");
  assert(idFilter, "must filter by id");
  assertEquals(idFilter!.val, DOG_ID);
});

Deno.test("get_dog_profile: no triggers — defaults to risk=1, 30m distance, empty triggers", async () => {
  const row: DogProfileRow = {
    id: DOG_ID,
    name: "Bean",
    breed: "Mixed",
    age: 4,
    age_months: null,
    age_is_approximate: null,
    age_unknown: false,
    birthday: null,
    notes: null,
    dog_triggers: [],
  };

  const { client } = buildFakeClient({ row });
  const result = await getDogProfile({ dog_id: DOG_ID }, authCtx, client);

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);

  assertEquals(body.current_risk_level, 1);
  assertEquals(body.primary_triggers, []);
  // 30m default → ~98 ft
  assertEquals(body.known_threshold_distance_feet, Math.round(30 * 3.28084));
  // age from legacy `age` column
  assertEquals(body.age_years, 4);
  // notes coerced to empty string
  assertEquals(body.notes, "");
});

Deno.test("get_dog_profile: age_unknown with no months/birthday → age_years=0 (no throw)", async () => {
  const row: DogProfileRow = {
    id: DOG_ID,
    name: "Mystery",
    breed: null,
    age: null,
    age_months: null,
    age_is_approximate: null,
    age_unknown: true,
    birthday: null,
    notes: null,
    dog_triggers: null,
  };

  const { client } = buildFakeClient({ row });
  const result = await getDogProfile({ dog_id: DOG_ID }, authCtx, client);

  assertEquals(result.isError, false);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.age_years, 0);
  // breed null → "Unknown"
  assertEquals(body.breed, "Unknown");
  // null dog_triggers tolerated
  assertEquals(body.primary_triggers, []);
});

Deno.test("get_dog_profile: RLS denial (PGRST301) → permission_denied", async () => {
  const { client } = buildFakeClient({
    error: { status: 403, code: "PGRST301", message: "permission denied for table dog_profiles" },
  });

  const result = await getDogProfile({ dog_id: DOG_ID }, authCtx, client);

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "permission_denied");
  assert(
    !body.message.includes("permission denied for table"),
    "must not leak raw db message"
  );
});

Deno.test("get_dog_profile: not found (PGRST116) → not_found", async () => {
  const { client } = buildFakeClient({
    error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
  });

  const result = await getDogProfile({ dog_id: DOG_ID }, authCtx, client);

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "not_found");
});

Deno.test("get_dog_profile: missing bearer_token → auth_required", async () => {
  const ctxNoToken: AuthContext = {
    kind: "oauth",
    user_id: "user-1",
    scopes: ["profile:read"],
    // bearer_token intentionally omitted
  };
  // No client injected — handler must short-circuit before reaching DB.
  const result = await getDogProfile({ dog_id: DOG_ID }, ctxNoToken);

  assertEquals(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assertEquals(body.code, "auth_required");
});
