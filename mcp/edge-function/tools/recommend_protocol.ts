/**
 * tools/recommend_protocol.ts
 *
 * Auth-required tool. Returns a personalised training protocol in Shadow's voice.
 *
 * Force-free guardrail: if the situation description contains aversive
 * keywords, the tool refuses and redirects — mirroring SKILL.md's hard
 * guardrail (same as log_walk.ts).
 *
 * Protocol selection logic:
 *   1. Read the situation string to classify reactivity type.
 *   2. Apply the Three-Type Reactivity Framework from SKILL.md.
 *   3. Return a structured protocol with session plan, gear, and coaching note.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";

// --- Zod schema ---

export const RecommendProtocolParamsSchema = z.object({
  dog_id: z.string().uuid("dog_id must be a valid UUID"),
  situation: z
    .string()
    .min(10, "Please describe the situation in at least 10 characters")
    .max(1000, "Situation description too long — keep it under 1000 characters"),
});

export type RecommendProtocolParams = z.infer<typeof RecommendProtocolParamsSchema>;

// --- Types ---

export interface ProtocolStep {
  step: number;
  title: string;
  description: string;
  duration_minutes: number;
}

export interface TrainingProtocol {
  dog_id: string;
  protocol_name: string;
  reactivity_type_identified: string;
  trigger_identified: string;
  weekly_sessions: number;
  session_duration_minutes: number;
  steps: ProtocolStep[];
  equipment: string[];
  treats_recommendation: string;
  green_flags: string[];
  red_flags: string[];
  coaching_note: string;
  cta: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

// --- Force-free guardrail (same patterns as log_walk.ts) ---

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
            "🐾 I noticed something in your situation description that suggests an aversive tool or punishment-based method. Shadow only works within a force-free, positive-reinforcement framework — this isn't a philosophical preference, it's because aversive methods increase anxiety in reactive dogs and can make reactivity significantly worse.\n\nLet me know what you're trying to achieve and I'll design a protocol that actually works for a reactive dog's nervous system. You can also find a certified force-free trainer through the IAABC directory: https://iaabc.org/consultants",
          resources: [
            "IAABC Member Directory: https://iaabc.org/consultants",
            "Pet Professional Guild: https://www.petprofessionalguild.com/",
          ],
          cta: "https://calming-paws.com/",
        }),
      },
    ],
    isError: true,
  };
}

// --- Reactivity type classification ---
// Simple keyword heuristic — good enough for a scaffold; a real version
// would use a more sophisticated classifier or incorporate dog profile data.

type ReactivityType = "fear-based" | "frustration-based" | "excitement-based" | "mixed";

interface ClassificationResult {
  type: ReactivityType;
  trigger: string;
  riskLevel: number;
}

function classifySituation(situation: string): ClassificationResult {
  const s = situation.toLowerCase();

  // Risk level detection
  let riskLevel = 2;
  if (/bite|bitten|bite\s*history|blood|severe|danger|unsafe/i.test(s)) riskLevel = 4;
  else if (/lun[gn]|frantic|out\s*of\s*control|can't\s*hold/i.test(s)) riskLevel = 3;
  else if (/whine|tension|stare|fixat/i.test(s)) riskLevel = 2;

  // Trigger extraction (very simple — looks for common trigger words)
  const triggerMap: Array<[RegExp, string]> = [
    [/dog|puppy|other\s*dog/i, "other dogs"],
    [/bik[e]|cycl|cyclist/i, "bicycles/cyclists"],
    [/jog|run|runner/i, "joggers/runners"],
    [/stranger|person|people|human/i, "strangers"],
    [/noise|sound|thunder|firework/i, "loud noises"],
    [/car|traffic|vehicle/i, "traffic/vehicles"],
    [/cat|squirrel|animal/i, "small animals"],
    [/child|kid/i, "children"],
    [/skateboard|scooter/i, "wheeled objects"],
  ];
  let trigger = "unspecified triggers";
  for (const [re, label] of triggerMap) {
    if (re.test(s)) { trigger = label; break; }
  }

  // Type classification based on body language cues
  const fearCues = /pull.*back|back.*away|tuck|hide|freeze|crouch|whale|bark.*back|shy|scared|terror/i;
  const frustrationCues = /pull.*forward|toward|lunge.*forward|want.*greet|see.*dog|frustrated|barrier|fence|leash|jump.*up|can't\s*get/i;
  const excitementCues = /frantic|spin|can't\s*settle|won't\s*calm|over.?aroused|hyper|zoomie|unfocused|everything/i;

  const fearMatch = fearCues.test(s);
  const frustrationMatch = frustrationCues.test(s);
  const excitementMatch = excitementCues.test(s);

  let type: ReactivityType;
  const matchCount = [fearMatch, frustrationMatch, excitementMatch].filter(Boolean).length;

  if (matchCount >= 2) {
    type = "mixed";
  } else if (fearMatch) {
    type = "fear-based";
  } else if (frustrationMatch) {
    type = "frustration-based";
  } else if (excitementMatch) {
    type = "excitement-based";
  } else {
    // Default to fear-based — the most common type and safest default
    type = "fear-based";
  }

  return { type, trigger, riskLevel };
}

// --- Protocol builders (one per reactivity type) ---

function buildFearProtocol(dog_id: string, trigger: string, riskLevel: number): TrainingProtocol {
  const riskNote = riskLevel >= 4
    ? " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer in addition to these techniques."
    : "";

  return {
    dog_id,
    protocol_name: "DS/CC — Distance-First Fear Desensitisation",
    reactivity_type_identified: "fear-based",
    trigger_identified: trigger,
    weekly_sessions: 5,
    session_duration_minutes: 10,
    steps: [
      {
        step: 1,
        title: "Find the comfort zone distance",
        description:
          `Set up at a distance where your dog notices ${trigger} but stays calm, takes treats, and can respond to a simple cue like 'sit.' This is your starting distance. It may be further than you expect — that's fine.`,
        duration_minutes: 3,
      },
      {
        step: 2,
        title: "Look At That (LAT) — trigger predicts treats",
        description:
          `When your dog looks at ${trigger}, mark with 'Yes!' and immediately deliver a high-value treat. Repeat 5–10 times. Goal: your dog starts to look at ${trigger} and then look back at you for their treat. That 'trigger → look back' response is your first green flag.`,
        duration_minutes: 5,
      },
      {
        step: 3,
        title: "Rest and decompression",
        description:
          "Move away from the trigger area. Let your dog sniff and decompress. Short sessions beat long ones — 5–10 minutes of active work is enough. End every session here.",
        duration_minutes: 5,
      },
      {
        step: 4,
        title: "Progress criteria (over multiple sessions, not one)",
        description:
          `Only decrease distance when your dog is consistently calm (score ≤ 2) at the current distance across 3+ sessions. Never decrease distance within a single session. Progress is measured in weeks.`,
        duration_minutes: 0,
      },
    ],
    equipment: [
      "Front-clip harness (Freedom, Balance, or Ruffwear)",
      "6 ft leash for initial sessions",
      "Long line (15–30 ft biothane) for BAT 2.0 progression",
      "Treat pouch on hip for instant delivery",
    ],
    treats_recommendation:
      "High-value real meat (boiled chicken, freeze-dried liver, small cheese cubes). Near triggers, kibble will not compete. Keep pieces tiny (pea-sized) — you need 50+ treats per session.",
    green_flags: [
      "Dog looks at trigger then voluntarily looks back at you",
      "Dog takes treats near trigger without hesitation",
      "Dog's body language stays loose and relaxed",
      "Dog offers a calming signal (yawn, sniff) near trigger",
    ],
    red_flags: [
      "Dog refuses treats near trigger (they're over threshold — increase distance)",
      "Dog body stiffens or fixates for more than 3 seconds",
      "Dog lunges or barks (end session, increase distance next time)",
      "Any reaction at all — it means the distance is too short",
    ],
    coaching_note: `🐾 Fear-based reactivity means your dog is trying to create distance from something that scares them — and that's completely understandable. Your job is to change what ${trigger} *means* emotionally: from 'danger' to 'oh, that means something great is about to happen.' DS/CC does exactly that, but it requires patience and distance. Sub-threshold is everything — if your dog is reacting, you're too close. Distance is not giving up; distance is training.${riskNote}`,
    cta: "https://calming-paws.com/",
  };
}

function buildFrustrationProtocol(dog_id: string, trigger: string, riskLevel: number): TrainingProtocol {
  const riskNote = riskLevel >= 4
    ? " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer in addition to these techniques."
    : "";

  return {
    dog_id,
    protocol_name: "Impulse Control — Calm Earns Access",
    reactivity_type_identified: "frustration-based",
    trigger_identified: trigger,
    weekly_sessions: 5,
    session_duration_minutes: 10,
    steps: [
      {
        step: 1,
        title: "Build the Engage-Disengage foundation (Level 1)",
        description:
          `At a comfortable distance from ${trigger}: when your dog looks at the trigger, mark with 'Yes!' and treat. Repeat 10 times. You're conditioning trigger = treats, not calm behaviour yet — just building the treat-association.`,
        duration_minutes: 5,
      },
      {
        step: 2,
        title: "Engage-Disengage Level 2 — reward disengagement",
        description:
          `Now wait: when your dog looks at ${trigger} and then looks AWAY on their own, mark and reward generously (jackpot — 3–5 treats). If they fixate for more than 5 seconds, toss a treat on the ground to break the stare, then increase distance. The goal is a dog who notices the trigger and chooses not to pursue it.`,
        duration_minutes: 5,
      },
      {
        step: 3,
        title: "Introduce the Premack Principle",
        description:
          `Once disengagement is reliable, add the rule: 'Calm sitting gets you access.' If the dog sits calmly for 3 seconds near ${trigger}, allow a brief (5 second) approach on a loose leash, then walk away. Calm = approach. Pulling / barking = no approach. This teaches impulse control at the motivational level.`,
        duration_minutes: 0,
      },
    ],
    equipment: [
      "Front-clip harness — essential for directional control without pain",
      "6 ft leash",
      "Treat pouch",
      "A training partner who can handle the 'trigger dog' for dog-dog reactivity work",
    ],
    treats_recommendation:
      "Medium-high value treats work here — frustration dogs are motivated and will take food more readily than fear dogs. Reward calm turns-away generously.",
    green_flags: [
      "Dog notices trigger and voluntarily looks away",
      "Dog sits without cue near trigger",
      "Dog checks in with you when trigger appears",
      "Leash stays loose near trigger",
    ],
    red_flags: [
      "Dog fixates for more than 5 seconds — increase distance",
      "Barking begins before you can redirect",
      "Dog pulls toward trigger on a tight leash — management, not training, needed first",
    ],
    coaching_note: `🐾 Frustration-based reactivity is driven by wanting something badly and not being able to get it — ${trigger} isn't scary, it's *frustratingly appealing*. The good news: these dogs are highly motivated, which means they learn fast once they understand the game. The game is 'calm behaviour is the key that unlocks what you want.' Engage-Disengage Level 2 is your core tool here — the moment your dog voluntarily looks away from ${trigger}, you're seeing the behaviour you want. Mark it like it's the best thing they've ever done. Because it is.${riskNote}`,
    cta: "https://calming-paws.com/",
  };
}

function buildExcitementProtocol(dog_id: string, trigger: string, riskLevel: number): TrainingProtocol {
  const riskNote = riskLevel >= 4
    ? " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer in addition to these techniques."
    : "";

  return {
    dog_id,
    protocol_name: "Arousal Management — Off-Switch Training",
    reactivity_type_identified: "excitement-based",
    trigger_identified: trigger,
    weekly_sessions: 6,
    session_duration_minutes: 15,
    steps: [
      {
        step: 1,
        title: "Baseline: daily decompression protocol",
        description:
          "Before any trigger work, establish a daily decompression practice: 20–30 min sniff-led long-line walk in a quiet area (no commands, just sniffing). This genuinely lowers baseline arousal over 1–2 weeks. Skip trigger work entirely until this is running daily.",
        duration_minutes: 30,
      },
      {
        step: 2,
        title: "Teach the 'off switch' — mat game",
        description:
          `Build a mat/platform behaviour: dog approaches mat → mark and reward. Add duration. Add arousal: play with the dog, then cue 'mat' and reward calm settling. The goal is a dog who can go from high arousal to calm on a verbal cue. Practice 100+ times in low-distraction settings first.`,
        duration_minutes: 10,
      },
      {
        step: 3,
        title: "Pattern games to lower environmental scanning",
        description:
          "Introduce the 1-2-3 Pattern (say '1', '2', '3' then treat — dog anticipates the treat by '2' and begins auto-focusing on you). This pattern works because it's predictable: a highly aroused brain craves a simple, known routine. Use it approaching trigger areas.",
        duration_minutes: 10,
      },
      {
        step: 4,
        title: "Trigger work — begin only at very large distances",
        description:
          `Start trigger work at a distance where your dog is still loose and unfocused — NOT locked on. Use the mat and pattern games near ${trigger} at distance. Only approach closer when the off-switch cue works reliably.`,
        duration_minutes: 0,
      },
    ],
    equipment: [
      "Long line (15–30 ft) — essential for decompression walks and BAT",
      "Portable mat or platform (carried to training locations)",
      "Front-clip harness",
      "Treat pouch",
    ],
    treats_recommendation:
      "High-value but small — use tiny pieces of real meat or freeze-dried liver. Over-aroused dogs may not take treats at all until you've lowered the baseline arousal first. If they won't take treats, you're too close or the baseline is too high.",
    green_flags: [
      "Dog sniffs on the decompression walk (sniffing = calming)",
      "Dog settles on mat within 10 seconds",
      "Dog can engage in the 1-2-3 pattern near a low-level trigger",
      "Dog checks in with you in novel environments",
    ],
    red_flags: [
      "Dog cannot take treats in any training context — baseline too high",
      "Dog unable to settle at home — daily decompression needs more time",
      "Multi-trigger reactivity getting worse — consider cortisol vacation",
    ],
    coaching_note: `🐾 Over-arousal reactivity is different from fear or frustration — this dog isn't scared or thwarted, their whole arousal system is running too hot. The single most impactful thing you can do is lower the baseline *before* doing any trigger work. That means daily long-line sniff walks (not power walks — nose work), puzzle feeders, and an off-switch mat routine. Think of it as building a bigger emotional buffer: when the buffer is full, ${trigger} barely makes a dent. When it's empty, everything sets them off. Build the buffer first.${riskNote}`,
    cta: "https://calming-paws.com/",
  };
}

function buildMixedProtocol(dog_id: string, trigger: string, riskLevel: number): TrainingProtocol {
  const base = buildFearProtocol(dog_id, trigger, riskLevel);
  const riskNote = riskLevel >= 4
    ? " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer in addition to these techniques."
    : "";

  return {
    ...base,
    protocol_name: "Mixed-Type Protocol — DS/CC + Impulse Control",
    reactivity_type_identified: "mixed",
    coaching_note: `🐾 Mixed-type reactivity is common — I'm seeing elements of both fear and frustration toward ${trigger}. The SKILL.md framework says to assess each trigger class independently and apply the matching protocol per trigger. For right now, I'm leading with the DS/CC approach (fear component) combined with Engage-Disengage Level 2 (frustration component). Watch which body language is dominant: if your dog pulls BACK, lean into the distance-first fear work. If they pull FORWARD, lean into the impulse control and Engage-Disengage. You may run parallel protocols for different triggers.${riskNote}`,
    steps: [
      ...base.steps.slice(0, 2),
      {
        step: 3,
        title: "Add Engage-Disengage Level 2 for frustration component",
        description:
          "When you see forward-pull body language, switch from DS/CC to Engage-Disengage: wait for your dog to voluntarily look away from the trigger, then jackpot-reward. Calm turning away is the behaviour you're building.",
        duration_minutes: 5,
      },
      base.steps[2],
    ],
  };
}

// --- Handler ---

export async function recommendProtocol(
  params: RecommendProtocolParams,
  ctx: AuthContext
): Promise<ToolResult> {
  // Force-free guardrail
  if (detectAversive(params.situation)) {
    return buildAversiveError();
  }

  // TODO (production): Fetch actual dog profile from Supabase to personalise
  // the protocol with breed-specific nuances and current threshold distance.
  // For now we classify from the situation text alone.

  const { type, trigger, riskLevel } = classifySituation(params.situation);

  let protocol: TrainingProtocol;
  switch (type) {
    case "fear-based":
      protocol = buildFearProtocol(params.dog_id, trigger, riskLevel);
      break;
    case "frustration-based":
      protocol = buildFrustrationProtocol(params.dog_id, trigger, riskLevel);
      break;
    case "excitement-based":
      protocol = buildExcitementProtocol(params.dog_id, trigger, riskLevel);
      break;
    default:
      protocol = buildMixedProtocol(params.dog_id, trigger, riskLevel);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(protocol),
      },
    ],
    isError: false,
  };
}
