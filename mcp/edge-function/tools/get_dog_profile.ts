/**
 * tools/get_dog_profile.ts
 *
 * Auth-required tool. Returns a dog profile for a given dog_id, sourced from
 * Supabase with RLS-gated access (the caller's forwarded JWT means
 * is_owner_of_dog / is_trainer_of_dog decides what's visible).
 *
 * Data plane:
 *   SELECT * FROM dog_profiles WHERE id = $1
 *   embed dog_triggers via PostgREST embedded resource
 *
 * The legacy MCP wire shape is preserved exactly — fields that don't yet exist
 * on the schema (weight_kg, active_protocols, reactivity_type) are stubbed with
 * safe defaults plus TODO markers for future schema work.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";
import { makeUserClient, type SupabaseClient } from "../db.ts";

// --- Zod schema ---

export const GetDogProfileParamsSchema = z.object({
  dog_id: z.string().uuid("dog_id must be a valid UUID"),
});

export type GetDogProfileParams = z.infer<typeof GetDogProfileParamsSchema>;

// --- Types ---

export interface DogProfile {
  dog_id: string;
  name: string;
  breed: string;
  age_years: number;
  weight_kg: number;
  reactivity_type: "fear-based" | "frustration-based" | "excitement-based" | "mixed";
  primary_triggers: string[];
  known_threshold_distance_feet: number;
  current_risk_level: 1 | 2 | 3 | 4 | 5;
  active_protocols: string[];
  notes: string;
  coaching_note: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

// --- Row shapes returned by the embedded SELECT ---

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

// --- Derivation helpers ---

/**
 * Compute age in years (rounded to 1 decimal) using the most precise signal
 * available: age_months → age → birthday → 0 (with age_unknown).
 */
function deriveAgeYears(row: DogProfileRow): number {
  if (typeof row.age_months === "number" && row.age_months >= 0) {
    return Math.round((row.age_months / 12) * 10) / 10;
  }
  if (typeof row.age === "number" && row.age >= 0) {
    return row.age;
  }
  if (row.birthday) {
    const bd = new Date(row.birthday);
    if (!isNaN(bd.getTime())) {
      const years = (Date.now() - bd.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      return Math.max(0, Math.round(years * 10) / 10);
    }
  }
  // age_unknown=true or fully missing — fall back to 0 without throwing.
  return 0;
}

/**
 * Top 5 trigger labels by severity desc, using custom_label when set.
 */
function deriveTriggers(triggers: DogTriggerRow[]): string[] {
  return [...triggers]
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
    .slice(0, 5)
    .map((t) => (t.custom_label && t.custom_label.length > 0 ? t.custom_label : t.trigger_type));
}

/**
 * Smallest distance_threshold across all triggers (meters in schema),
 * converted to feet. Defaults to 30 meters (~98 ft) if no triggers.
 */
function deriveThresholdDistanceFeet(triggers: DogTriggerRow[]): number {
  const distances = triggers
    .map((t) => t.distance_threshold)
    .filter((d): d is number => typeof d === "number" && d > 0);

  const minMeters = distances.length > 0 ? Math.min(...distances) : 30;
  return Math.round(minMeters * 3.28084);
}

/** Max severity across triggers, clamped to 1..5. Defaults to 1 if no triggers. */
function deriveRiskLevel(triggers: DogTriggerRow[]): 1 | 2 | 3 | 4 | 5 {
  if (triggers.length === 0) return 1;
  const max = triggers.reduce((m, t) => Math.max(m, t.severity ?? 0), 0);
  const clamped = Math.max(1, Math.min(5, Math.round(max)));
  return clamped as 1 | 2 | 3 | 4 | 5;
}

/**
 * Heuristic reactivity type from trigger names.
 * TODO: replace with an explicit `reactivity_type` column on dog_profiles.
 */
function deriveReactivityType(
  triggers: DogTriggerRow[]
): DogProfile["reactivity_type"] {
  if (triggers.length === 0) return "mixed";
  const labels = triggers
    .map((t) => `${t.trigger_type} ${t.custom_label ?? ""}`.toLowerCase())
    .join(" ");

  const fearHits = /fear|stranger|noise|thunder|firework|men|hat|loud/.test(labels);
  const frustrationHits = /barrier|fence|leash|other\s*dog|dog\b|greet/.test(labels);
  const excitementHits = /squirrel|bike|bicycle|cycl|jog|run|skate|scoot|car|traffic/.test(labels);

  const hits = [fearHits, frustrationHits, excitementHits].filter(Boolean).length;
  if (hits >= 2) return "mixed";
  if (fearHits) return "fear-based";
  if (frustrationHits) return "frustration-based";
  if (excitementHits) return "excitement-based";
  return "mixed";
}

/**
 * Generate a Shadow-voice coaching note grounded in the real fields.
 * Mirrors the tone of the previous mock note builder.
 */
function buildCoachingNote(p: DogProfile): string {
  const triggerStr =
    p.primary_triggers.length > 0
      ? p.primary_triggers.slice(0, 2).join(" and ")
      : "the triggers you're working on";

  let base: string;
  if (p.current_risk_level >= 4) {
    base = `🐾 ${p.name} is at risk level ${p.current_risk_level} right now — that's a clear signal to step back to a working distance where ${triggerStr} stay sub-threshold. No learning happens over threshold; recovery does.`;
  } else if (p.current_risk_level === 3) {
    base = `🐾 ${p.name} is at risk level 3 — still teachable. ${p.known_threshold_distance_feet} ft is a working distance, not a ceiling. Keep banking calm reps with ${triggerStr}.`;
  } else if (p.current_risk_level === 2) {
    base = `🐾 ${p.name} is in the sweet spot at risk level 2. This is where consistent DS/CC pays compounding interest — keep the sessions short and the wins frequent.`;
  } else {
    base = `🐾 ${p.name} is showing low reactivity right now — great baseline to build on. Use this stability to expand the working repertoire around ${triggerStr}.`;
  }

  if (p.current_risk_level >= 4) {
    base +=
      " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer alongside these techniques.";
  }
  return base;
}

// --- Error mapping (mirrors log_walk / get_progress) ---

function buildDbError(
  err: { code?: string; message?: string; status?: number } | null,
  dog_id: string
): ToolResult {
  console.error("[get_dog_profile] supabase error during profile fetch:", err);

  const status = err?.status;
  const code = err?.code;

  // RLS denial — PostgREST returns 401/403/406 with code PGRST301, or 42501
  // from Postgres' own RLS gate.
  const isRlsDenial =
    status === 401 ||
    status === 403 ||
    status === 406 ||
    code === "PGRST301" ||
    code === "42501";

  if (isRlsDenial) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "permission_denied",
            message: `You don't appear to own dog ${dog_id}. If this is your dog, re-authorise your Calming Paws connection and try again.`,
          }),
        },
      ],
      isError: true,
    };
  }

  // .single() no-rows or FK violation
  if (code === "PGRST116" || code === "23503") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "not_found",
            message: `Dog ${dog_id} not found.`,
          }),
        },
      ],
      isError: true,
    };
  }

  if (status && status >= 500) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "upstream_error",
            message: "Calming Paws data plane is unavailable. Try again shortly.",
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "internal_error",
          message: "Something went wrong fetching the dog profile.",
        }),
      },
    ],
    isError: true,
  };
}

