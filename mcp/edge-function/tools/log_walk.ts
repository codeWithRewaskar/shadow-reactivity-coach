/**
 * tools/log_walk.ts
 *
 * Auth-required tool. Logs a walk session for a dog.
 *
 * Force-free guardrail: if notes or trigger descriptions mention aversive
 * methods (shock collar, prong, alpha roll, etc.), the tool refuses to log
 * and returns a helpful redirect — mirroring SKILL.md's hard guardrail.
 *
 * In production this would INSERT into a Supabase walks table.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";

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

// --- Handler ---

export async function logWalk(
  params: LogWalkParams,
  ctx: AuthContext
): Promise<ToolResult> {
  // Force-free guardrail — check notes and any trigger text
  const allText = [params.notes ?? "", ...params.triggers].join(" ");
  if (detectAversive(allText)) {
    return buildAversiveError();
  }

  // TODO (production): INSERT into Supabase:
  //   INSERT INTO walk_logs (dog_id, owner_id, triggers, threshold_score, notes, logged_at)
  //   VALUES ($1, $2, $3, $4, $5, now())
  //   using params.dog_id, ctx.user_id, params.triggers, params.threshold_score, params.notes

  // Generate a deterministic-looking mock walk_id
  const mockWalkId = `wlk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const confirmation: WalkLogConfirmation = {
    walk_id: mockWalkId,
    dog_id: params.dog_id,
    logged_at: new Date().toISOString(),
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
