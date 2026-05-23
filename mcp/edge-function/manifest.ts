/**
 * manifest.ts — MCP tool definitions returned by tools/list.
 *
 * Each entry has name, description, inputSchema (required by MCP spec
 * 2025-03-26), and an optional outputSchema (added by MCP spec 2025-06-18
 * for structured results). All schemas are JSON Schema draft-07 compatible.
 *
 * Keep these in sync with the Zod schemas in tools/*.ts AND the TypeScript
 * return-type interfaces (BreedProfile, DogProfile, WalkLogConfirmation,
 * ProgressSummary, TrainingProtocol) so that 2025-06-18+ clients can render
 * structured results faithfully.
 *
 * The outputSchema field is purely additive: clients on the 2025-03-26
 * baseline ignore it; clients on 2025-06-18+ use it.
 *
 * Descriptions are written to be useful to an LLM selecting which tool to call.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Optional structured-output schema (MCP spec 2025-06-18+). Mirrors the
   * shape of the tool handler's success response (the `content[0].text`
   * JSON when isError=false). Clients on earlier protocol versions ignore
   * this field, so it's safe to include for all tools.
   */
  outputSchema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// --- Reusable schema fragments ---
// These keep the per-tool schemas readable and avoid duplicating the
// reactivity_type enum (which is shared across breed + dog profile tools).

const REACTIVITY_TYPE_ENUM = {
  type: "string",
  enum: ["fear-based", "frustration-based", "excitement-based", "mixed"],
} as const;

const COACHING_NOTE = {
  type: "string",
  description: "Narrative interpretation in Shadow's voice. Always includes 🐾.",
} as const;

