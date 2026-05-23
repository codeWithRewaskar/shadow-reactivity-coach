/**
 * tools/log_walk.ts
 *
 * Auth-required tool. Logs a walk session for a dog.
 *
 * Force-free guardrail: if notes or trigger descriptions mention aversive
 * methods (shock collar, prong, alpha roll, etc.), the tool refuses to log
 * and returns a helpful redirect — mirroring SKILL.md's hard guardrail.
 *
 * Data plane:
 *   - INSERT one row into walk_logs (client-generated UUID to avoid the
 *     .select().single()-after-insert RLS race).
 *   - INSERT N rows into walk_triggers (one per trigger), all carrying the
 *     same threshold_score as severity (peak score for the walk).
 *   - RLS handles authz: is_owner_of_dog rejects the INSERT if the calling
 *     user (identified via their forwarded JWT) doesn't own the dog.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";
import { makeUserClient, type SupabaseClient } from "../db.ts";

// --- Zod schema ---

export const LogWalkParamsSchema = z.object({
  dog_id: z.string().uuid("dog_id must be a valid UUID"),
  triggers: z
    .array(z.string().min(1).max(200))
    .min(0)
    .max(20)
    .describe("List of triggers observed during the walk"),
  threshold_score: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Reactivity level during walk (1 = calm, 5 = over threshold)"),
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe("Free-text session notes"),
});

export type LogWalkParams = z.infer<typeof LogWalkParamsSchema>;

// --- Types ---

export interface WalkLogConfirmation {
  walk_id: string;
  dog_id: string;
  logged_at: string;
  triggers: string[];
  threshold_score: number;
  notes?: string;
  coaching_note: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

// --- Force-free guardrail ---

/**
 * Keyword patterns that indicate aversive methods.
 * Matches SKILL.md hard guardrail trigger keywords plus common variations.
 */
const AVERSIVE_PATTERNS = [
  /shock\s*collar/i,
  /e[\s-]?collar/i,
  /prong\s*collar/i,
  /choke\s*chain/i,
  /choke\s*collar/i,
  /alpha\s*roll/i,
  /dominan(ce|t)/i,
  /punish(ment|ed|ing)?/i,
  /correction\s*collar/i,
  /\bforce\b/i,
  /\bhurt\b/i,
  /\bharm\b/i,
  /\baversive\b/i,
  /\bpack\s*leader\b/i,
];

function detectAversive(text: string): boolean {
  return AVERSIVE_PATTERNS.some((re) => re.test(text));
}

function buildAversiveError(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "force_free_violation",
          message:
            "🐾 I noticed something in your notes that suggests an aversive tool or punishment-based method. Shadow only supports force-free, positive-reinforcement training. Aversive methods are contraindicated for reactive dogs — they increase anxiety and can make reactivity worse, not better.\n\nIf you're feeling stuck, I'd love to help you find a positive approach that works. You can also connect with a certified force-free trainer via the IAABC directory: https://iaabc.org/consultants\n\nFor the full Calming Paws experience, visit https://calming-paws.com/",
          resources: [
            "IAABC Member Directory: https://iaabc.org/consultants",
            "Pet Professional Guild: https://www.petprofessionalguild.com/",
          ],
        }),
      },
    ],
    isError: true,
  };
}

// --- Coaching notes by threshold score ---

function buildCoachingNote(score: number, triggers: string[]): string {
  const triggerStr = triggers.length > 0 ? triggers.join(", ") : "no specific triggers noted";

  if (score === 1) {
    return `✅ Excellent session! Staying at level 1 near ${triggerStr} means your dog was firmly in the comfort zone — that's exactly where learning happens. Bank this win and replicate the conditions next time.`;
  }
  if (score === 2) {
    return `🐾 Good work logging this. Level 2 near ${triggerStr} — your dog noticed the trigger and felt some tension, but stayed under threshold. This is the tolerance zone: valuable exposure that builds resilience over time.`;
  }
  if (score === 3) {
    return `🐾 Level 3 is a useful data point. ${triggerStr} put your dog at the edge of their threshold. Consider whether you can increase distance next session, or reduce other stressors beforehand (trigger stacking is real — cortisol from yesterday counts today).`;
  }
  if (score === 4) {
    return `⚠️ Level 4 means your dog went over threshold near ${triggerStr}. No learning occurs in that zone, and each over-threshold episode makes the next one more likely. Give 48–72 hours of full decompression before the next trigger session. You handled it — now let the nervous system recover.`;
  }
  // score === 5
  return `⚠️ A level 5 episode is tough on everyone. Please give your dog 48–72 hours of complete decompression (quiet sniff walks, enrichment only — no trigger exposure). If this is a pattern, consider whether a cortisol vacation (1–3 weeks trigger-free) might reset the baseline. You're not failing — reactivity training is non-linear. Come back when you're both ready. ⚠️ At this risk level, I strongly recommend working alongside a CPDT-KA or IAABC certified trainer.`;
}

