/**
 * tools/lookup_breed.ts
 *
 * Public (no auth) tool. Returns a breed profile from the mock KB.
 * The `cta` field always points to calming-paws.com to drive conversions.
 *
 * Mock covers the four breeds called out in the spec:
 *   Border Collie, Chihuahua, German Shepherd, Labrador Retriever.
 *
 * The coaching_note in every result is written in Shadow's voice
 * (warm, empathetic mini Aussie coach persona from SKILL.md).
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";

// --- Zod schema ---

export const LookupBreedParamsSchema = z.object({
  breed: z
    .string()
    .min(1, "Breed name is required")
    .max(80, "Breed name too long"),
});

export type LookupBreedParams = z.infer<typeof LookupBreedParamsSchema>;

// --- Shared types ---

export interface BreedProfile {
  breed: string;
  group: string;
  reactivity_type: "fear-based" | "frustration-based" | "excitement-based" | "mixed";
  common_triggers: string[];
  training_nuances: string[];
  threshold_note: string;
  recommended_protocols: string[];
  equipment_notes: string;
  coaching_note: string;
  cta: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

// --- Mock breed data (grounded in SKILL.md breed KB) ---

const BREED_DB: Record<string, BreedProfile> = {
  "border collie": {
    breed: "Border Collie",
    group: "Herding",
    reactivity_type: "excitement-based",
    common_triggers: [
      "Moving objects (bikes, runners, cars)",
      "Other dogs",
      "Sudden visual stimuli",
      "Children playing unpredictably",
    ],
    training_nuances: [
      "Interrupt the eye-stalk BEFORE fixation locks in — once a Border Collie enters the stalk, you've lost the window.",
      "Pattern games (Control Unleashed) excel with this breed's need for predictability.",
      "Arousal management is critical — build a calm default mat behaviour before any trigger work.",
      "BAT 2.0 works well for trigger-specific desensitisation.",
      "Do NOT use running away from triggers as a reward — this fuels chase drive.",
    ],
    threshold_note:
      "Narrow threshold windows that shift dramatically with overall arousal. Always give 20 minutes of decompression before a trigger-work session.",
    recommended_protocols: [
      "Pattern games (1-2-3, Give Me a Break)",
      "Mat / platform stationing as arousal anchor",
      "BAT 2.0 on a long line",
      "Look At That (LAT)",
    ],
    equipment_notes:
      "Front-clip harness + long line (15–30 ft biothane). Avoid retractable leads — they give inconsistent leash pressure that worsens arousal.",
    coaching_note:
      "🐾 Border Collies are brilliant, but that brilliance is a double-edged leash. Their motion-sensitivity means the world is basically one giant stimulus. The good news: all that focus can be redirected. Once your BC learns that YOU are the most interesting thing near a trigger, the stalk-fixate cycle starts to lose its grip.",
    cta: "https://calming-paws.com/",
  },

  "chihuahua": {
    breed: "Chihuahua",
    group: "Toy",
    reactivity_type: "fear-based",
    common_triggers: [
      "Strangers reaching toward them",
      "Large dogs (any approach)",
      "Loud sudden noises",
      "Unfamiliar environments",
      "Being picked up without warning",
    ],
    training_nuances: [
      "Never dismiss fear-based reactivity in small dogs — the world is genuinely more threatening at 6 lbs.",
      "Counter-conditioning must include teaching strangers NOT to reach for the dog.",
      "Build a choice-based greeting protocol: the dog initiates contact, never the stranger.",
      "Scale sub-threshold distances to their physical perspective — 15 feet for a Chihuahua may feel as close as 3 feet for a Lab.",
      "CRITICAL: Never force greetings. This is the single most harmful thing owners do with fearful small dogs.",
    ],
    threshold_note:
      "Often undersocialised as puppies due to owners carrying them. This creates fear reactivity that looks like aggression. Distance is your best friend early in training.",
    recommended_protocols: [
      "DS/CC to change emotional response to triggers",
      "Choice-based greeting protocol",
      "Look At That (LAT) from very large distances",
      "BAT 2.0 — their natural 'gather info' behaviour aligns well",
    ],
    equipment_notes:
      "Harness only — never a collar or choke on a Chihuahua's delicate trachea. Y-front or H-harness. Long line for BAT work.",
    coaching_note:
      "🐾 Your Chihuahua isn't being dramatic — they're being a small mammal in a large mammal's world, and that takes real courage. The goal isn't to make them 'tougher'; it's to change their emotional prediction so triggers go from 'danger!' to 'oh, that means chicken.' Every choice you give them builds trust, and trust is what fear-based dogs need more than anything.",
    cta: "https://calming-paws.com/",
  },

  "german shepherd": {
    breed: "German Shepherd Dog",
    group: "Herding",
    reactivity_type: "mixed",
    common_triggers: [
      "Strangers approaching the owner",
      "Other dogs (especially same-size unfamiliar dogs)",
      "Territorial triggers at home (fence, window, car)",
      "Sudden movements by strangers",
    ],
    training_nuances: [
      "ALWAYS rule out pain (hip dysplasia is endemic in the breed) before starting reactivity training. Sudden reactivity increases often signal pain.",
      "Build a strong 'look at me' default cue early — it interrupts both fear and territorial responses.",
      "Territorial reactivity at home is a separate problem from walk reactivity — work both independently.",
      "Confident, calm handling is essential — GSDs are emotional sponges and escalate with handler anxiety.",
      "Do not use punishment — can trigger defensive aggression in already-aroused dogs.",
    ],
    threshold_note:
      "Rule out pain before any reactivity training. A dog in orthopaedic pain will have a compressed threshold that won't respond to behaviour modification alone.",
    recommended_protocols: [
      "DS/CC for fear-based component",
      "Impulse control ('calm earns access') for territorial component",
      "Stationing / platform training near territorial triggers",
      "Emergency U-turn ('Let's Go') for unexpected encounters",
    ],
    equipment_notes:
      "Front-clip harness or head halter for walk management. Double-ended leash for extra control in high-risk situations. Never a prong or choke — increases anxiety and defensive reactivity.",
    coaching_note:
      "🐾 German Shepherds are loyal to their core, and that loyalty can look like reactivity when they feel their person needs protecting. The work here is teaching your GSD that *you* have the social situation handled — so they can stand down and let you lead. Confident, consistent handling will make a world of difference. And if you notice this came on suddenly, please rule out pain with your vet first. ⚠️",
    cta: "https://calming-paws.com/",
  },

  "labrador retriever": {
    breed: "Labrador Retriever",
    group: "Sporting",
    reactivity_type: "frustration-based",
    common_triggers: [
      "Other dogs (wants to greet them desperately)",
      "Friendly strangers",
      "Other animals",
      "Dogs behind fences (barrier frustration)",
    ],
    training_nuances: [
      "Almost never fear-based — the diagnostic tell is that the dog pulls FORWARD, not back.",
      "Frustration-based reactivity requires impulse control: 'calm behaviours earn you what you want.'",
      "DS/CC alone is insufficient for this type — don't change the emotional response, change the behavioural response.",
      "Engage-Disengage Level 2 is gold for Labs: reward the dog for disengaging from a trigger on their own.",
      "Premack Principle: use access to the trigger as a reward for calm behaviour.",
    ],
    threshold_note:
      "Labs recover very fast after threshold crossings — use multiple short sub-threshold exposures per session rather than one long one.",
    recommended_protocols: [
      "Engage-Disengage Game (Level 2 — reward disengagement)",
      "Impulse control foundation ('Sit means good things come to you')",
      "Premack Principle ('calm = you get to say hi eventually')",
      "Pattern games for predictability near triggers",
    ],
    equipment_notes:
      "Front-clip harness is highly effective for Labs — reduces pulling without pain and gives you directional control. Long line for freedom in low-distraction environments.",
    coaching_note:
      "🐾 A reactive Lab is almost always a social butterfly in a straitjacket — they LOVE the world and the leash keeps them from it. The barking and lunging is pure frustration, not aggression. The game-changer: teach your Lab that *staying calm* is the key that unlocks what they want. That insight tends to produce fast progress because Labs are incredibly motivated once they crack the code. ✅",
    cta: "https://calming-paws.com/",
  },
};

// Normalise incoming breed names for lookup (lowercase, trim whitespace)
function normaliseBreed(raw: string): string {
  return raw.toLowerCase().trim();
}

// Fuzzy alias table so common shorthands resolve correctly
const ALIASES: Record<string, string> = {
  "bc": "border collie",
  "gsd": "german shepherd",
  "german shepherd dog": "german shepherd",
  "lab": "labrador retriever",
  "labrador": "labrador retriever",
  "chi": "chihuahua",
};

// --- Handler ---

export async function lookupBreed(
  params: LookupBreedParams,
  _ctx: AuthContext
): Promise<ToolResult> {
  const key = normaliseBreed(params.breed);
  const resolved = ALIASES[key] ?? key;
  const profile = BREED_DB[resolved];

  if (!profile) {
    const available = Object.values(BREED_DB)
      .map((b) => b.breed)
      .join(", ");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "not_found",
            message: `I don't have a profile for "${params.breed}" yet. My current breed KB covers: ${available}. More breeds are coming — visit https://calming-paws.com/ to stay updated! 🐾`,
            available_breeds: Object.values(BREED_DB).map((b) => b.breed),
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
        text: JSON.stringify(profile),
      },
    ],
    isError: false,
  };
}