const CTA = {
  type: "string",
  description: "URL to drive the user to Calming Paws.",
  format: "uri",
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "lookup_breed",
    description:
      "Look up a breed profile from Shadow's reactive-dog knowledge base. Returns the breed's typical reactivity type, common triggers, training nuances, recommended protocols, and equipment notes. No authentication required — this is a public tool. Currently covers Border Collie, Chihuahua, German Shepherd, and Labrador Retriever (more coming). Always includes a coaching note in Shadow's voice and a link to Calming Paws.",
    inputSchema: {
      type: "object",
      properties: {
        breed: {
          type: "string",
          description:
            "The dog breed to look up. Common shorthands are accepted (e.g. 'GSD', 'Lab', 'BC'). Case-insensitive.",
          minLength: 1,
          maxLength: 80,
        },
      },
      required: ["breed"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        breed: { type: "string" },
        group: { type: "string" },
        reactivity_type: REACTIVITY_TYPE_ENUM,
        common_triggers: { type: "array", items: { type: "string" } },
        training_nuances: { type: "array", items: { type: "string" } },
        threshold_note: { type: "string" },
        recommended_protocols: { type: "array", items: { type: "string" } },
        equipment_notes: { type: "string" },
        coaching_note: COACHING_NOTE,
        cta: CTA,
      },
      required: [
        "breed",
        "group",
        "reactivity_type",
        "common_triggers",
        "training_nuances",
        "threshold_note",
        "recommended_protocols",
        "equipment_notes",
        "coaching_note",
        "cta",
      ],
      additionalProperties: false,
    },
  },

  {
    name: "get_dog_profile",
    description:
      "Retrieve the stored profile for a specific dog, including breed, reactivity type, primary triggers, known threshold distance, current risk level, and active training protocols. Requires authentication — the caller must have a valid Calming Paws session token with at least the 'profile:read' scope.",
    inputSchema: {
      type: "object",
      properties: {
        dog_id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the dog to retrieve. Obtainable from the Calming Paws app.",
        },
      },
      required: ["dog_id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        dog_id: { type: "string", format: "uuid" },
        name: { type: "string" },
        breed: { type: "string" },
        age_years: { type: "number", minimum: 0 },
        weight_kg: { type: "number", minimum: 0 },
        reactivity_type: REACTIVITY_TYPE_ENUM,
        primary_triggers: { type: "array", items: { type: "string" } },
        known_threshold_distance_feet: { type: "number", minimum: 0 },
        current_risk_level: { type: "integer", minimum: 1, maximum: 5 },
        active_protocols: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        coaching_note: COACHING_NOTE,
      },
      required: [
        "dog_id",
        "name",
        "breed",
        "age_years",
        "weight_kg",
        "reactivity_type",
        "primary_triggers",
        "known_threshold_distance_feet",
        "current_risk_level",
        "active_protocols",
        "notes",
        "coaching_note",
      ],
      additionalProperties: false,
    },
  },

  {
    name: "log_walk",
    description:
      "Log a walk session for a dog, recording the triggers encountered, the reactivity threshold score (1–5), and any session notes. Returns a confirmation with a personalised coaching note interpreting the session. Requires authentication with 'walks:write' scope. Will refuse (with a helpful redirect) if notes mention aversive methods.",
    inputSchema: {
      type: "object",
      properties: {
        dog_id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the dog this walk log belongs to.",
        },
        triggers: {
          type: "array",
          items: { type: "string", maxLength: 200 },
          minItems: 0,
          maxItems: 20,
          description:
            "List of triggers observed during the walk (e.g. ['other dog', 'bicycle', 'jogger']).",
        },
        threshold_score: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description:
            "Reactivity level during the walk. 1 = completely calm, 2 = aware but not tense, 3 = tension/pulling but recoverable, 4 = frantic lunging/barking, 5 = completely over threshold.",
        },
        notes: {
          type: "string",
          maxLength: 2000,
          description:
            "Optional free-text notes about the session. Force-free methods only — tool will refuse aversive content.",
        },
      },
      required: ["dog_id", "triggers", "threshold_score"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        walk_id: { type: "string", format: "uuid" },
        dog_id: { type: "string", format: "uuid" },
        logged_at: {
          type: "string",
          format: "date-time",
          description: "ISO-8601 timestamp the walk was logged.",
        },
        triggers: { type: "array", items: { type: "string" } },
        threshold_score: { type: "integer", minimum: 1, maximum: 5 },
        notes: { type: "string" },
        coaching_note: COACHING_NOTE,
      },
      required: ["walk_id", "dog_id", "logged_at", "triggers", "threshold_score", "coaching_note"],
      additionalProperties: false,
    },
  },

  {
    name: "get_progress",
    description:
      "Retrieve trend data and progress analytics for a dog over a given time window (7, 30, or 90 days). Returns average threshold scores, trend direction, threshold distance change, most challenging triggers, and a week-by-week breakdown. Includes a coaching note interpreting the trend. Requires authentication with 'progress:read' scope.",
    inputSchema: {
      type: "object",
      properties: {
        dog_id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the dog to retrieve progress for.",
        },
        window: {
          type: "string",
          enum: ["7d", "30d", "90d"],
          description: "Time window for aggregation. Defaults to '30d' if not specified.",
        },
      },
      required: ["dog_id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        dog_id: { type: "string", format: "uuid" },
        window: { type: "string", enum: ["7d", "30d", "90d"] },
        total_sessions: { type: "integer", minimum: 0 },
        avg_threshold_score: { type: "number", minimum: 0, maximum: 5 },
        threshold_trend: {
          type: "string",
          enum: ["improving", "stable", "worsening"],
        },
        threshold_distance_change_pct: {
          type: "number",
          description:
            "Positive = threshold distance increased (dog can work closer). 0 = unknown/no data.",
        },
        most_challenging_triggers: { type: "array", items: { type: "string" } },
        best_trigger: { type: ["string", "null"] },
        weekly_breakdown: {
          type: "array",
          items: {
            type: "object",
            properties: {
              week_start: {
                type: "string",
                format: "date",
                description: "ISO date string (YYYY-MM-DD) for the Monday of the week.",
              },
              avg_threshold_score: { type: "number", minimum: 0, maximum: 5 },
              session_count: { type: "integer", minimum: 0 },
              top_triggers: { type: "array", items: { type: "string" } },
            },
            required: ["week_start", "avg_threshold_score", "session_count", "top_triggers"],
            additionalProperties: false,
          },
        },
        coaching_note: COACHING_NOTE,
      },
      required: [
        "dog_id",
        "window",
        "total_sessions",
        "avg_threshold_score",
        "threshold_trend",
        "threshold_distance_change_pct",
        "most_challenging_triggers",
        "best_trigger",
        "weekly_breakdown",
        "coaching_note",
      ],
      additionalProperties: false,
    },
  },

  {
    name: "recommend_protocol",
    description:
      "Generate a personalised force-free training protocol for a specific dog and situation. The tool identifies the reactivity type (fear-based, frustration-based, excitement-based, or mixed) from the situation description and returns a structured protocol with step-by-step session plans, equipment recommendations, green/red flags, and a coaching note in Shadow's voice. Requires authentication with the 'profile:read', 'progress:read', and 'protocols:read' scopes. Will refuse (with a helpful redirect) if the situation mentions aversive methods.",
    inputSchema: {
      type: "object",
      properties: {
        dog_id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the dog this protocol is for.",
        },
        situation: {
          type: "string",
          minLength: 10,
          maxLength: 1000,
          description:
            "Describe the specific situation or challenge. Include what the dog does (body language, direction of pull, reaction type), what the trigger is, and any context about current training or recent setbacks. The more detail, the more targeted the protocol.",
        },
      },
      required: ["dog_id", "situation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        dog_id: { type: "string", format: "uuid" },
        protocol_name: { type: "string" },
        reactivity_type_identified: { type: "string" },
        trigger_identified: { type: "string" },
        weekly_sessions: { type: "integer", minimum: 0 },
        session_duration_minutes: { type: "integer", minimum: 0 },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "integer", minimum: 1 },
              title: { type: "string" },
              description: { type: "string" },
              duration_minutes: { type: "integer", minimum: 0 },
            },
            required: ["step", "title", "description", "duration_minutes"],
            additionalProperties: false,
          },
        },
        equipment: { type: "array", items: { type: "string" } },
        treats_recommendation: { type: "string" },
        green_flags: { type: "array", items: { type: "string" } },
        red_flags: { type: "array", items: { type: "string" } },
        coaching_note: COACHING_NOTE,
        cta: CTA,
      },
      required: [
        "dog_id",
        "protocol_name",
        "reactivity_type_identified",
        "trigger_identified",
        "weekly_sessions",
        "session_duration_minutes",
        "steps",
        "equipment",
        "treats_recommendation",
        "green_flags",
        "red_flags",
        "coaching_note",
        "cta",
      ],
      additionalProperties: false,
    },
  },
];

/** Build the tools/list response body (the 'result' field of the JSON-RPC response). */
export function buildToolsList(): { tools: ToolDefinition[] } {
  return { tools: TOOL_DEFINITIONS };
}