// --- Error mapping ---

/**
 * Map raw Supabase / PostgREST errors to safe, user-facing ToolResult errors.
 * Never leak raw Postgres error messages to the caller — log them for ops
 * and return a curated message.
 */
function buildDbError(
  err: { code?: string; message?: string; status?: number; details?: string | null } | null,
  dog_id: string,
  op: "logging this walk" | "fetching progress"
): ToolResult {
  // Always log the raw error for operators.
  console.error(`[log_walk] supabase error during ${op}:`, err);

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

  // Foreign key violation — dog_id doesn't exist.
  if (code === "23503") {
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

  // Network / upstream
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
          message:
            op === "logging this walk"
              ? "Something went wrong logging this walk."
              : "Something went wrong fetching progress.",
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
 * @param params  Validated tool params (Zod has already enforced bounds).
 * @param ctx     Auth context — must carry bearer_token for the data-plane call.
 * @param client  Optional injected Supabase client (used by tests). When omitted,
 *                a per-request client is built from ctx.bearer_token.
 */
export async function logWalk(
  params: LogWalkParams,
  ctx: AuthContext,
  client?: SupabaseClient
): Promise<ToolResult> {
  // Force-free guardrail — check notes and any trigger text BEFORE any DB call.
  const allText = [params.notes ?? "", ...params.triggers].join(" ");
  if (detectAversive(allText)) {
    return buildAversiveError();
  }

  // Defensive: index.ts's checkToolAccess should already block demo callers,
  // but if a non-demo ctx somehow reaches here with no bearer_token, fail safely.
  if (!ctx.bearer_token) {
    return buildAuthRequiredError();
  }

  const db = client ?? makeUserClient(ctx.bearer_token);

  // Client-generated UUID — avoids the RLS race on .select().single() after
  // insert, and lets us return the walk_id without a follow-up read.
  const walkId = crypto.randomUUID();
  const loggedAt = new Date().toISOString();

  // Insert walk_logs. RLS gate: is_owner_of_dog(dog_profile_id) — if the caller
  // doesn't own the dog, this INSERT fails and we map it to permission_denied.
  const { error: walkErr } = await db.from("walk_logs").insert({
    id: walkId,
    dog_profile_id: params.dog_id,
    notes: params.notes ?? null,
    // date / created_at use server defaults
  });

  if (walkErr) {
    return buildDbError(walkErr as unknown as {
      code?: string;
      message?: string;
      status?: number;
    }, params.dog_id, "logging this walk");
  }

  // Insert walk_triggers — one row per trigger, all sharing threshold_score
  // as severity (peak for the walk). Empty triggers list → no rows.
  if (params.triggers.length > 0) {
    const triggerRows = params.triggers.map((t) => ({
      id: crypto.randomUUID(),
      walk_log_id: walkId,
      trigger_type: t,
      severity: params.threshold_score,
    }));

    const { error: triggerErr } = await db.from("walk_triggers").insert(triggerRows);

    if (triggerErr) {
      // The walk_logs row is already committed. We could attempt cleanup, but
      // RLS denials on a child row after a successful parent INSERT shouldn't
      // happen (the policy is gated by ownership of the same parent row).
      // Log and surface the error — operators can investigate orphan rows.
      console.error("[log_walk] walk_triggers insert failed for walk_id", walkId);
      return buildDbError(triggerErr as unknown as {
        code?: string;
        message?: string;
        status?: number;
      }, params.dog_id, "logging this walk");
    }
  }

  const confirmation: WalkLogConfirmation = {
    walk_id: walkId,
    dog_id: params.dog_id,
    logged_at: loggedAt,
    triggers: params.triggers,
    threshold_score: params.threshold_score,
    notes: params.notes,
    coaching_note: buildCoachingNote(params.threshold_score, params.triggers),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(confirmation),
      },
    ],
    isError: false,
  };
}
