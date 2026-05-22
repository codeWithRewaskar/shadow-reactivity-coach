/**
 * tools/get_dog_profile.ts
 *
 * Auth-required tool. Returns a mock dog profile for a given dog_id.
 * In production this would query Supabase and enforce row-level security
 * so users can only retrieve their own dogs.
 *
 * Mock data is intentionally realistic — it looks like what a Calming Paws
 * user would actually enter so the coaching_note can be meaningfully grounded.
 */

import { z } from "zod";
import type { AuthContext } from "../auth.ts";

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

// --- Mock dog profiles ---
// Keyed by dog_id UUID. A real implementation would query the DB.

const MOCK_PROFILES: Record<string, DogProfile> = {
  "a1b2c3d4-e5f6-7890-abcd-ef1234567890": {
    dog_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    name: "Pepper",
    breed: "Border Collie",
    age_years: 3,
    weight_kg: 18,
    reactivity_type: "excitement-based",
    primary_triggers: ["bicycles", "joggers", "squirrels", "other dogs at distance"],
    known_threshold_distance_feet: 40,
    current_risk_level: 3,
    active_protocols: ["Pattern games (1-2-3)", "Mat stationing", "LAT"],
    notes:
      "Strong eye-stalk on bikes. Recovering well from a bad incident last month — currently back at 40 ft threshold. Owner works from home, good consistency.",
    coaching_note:
      "🐾 Pepper is making solid progress! At risk level 3 you're still in a teachable zone — that 40 ft threshold is a working distance, not a ceiling. Keep those pattern games going; consistency is what turns good days into good weeks for a herding brain like Pepper's.",
  },
  "b2c3d4e5-f6a7-8901-bcde-f12345678901": {
    dog_id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    name: "Nacho",
    breed: "Chihuahua",
    age_years: 5,
    weight_kg: 2.5,
    reactivity_type: "fear-based",
    primary_triggers: ["strangers bending over them", "large dogs", "loud voices", "unfamiliar men"],
    known_threshold_distance_feet: 25,
    current_risk_level: 2,
    active_protocols: ["DS/CC", "Choice-based greeting protocol", "LAT"],
    notes:
      "Undersocialised as a puppy — was carried everywhere. Big improvement since starting choice-based greetings. Still reactive to large men in hats.",
    coaching_note:
      "🐾 Nacho is doing brilliantly — risk level 2 with DS/CC in progress means you're right in the sweet spot. The choice-based greeting work is the most important piece: every time Nacho gets to choose whether to approach, you're rebuilding the trust that fear-based dogs need so badly. Small dog, big feelings, enormous progress. ✅",
  },
};

// A fallback mock for unknown IDs so the scaffold is always useful in demos
function buildGenericProfile(dog_id: string): DogProfile {
  return {
    dog_id,
    name: "Demo Dog",
    breed: "Mixed Breed / Rescue",
    age_years: 2,
    weight_kg: 12,
    reactivity_type: "mixed",
    primary_triggers: ["other dogs", "strangers", "loud noises"],
    known_threshold_distance_feet: 50,
    current_risk_level: 2,
    active_protocols: ["DS/CC", "Emergency U-turn"],
    notes: "Mock profile — this dog_id is not in the database.",
    coaching_note:
      "🐾 I'm showing you a demo profile since this dog_id isn't in the system yet. Once you've added your dog's details in Calming Paws, I'll be able to give you fully personalised guidance. Visit https://calming-paws.com/ to get started!",
  };
}

// --- Handler ---

export async function getDogProfile(
  params: GetDogProfileParams,
  ctx: AuthContext
): Promise<ToolResult> {
  // TODO (production): Query Supabase with RLS enforced so ctx.user_id can
  // only retrieve dogs that belong to them:
  //   SELECT * FROM dogs WHERE id = $1 AND owner_id = $2
  //   using params.dog_id and ctx.user_id

  const profile = MOCK_PROFILES[params.dog_id] ?? buildGenericProfile(params.dog_id);

  // Append risk escalation note if level >= 4
  if (profile.current_risk_level >= 4) {
    profile.coaching_note +=
      " ⚠️ At this risk level, I strongly recommend working with a CPDT-KA or IAABC certified trainer alongside these techniques.";
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
