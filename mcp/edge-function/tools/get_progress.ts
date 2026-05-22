/**
 * tools/get_progress.ts
 *
 * Auth-required tool. Returns mock trend data for a dog over a given window.
 * In production this would aggregate walk_logs from Supabase.
 *
 * The coaching_note interprets the trend in Shadow's voice so the calling
 * LLM can relay it without needing domain knowledge.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";

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

// --- Mock data generation ---
// We generate deterministic-ish data based on dog_id so the same dog
// always returns the same trend shape, which makes demos repeatable.

function hashDogId(dog_id: string): number {
  let h = 0;
  for (const c of dog_id) {
    h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  }
  return Math.abs(h);
}

function buildMockProgress(
  dog_id: string,
  window: "7d" | "30d" | "90d"
): ProgressSummary {
  const seed = hashDogId(dog_id);
  const isImproving = seed % 3 !== 0; // 2 out of 3 mock dogs are improving
  const isStable = seed % 3 === 0 && seed % 7 !== 0;

  const trend: ProgressSummary["threshold_trend"] = isImproving
    ? "improving"
    : isStable
    ? "stable"
    : "worsening";

  const totalSessions = window === "7d" ? 3 + (seed % 4) : window === "30d" ? 8 + (seed % 10) : 18 + (seed % 15);
  const avgScore = isImproving ? 1.8 + (seed % 10) * 0.1 : isStable ? 2.5 : 3.2;
  const distanceChangePct = isImproving ? 15 + (seed % 20) : isStable ? 0 : -(5 + (seed % 10));

  const allTriggers = [
    "other dogs",
    "bicycles",
    "joggers",
    "strangers",
    "loud noises",
    "skateboards",
    "children",
    "unfamiliar men",
  ];

  // Pick 2-3 challenging triggers and 1 "best" trigger deterministically
  const challengingTriggers = allTriggers.slice(seed % 4, (seed % 4) + 2);
  const bestTrigger = isImproving ? allTriggers[(seed % 4) + 3] ?? null : null;

  // Build weekly breakdown
  const weekCount = window === "7d" ? 1 : window === "30d" ? 4 : 12;
  const now = new Date();
  const weekly: WeeklyDataPoint[] = [];

  for (let i = weekCount - 1; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - i * 7);
    // Scores improve slightly week-over-week if trend is "improving"
    const weekScore = isImproving
      ? Math.max(1, avgScore + (i * 0.15) - 0.1)
      : avgScore + (Math.random() * 0.2 - 0.1);

    weekly.push({
      week_start: weekStart.toISOString().split("T")[0],
      avg_threshold_score: Math.round(weekScore * 10) / 10,
      session_count: Math.max(1, Math.round(totalSessions / weekCount) + (i % 2 === 0 ? 1 : 0)),
      top_triggers: challengingTriggers.slice(0, 2),
    });
  }

  const coaching_note = buildProgressCoachingNote(trend, avgScore, distanceChangePct, bestTrigger, challengingTriggers);

  return {
    dog_id,
    window,
    total_sessions: totalSessions,
    avg_threshold_score: Math.round(avgScore * 10) / 10,
    threshold_trend: trend,
    threshold_distance_change_pct: distanceChangePct,
    most_challenging_triggers: challengingTriggers,
    best_trigger: bestTrigger,
    weekly_breakdown: weekly,
    coaching_note,
  };
}

function buildProgressCoachingNote(
  trend: ProgressSummary["threshold_trend"],
  avgScore: number,
  distanceChangePct: number,
  bestTrigger: string | null,
  challengingTriggers: string[]
): string {
  const challengeStr = challengingTriggers.join(" and ");

  if (trend === "improving") {
    const distanceStr = distanceChangePct > 0 ? `a ${distanceChangePct}% closer working distance` : "a tightening threshold window";
    return `✅ The data tells a clear story — your dog is improving! Average reactivity score is trending down and you've gained ${distanceStr}. ${bestTrigger ? `"${bestTrigger}" is your breakthrough trigger right now — lean into sessions that involve it.` : ""} ${challengeStr ? `Keep chipping away at ${challengeStr} — they're the frontier.` : ""} Progress in reactivity training is measured in weeks and months, not days. You're building the right foundation. 🐾`;
  }

  if (trend === "stable") {
    return `🐾 Scores are holding steady — you're maintaining gains, which is real work in itself. If you've hit a plateau with ${challengeStr}, this is often when a cortisol vacation (1–3 weeks with zero trigger exposure) can break the stall. The nervous system sometimes needs a full reset before it can climb again. Check that you're not doing sessions on high-stressor days — cortisol stacks invisibly.`;
  }

  // worsening
  return `⚠️ Scores have crept up recently — ${challengeStr} seem to be the drivers. Worsening reactivity despite correct methods has three common causes: (1) trigger stacking across the week, (2) undiagnosed pain (please check in with your vet), or (3) the threshold distance needs to increase back to where success was reliable. Don't push through a regression — step back and rebuild. If this has persisted 4+ weeks, consider a full cortisol vacation before resuming. You've got this.`;
}

// --- Handler ---

export async function getProgress(
  params: GetProgressParams,
  ctx: AuthContext
): Promise<ToolResult> {
  // TODO (production): Run an aggregate query against Supabase:
  //   SELECT date_trunc('week', logged_at) as week_start,
  //          avg(threshold_score) as avg_score,
  //          count(*) as session_count,
  //          array_agg(DISTINCT trigger) as triggers
  //   FROM walk_logs
  //   WHERE dog_id = $1
  //     AND owner_id = $2
  //     AND logged_at > now() - $3::interval
  //   GROUP BY week_start
  //   ORDER BY week_start

  const progress = buildMockProgress(params.dog_id, params.window);

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
