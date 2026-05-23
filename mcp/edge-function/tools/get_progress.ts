/**
 * tools/get_progress.ts
 *
 * Auth-required tool. Aggregates a dog's walks + triggers over a window and
 * returns a ProgressSummary with a coaching narrative in Shadow's voice.
 *
 * Data plane:
 *   SELECT walk_logs (id, date) JOIN walk_triggers (trigger_type, severity)
 *   WHERE dog_profile_id = $1 AND date >= now() - window
 *   RLS handles authz — the caller's forwarded JWT means is_owner_of_dog
 *   (or the trainer SELECT policy) decides what's visible.
 *
 * The aggregation (avg severity, trend, weekly breakdown) is computed in
 * TypeScript over the joined rows — keeps the query simple and avoids
 * stored-function deployments for v1.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";
import { makeUserClient, type SupabaseClient } from "../db.ts";

// --- Zod schema ---

export const GetProgressParamsSchema = z.object({
  dog_id: z.string().uuid("dog_id must be a valid UUID"),
  window: z
    .enum(["7d", "30d", "90d"])
    .default("30d")
    .describe("Time window to aggregate progress over"),
});

export type GetProgressParams = z.infer<typeof GetProgressParamsSchema>;

// --- Types ---

export interface WeeklyDataPoint {
  week_start: string; // ISO date string
  avg_threshold_score: number;
  session_count: number;
  top_triggers: string[];
}

export interface ProgressSummary {
  dog_id: string;
  window: "7d" | "30d" | "90d";
  total_sessions: number;
  avg_threshold_score: number;
  threshold_trend: "improving" | "stable" | "worsening";
  /** Positive = threshold distance increased (dog can work closer). */
  threshold_distance_change_pct: number;
  most_challenging_triggers: string[];
  best_trigger: string | null;
  weekly_breakdown: WeeklyDataPoint[];
  coaching_note: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

// --- Helpers ---

const WINDOW_DAYS: Record<"7d" | "30d" | "90d", number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** Row shape returned by the joined SELECT. */
interface WalkRow {
  id: string;
  date: string; // YYYY-MM-DD
  walk_triggers: Array<{
    trigger_type: string;
    severity: number;
  }>;
}

/** ISO date string (YYYY-MM-DD) of the Monday on or before `d`. */
function weekStart(d: Date): string {
  const out = new Date(d);
  const day = out.getUTCDay(); // 0=Sun..6=Sat
  // Treat Monday as week start (ISO 8601). For Sun(0) we go back 6 days.
  const diff = day === 0 ? 6 : day - 1;
  out.setUTCDate(out.getUTCDate() - diff);
  return out.toISOString().split("T")[0];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Aggregate the raw walk rows into the ProgressSummary shape. */
function aggregate(
  rows: WalkRow[],
  dog_id: string,
  window: "7d" | "30d" | "90d"
): ProgressSummary {
  // --- Empty case ---
  if (rows.length === 0) {
    return {
      dog_id,
      window,
      total_sessions: 0,
      // Current contract is `number`, so use 0 with a sentinel meaning "no data".
      // TODO: consider widening to `number | null` in a future contract bump.
      avg_threshold_score: 0,
      threshold_trend: "stable",
      threshold_distance_change_pct: 0,
      most_challenging_triggers: [],
      best_trigger: null,
      weekly_breakdown: [],
      coaching_note:
        "🐾 No walks logged in this window — nothing to analyze yet. When you log your next session, I'll start building the picture.",
    };
  }

  // --- Totals + avg severity across all triggers in the window ---
  const allTriggers = rows.flatMap((r) => r.walk_triggers ?? []);
  const total_sessions = rows.length;
  const avg_threshold_score =
    allTriggers.length > 0
      ? round1(
          allTriggers.reduce((sum, t) => sum + (t.severity ?? 0), 0) /
            allTriggers.length
        )
      : 0;

  // --- Trend: latest half vs earlier half ---
  // Sort rows ascending by date, split in half, compare avg severity.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sorted.length / 2);
  const earlier = sorted.slice(0, mid).flatMap((r) => r.walk_triggers ?? []);
  const later = sorted.slice(mid).flatMap((r) => r.walk_triggers ?? []);

  let threshold_trend: ProgressSummary["threshold_trend"] = "stable";
  if (earlier.length > 0 && later.length > 0) {
    const earlierAvg =
      earlier.reduce((s, t) => s + (t.severity ?? 0), 0) / earlier.length;
    const laterAvg =
      later.reduce((s, t) => s + (t.severity ?? 0), 0) / later.length;
    const delta = laterAvg - earlierAvg;
    if (delta <= -0.5) threshold_trend = "improving";
    else if (delta >= 0.5) threshold_trend = "worsening";
  }

  // --- Per-trigger avg severity ---
  const byType = new Map<string, { sum: number; count: number }>();
  for (const t of allTriggers) {
    const cur = byType.get(t.trigger_type) ?? { sum: 0, count: 0 };
    cur.sum += t.severity ?? 0;
    cur.count += 1;
    byType.set(t.trigger_type, cur);
  }
  const triggerAvgs = Array.from(byType.entries()).map(([name, v]) => ({
    name,
    avg: v.sum / v.count,
  }));
  // Most challenging = top 3 by avg severity (desc).
  const most_challenging_triggers = [...triggerAvgs]
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3)
    .map((t) => t.name);
  // Best trigger = lowest avg severity (asc); null if no data.
  const bestSorted = [...triggerAvgs].sort((a, b) => a.avg - b.avg);
  const best_trigger = bestSorted.length > 0 ? bestSorted[0].name : null;

  // --- Weekly breakdown ---
  const byWeek = new Map<
    string,
    { triggers: Array<{ trigger_type: string; severity: number }>; sessionIds: Set<string> }
  >();
  for (const r of rows) {
    const wk = weekStart(new Date(r.date));
    const cur = byWeek.get(wk) ?? { triggers: [], sessionIds: new Set<string>() };
    cur.sessionIds.add(r.id);
    for (const t of r.walk_triggers ?? []) cur.triggers.push(t);
    byWeek.set(wk, cur);
  }
  const weekly_breakdown: WeeklyDataPoint[] = Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week_start_iso, v]) => {
      const sevs = v.triggers.map((t) => t.severity ?? 0);
      const wkAvg =
        sevs.length > 0 ? sevs.reduce((s, x) => s + x, 0) / sevs.length : 0;
      // Top triggers for this week: by count desc.
      const counts = new Map<string, number>();
      for (const t of v.triggers) {
        counts.set(t.trigger_type, (counts.get(t.trigger_type) ?? 0) + 1);
      }
      const top_triggers = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);

      return {
        week_start: week_start_iso,
        avg_threshold_score: round1(wkAvg),
        session_count: v.sessionIds.size,
        top_triggers,
      };
    });

  // --- threshold_distance_change_pct ---
  // No `distance_threshold` column exists on walk_triggers yet, so we can't
  // compute true distance change in v1. Return 0 and let the coaching note
  // do the heavy lifting on trend interpretation.
  // TODO: future work — JOIN dog_triggers.distance_threshold and diff.
  const threshold_distance_change_pct = 0;

  const coaching_note = buildProgressCoachingNote(
    threshold_trend,
    avg_threshold_score,
    threshold_distance_change_pct,
    best_trigger,
    most_challenging_triggers
  );

  return {
    dog_id,
    window,
    total_sessions,
    avg_threshold_score,
    threshold_trend,
    threshold_distance_change_pct,
    most_challenging_triggers,
    best_trigger,
    weekly_breakdown,
    coaching_note,
  };
}

