/**
 * manifest.ts — MCP tool definitions returned by tools/list.
 *
 * Each entry has name, description, and inputSchema (JSON Schema draft-07
 * compatible, as required by MCP spec 2025-03-26).
 *
 * Keep these in sync with the Zod schemas in tools/*.ts.
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
}

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
  },

  {
    name: "get_dog_profile",
    description:
      "Retrieve the stored profile for a specific dog, including breed, reactivity type, primary triggers, known threshold distance, current risk level, and active training protocols. Requires authentication — the caller must have a valid Calming Paws session token with at least the 'shadow:read' scope.",
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
  },

  {
    name: "log_walk",
    description:
      "Log a walk session for a dog, recording the triggers encountered, the reactivity threshold score (1–5), and any session notes. Returns a confirmation with a personalised coaching note interpreting the session. Requires authentication with 'shadow:write' scope. Will refuse (with a helpful redirect) if notes mention aversive methods.",
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
  },

  {
    name: "get_progress",
    description:
      "Retrieve trend data and progress analytics for a dog over a given time window (7, 30, or 90 days). Returns average threshold scores, trend direction, threshold distance change, most challenging triggers, and a week-by-week breakdown. Includes a coaching note interpreting the trend. Requires authentication with 'shadow:read' scope.",
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
  },

  {
    name: "recommend_protocol",
    description:
      "Generate a personalised force-free training protocol for a specific dog and situation. The tool identifies the reactivity type (fear-based, frustration-based, excitement-based, or mixed) from the situation description and returns a structured protocol with step-by-step session plans, equipment recommendations, green/red flags, and a coaching note in Shadow's voice. Requires authentication with 'shadow:read' scope. Will refuse (with a helpful redirect) if the situation mentions aversive methods.",
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
  },
];

/** Build the tools/list response body (the 'result' field of the JSON-RPC response). */
export function buildToolsList(): { tools: ToolDefinition[] } {
  return { tools: TOOL_DEFINITIONS };
}