function buildAuthRequiredError(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "auth_required",
          message:
            "🐾 This tool requires a Calming Paws account. Sign up to track your dog's walks, triggers, and progress over time.",
          cta: "https://calming-paws.com/",
        }),
      },
    ],
    isError: true,
  };
}

// --- Handler ---

/**
 * @param params  Validated tool params.
 * @param ctx     Auth context — must carry bearer_token for the data-plane call.
 * @param client  Optional injected Supabase client (used by tests). When omitted,
 *                a per-request client is built from ctx.bearer_token.
 */
export async function getDogProfile(
  params: GetDogProfileParams,
  ctx: AuthContext,
  client?: SupabaseClient
): Promise<ToolResult> {
  // Defensive: index.ts's checkToolAccess should already block demo callers,
  // but if a non-demo ctx somehow reaches here with no bearer_token, fail safely.
  if (!ctx.bearer_token) {
    return buildAuthRequiredError();
  }

  const db = client ?? makeUserClient(ctx.bearer_token);

  // SELECT dog_profiles JOIN dog_triggers via PostgREST embedded resource.
  // RLS gates visibility — is_owner_of_dog / is_trainer_of_dog.
  const { data, error } = await db
    .from("dog_profiles")
    .select(
      "id, name, breed, age, age_months, age_is_approximate, age_unknown, birthday, notes, dog_triggers(trigger_type, custom_label, severity, distance_threshold)"
    )
    .eq("id", params.dog_id)
    .single();

  if (error) {
    return buildDbError(
      error as unknown as { code?: string; message?: string; status?: number },
      params.dog_id
    );
  }

  if (!data) {
    // .single() typically surfaces no-rows as PGRST116 in `error`, but be defensive.
    return buildDbError({ code: "PGRST116" }, params.dog_id);
  }

  const row = data as unknown as DogProfileRow;
  const triggers = row.dog_triggers ?? [];

  const profile: DogProfile = {
    dog_id: row.id,
    name: row.name,
    breed: row.breed ?? "Unknown",
    age_years: deriveAgeYears(row),
    // TODO (schema): weight_kg is not in current dog_profiles. Add a `weight_kg`
    // column or accept this stays 0. Kept on the contract for client stability.
    weight_kg: 0,
    reactivity_type: deriveReactivityType(triggers),
    primary_triggers: deriveTriggers(triggers),
    known_threshold_distance_feet: deriveThresholdDistanceFeet(triggers),
    current_risk_level: deriveRiskLevel(triggers),
    // TODO (schema): active_protocols isn't modeled yet. Future: training_assignments
    // table or an `active_protocols text[]` column on dog_profiles.
    active_protocols: [],
    notes: row.notes ?? "",
    coaching_note: "", // filled below so we can read the derived fields
  };
  profile.coaching_note = buildCoachingNote(profile);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(profile),
      },
    ],
    isError: false,
  };
}