function buildProgressCoachingNote(
  trend: ProgressSummary["threshold_trend"],
  _avgScore: number,
  distanceChangePct: number,
  bestTrigger: string | null,
  challengingTriggers: string[]
): string {
  const challengeStr = challengingTriggers.join(" and ");

  if (trend === "improving") {
    const distanceStr =
      distanceChangePct > 0
        ? `a ${distanceChangePct}% closer working distance`
        : "a tightening threshold window";
    return `✅ The data tells a clear story — your dog is improving! Average reactivity score is trending down and you've gained ${distanceStr}. ${bestTrigger ? `"${bestTrigger}" is your breakthrough trigger right now — lean into sessions that involve it.` : ""} ${challengeStr ? `Keep chipping away at ${challengeStr} — they're the frontier.` : ""} Progress in reactivity training is measured in weeks and months, not days. You're building the right foundation. 🐾`;
  }

  if (trend === "stable") {
    return `🐾 Scores are holding steady — you're maintaining gains, which is real work in itself. If you've hit a plateau with ${challengeStr || "current triggers"}, this is often when a cortisol vacation (1–3 weeks with zero trigger exposure) can break the stall. The nervous system sometimes needs a full reset before it can climb again. Check that you're not doing sessions on high-stressor days — cortisol stacks invisibly.`;
  }

  // worsening
  return `⚠️ Scores have crept up recently — ${challengeStr || "your active triggers"} seem to be the drivers. Worsening reactivity despite correct methods has three common causes: (1) trigger stacking across the week, (2) undiagnosed pain (please check in with your vet), or (3) the threshold distance needs to increase back to where success was reliable. Don't push through a regression — step back and rebuild. If this has persisted 4+ weeks, consider a full cortisol vacation before resuming. You've got this.`;
}

// --- Error mapping (mirrors log_walk's, kept local to avoid cross-file coupling) ---

function buildDbError(
  err: { code?: string; message?: string; status?: number } | null,
  dog_id: string
): ToolResult {
  console.error("[get_progress] supabase error:", err);

  const status = err?.status;
  const code = err?.code;

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
          message: "Something went wrong fetching progress.",
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
 * @param ctx     Auth context — must carry bearer_token.
 * @param client  Optional injected Supabase client (used by tests).
 */
export async function getProgress(
  params: GetProgressParams,
  ctx: AuthContext,
  client?: SupabaseClient
): Promise<ToolResult> {
  if (!ctx.bearer_token) {
    return buildAuthRequiredError();
  }

  const db = client ?? makeUserClient(ctx.bearer_token);

  const days = WINDOW_DAYS[params.window];
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString().split("T")[0]; // YYYY-MM-DD for the `date` column

  // SELECT walk_logs JOIN walk_triggers via PostgREST embedded resource.
  // RLS will filter to rows the caller can see.
  const { data, error } = await db
    .from("walk_logs")
    .select("id, date, walk_triggers(trigger_type, severity)")
    .eq("dog_profile_id", params.dog_id)
    .gte("date", sinceIso);

  if (error) {
    return buildDbError(error as unknown as {
      code?: string;
      message?: string;
      status?: number;
    }, params.dog_id);
  }

  const rows = (data ?? []) as WalkRow[];
  const progress = aggregate(rows, params.dog_id, params.window);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(progress),
      },
    ],
    isError: false,
  };
}
