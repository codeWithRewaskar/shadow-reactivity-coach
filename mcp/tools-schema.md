# Shadow MCP — Tool Schema Specification

**Server:** `https://mcp.calming-paws.com`
**Spec version:** v1 (initial public contract)
**Transport:** Streamable HTTP (MCP 2025-03-26)
**Auth:** OAuth 2.1 (default) / BYO JWT (fallback) — see [`oauth-flow.md`](./oauth-flow.md)

This is the canonical, implementation-ready schema for every tool exposed by the public Shadow MCP server. Once a tool is shipped under this name, it is a stable public contract — breaking changes require a `_v2` sibling tool and a deprecation window.

## Tool inventory

| Tool | Auth | Scope | Subscription | Idempotent | Purpose |
|------|------|-------|--------------|------------|---------|
| `lookup_breed` | demo | — | free | yes | Teaser — breed profile from the 20-breed KB |
| `get_dog_profile` | required | `dogs:read` | free | yes | Fetch stored dog profile |
| `log_walk` | required | `walks:write` | free | no | Append walk session to history |
| `get_progress` | required | `progress:read` | **pro** | yes | Trend analytics across a window |
| `recommend_protocol` | required | `coaching:read` | **pro** | yes | Personalised training protocol |

The `lookup_breed` tool is intentionally available to anonymous callers — it's the demo-mode conversion lever. Every other tool requires a valid bearer token.

## Common conventions

### Result envelope

Every tool returns the MCP-standard `{ content, isError }` shape. The `content[0].text` field carries a JSON-stringified result object. Successful results always include a `coaching_note` string written in Shadow's voice — the calling LLM is expected to pass this through verbatim or paraphrase only lightly. The note is the single field that makes the MCP response feel like Shadow rather than a database query.

### Error shape

Errors set `isError: true` and serialise a structured envelope:

```json
{
  "code": "<machine_readable_code>",
  "message": "<human-readable message in Shadow's voice>",
  "hint": "<optional remediation hint>",
  "cta": "<optional URL for sign-up / upgrade flows>"
}
```

Reserved error codes (consistent across every tool):

| Code | HTTP-equivalent | Meaning |
|------|-----------------|---------|
| `auth_required` | 401 | No bearer token, or token failed validation, and tool is not in demo mode |
| `subscription_required` | 402 | Token valid but caller's plan doesn't include this tool |
| `forbidden` | 403 | Token valid but `dog_id` does not belong to the caller |
| `not_found` | 404 | `dog_id` (or breed) does not exist |
| `invalid_params` | 422 | Input failed Zod validation — `hint` will name the offending field |
| `rate_limited` | 429 | Per-IP (demo) or per-user (auth'd) limit hit. Includes `retry_after_s` |
| `aversive_refused` | 422 | Input mentions aversive methods. See [Force-free guardrails](#force-free-guardrails) |
| `internal_error` | 500 | Server-side failure — opaque to client by design |

### Rate limits (initial)

| Mode | Limit | Window | Notes |
|------|-------|--------|-------|
| Demo (per IP) | 20 calls | 1 hour | Sliding window. CDN-fronted; bypasses backend on excess. |
| Auth'd free tier (per user) | 200 calls | 1 hour | Across all tools combined. |
| Auth'd pro tier (per user) | 2,000 calls | 1 hour | Across all tools combined. |
| Burst per IP (all modes) | 10 calls | 10 seconds | Token bucket. Prevents Claude Desktop misbehaviour from creating fans. |

429 responses include `retry_after_s` and the appropriate `RateLimit-*` response headers (RFC 9110 draft).

### Force-free guardrails

`log_walk` and `recommend_protocol` scan free-text input (`notes`, `situation`) for aversive-method markers: `shock collar`, `e-collar`, `prong`, `pinch collar`, `choke chain`, `alpha roll`, `dominate`, `correction (in punitive context)`, `nick`/`tap` (e-collar slang). If matched, the tool returns `aversive_refused` with a redirect to force-free alternatives and the `cta` field pointing at the relevant SKILL.md section hosted on calming-paws.com. This enforces Shadow's core principle at the API layer — a forked LLM prompt can be tampered with; the server cannot.

### Versioning

This document describes **v1**. Field additions to result objects are backwards-compatible and may ship without a version bump. Removed or renamed fields, changed enum values, or changed required parameters trigger a `_v2` tool name. The `_v1` tool remains live for ≥6 months after `_v2` ships, returning an `Sunset` header with the retirement date.

---

## Tool: `lookup_breed`

**Auth:** none (demo) · **Idempotent:** yes · **Cacheable:** yes (1 hour CDN TTL)

The conversion lever. Returns a breed profile from Shadow's reactive-dog KB. The four breeds shipped in v1 are Border Collie, Chihuahua, German Shepherd, and Labrador Retriever; the remaining 16 breeds from SKILL.md will roll out under the same schema without a version bump.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "breed": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "description": "Breed name. Common shorthands accepted (GSD, Lab, BC, Chi). Case-insensitive."
    }
  },
  "required": ["breed"],
  "additionalProperties": false
}
```

### Return schema (success)

```json
{
  "type": "object",
  "properties": {
    "breed":              { "type": "string" },
    "group":              { "type": "string", "description": "AKC/KC group e.g. Herding, Toy, Sporting" },
    "reactivity_type":    { "enum": ["fear-based", "frustration-based", "excitement-based", "mixed"] },
    "common_triggers":    { "type": "array", "items": { "type": "string" } },
    "training_nuances":   { "type": "array", "items": { "type": "string" } },
    "threshold_note":     { "type": "string" },
    "recommended_protocols": { "type": "array", "items": { "type": "string" } },
    "equipment_notes":    { "type": "string" },
    "coaching_note":      { "type": "string", "description": "In Shadow's voice. Pass through to user." },
    "cta":                { "type": "string", "format": "uri", "const": "https://calming-paws.com/" }
  },
  "required": ["breed", "reactivity_type", "common_triggers", "coaching_note", "cta"]
}
```

### Error cases

- `not_found` — breed not in KB. Returns `available_breeds[]` list and CTA to calming-paws.com.
- `rate_limited` — demo per-IP cap hit.

### Worked example

**Input:**
```json
{ "breed": "BC" }
```

**Returned content (truncated):**
```json
{
  "breed": "Border Collie",
  "group": "Herding",
  "reactivity_type": "excitement-based",
  "common_triggers": ["Moving objects (bikes, runners, cars)", "Other dogs", "..."],
  "training_nuances": ["Interrupt the eye-stalk BEFORE fixation locks in — once a Border Collie enters the stalk, you've lost the window.", "..."],
  "threshold_note": "Narrow threshold windows that shift dramatically with overall arousal...",
  "recommended_protocols": ["Pattern games (1-2-3, Give Me a Break)", "..."],
  "equipment_notes": "Front-clip harness + long line (15–30 ft biothane)...",
  "coaching_note": "🐾 Border Collies are brilliant, but that brilliance is a double-edged leash...",
  "cta": "https://calming-paws.com/"
}
```

---

## Tool: `get_dog_profile`

**Auth:** required · **Scope:** `dogs:read` · **Tier:** free · **Idempotent:** yes · **Cacheable:** no (live data)

Returns the caller's stored profile for a specific dog. Used by Shadow to ground every subsequent suggestion in real dog data rather than generic breed advice.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "dog_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the dog. Obtainable from the Calming Paws app's dog list."
    }
  },
  "required": ["dog_id"],
  "additionalProperties": false
}
```

### Return schema (success)

```json
{
  "type": "object",
  "properties": {
    "dog_id":            { "type": "string", "format": "uuid" },
    "name":              { "type": "string" },
    "breed":             { "type": "string" },
    "age_months":        { "type": "integer", "minimum": 0 },
    "sex":               { "enum": ["m", "f", "unknown"] },
    "spayed_neutered":   { "type": "boolean" },
    "reactivity_type":   { "enum": ["fear-based", "frustration-based", "excitement-based", "mixed"] },
    "primary_triggers":  { "type": "array", "items": { "type": "string" } },
    "current_threshold_distance_m": { "type": ["number", "null"], "description": "Last-known threshold distance in metres. Null if not yet measured." },
    "risk_level":        { "enum": ["low", "moderate", "high"], "description": "Used to gate protocol intensity recommendations." },
    "active_protocols":  { "type": "array", "items": { "type": "string" } },
    "medical_flags":     { "type": "array", "items": { "type": "string" }, "description": "e.g. ['suspected hip pain — vet referral pending']" },
    "trainer_attached":  { "type": "boolean", "description": "Whether a certified force-free trainer is co-managing this dog." },
    "coaching_note":     { "type": "string" }
  },
  "required": ["dog_id", "name", "breed", "reactivity_type", "primary_triggers", "risk_level", "coaching_note"]
}
```

### Error cases

- `auth_required`, `forbidden` (dog not owned by caller), `not_found`, `rate_limited`.

### Worked example

**Input:**
```json
{ "dog_id": "9a8e4f1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b" }
```

**Returned content (truncated):**
```json
{
  "dog_id": "9a8e4f1b-...",
  "name": "Loki",
  "breed": "German Shepherd",
  "age_months": 34,
  "reactivity_type": "mixed",
  "primary_triggers": ["Strangers approaching owner", "Off-leash dogs"],
  "current_threshold_distance_m": 8,
  "risk_level": "moderate",
  "active_protocols": ["DS/CC — strangers", "Engage-Disengage — off-leash dogs"],
  "medical_flags": [],
  "trainer_attached": false,
  "coaching_note": "🐾 Loki's threshold has been around 8 m for the past two weeks. That's a workable distance — close enough to practise, far enough that he can think. Today, let's stay just past it."
}
```

---

## Tool: `log_walk`

**Auth:** required · **Scope:** `walks:write` · **Tier:** free · **Idempotent:** no (writes a row)

Records a walk session. The single highest-value tool in the suite — it accumulates the longitudinal data that no markdown fork can replicate. Every successful log returns a coaching note that interprets the session so the user feels seen, not just logged.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "dog_id":  { "type": "string", "format": "uuid" },
    "triggers": {
      "type": "array",
      "items": { "type": "string", "maxLength": 200 },
      "minItems": 0,
      "maxItems": 20,
      "description": "Free-text trigger labels. Normalised server-side against the canonical trigger taxonomy."
    },
    "threshold_score": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5,
      "description": "1 = completely calm; 2 = aware not tense; 3 = pulling/tension recoverable; 4 = frantic lunging/barking; 5 = completely over threshold."
    },
    "duration_minutes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 240,
      "description": "Optional. Walk length in minutes."
    },
    "notes": {
      "type": "string",
      "maxLength": 2000,
      "description": "Optional. Free-text observations. Scanned for aversive-method language and refused if matched."
    },
    "occurred_at": {
      "type": "string",
      "format": "date-time",
      "description": "Optional ISO-8601 timestamp. Defaults to server-side `now()` if omitted."
    }
  },
  "required": ["dog_id", "triggers", "threshold_score"],
  "additionalProperties": false
}
```

### Return schema (success)

```json
{
  "type": "object",
  "properties": {
    "walk_id":              { "type": "string", "format": "uuid" },
    "logged_at":            { "type": "string", "format": "date-time" },
    "threshold_score":      { "type": "integer" },
    "session_streak_days":  { "type": "integer", "description": "Consecutive days with a log." },
    "rolling_7d_avg":       { "type": "number", "description": "Avg threshold score over last 7 days, including this entry." },
    "trend":                { "enum": ["improving", "steady", "regressing", "insufficient_data"] },
    "coaching_note":        { "type": "string" }
  },
  "required": ["walk_id", "logged_at", "threshold_score", "trend", "coaching_note"]
}
```

### Error cases

- `auth_required`, `forbidden`, `not_found`, `invalid_params`, `rate_limited`, **`aversive_refused`**.

### Worked example

**Input:**
```json
{
  "dog_id": "9a8e4f1b-...",
  "triggers": ["off-leash dog", "skateboard"],
  "threshold_score": 3,
  "duration_minutes": 35,
  "notes": "Loki noticed the off-leash dog from across the park, glanced back at me, took a treat. We did one U-turn and rerouted."
}
```

**Returned content:**
```json
{
  "walk_id": "b1c2d3e4-...",
  "logged_at": "2026-05-22T17:42:00Z",
  "threshold_score": 3,
  "session_streak_days": 11,
  "rolling_7d_avg": 2.9,
  "trend": "improving",
  "coaching_note": "🐾 That glance-back is huge — Loki chose to check in with you instead of fixating. Your 7-day average just dropped under 3 for the first time. Keep the rerouting pattern; it's working."
}
```

**Aversive refusal example:**
```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"code\":\"aversive_refused\",\"message\":\"I noticed the notes mention an e-collar. I can't log sessions involving aversive tools — they can suppress reactive behaviour temporarily while making the underlying emotion worse. Let's talk through a force-free alternative.\",\"hint\":\"Consider switching to a front-clip harness and an emergency U-turn cue. See the protocol library.\",\"cta\":\"https://calming-paws.com/force-free\"}" }]
}
```

---

## Tool: `get_progress`

**Auth:** required · **Scope:** `progress:read` · **Tier:** **pro** · **Idempotent:** yes · **Cacheable:** 60s server-side

Returns trend analytics over a window. The pro-tier gate is intentional — analytics is the moat. The free tier can `log_walk` all day; only paid users get longitudinal insight.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "dog_id": { "type": "string", "format": "uuid" },
    "window": {
      "type": "string",
      "enum": ["7d", "30d", "90d"],
      "default": "30d",
      "description": "Aggregation window."
    }
  },
  "required": ["dog_id"],
  "additionalProperties": false
}
```

### Return schema (success)

```json
{
  "type": "object",
  "properties": {
    "dog_id":                  { "type": "string" },
    "window":                  { "enum": ["7d", "30d", "90d"] },
    "walks_logged":            { "type": "integer" },
    "avg_threshold_score":     { "type": "number" },
    "trend":                   { "enum": ["improving", "steady", "regressing", "insufficient_data"] },
    "threshold_distance_change_m": {
      "type": ["number", "null"],
      "description": "Positive = dog tolerating closer triggers (improvement). Null if no distance data."
    },
    "top_triggers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "trigger":           { "type": "string" },
          "occurrences":       { "type": "integer" },
          "avg_threshold":     { "type": "number" }
        }
      }
    },
    "weekly_breakdown": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "week_starting":     { "type": "string", "format": "date" },
          "walks":             { "type": "integer" },
          "avg_threshold":     { "type": "number" }
        }
      }
    },
    "coaching_note":           { "type": "string" }
  },
  "required": ["dog_id", "window", "walks_logged", "trend", "coaching_note"]
}
```

### Error cases

- `auth_required`, `forbidden`, `not_found`, **`subscription_required`** (returned with `cta` to upgrade page), `rate_limited`.

### Worked example

**Input:**
```json
{ "dog_id": "9a8e4f1b-...", "window": "30d" }
```

**Returned content (truncated):**
```json
{
  "dog_id": "9a8e4f1b-...",
  "window": "30d",
  "walks_logged": 24,
  "avg_threshold_score": 2.7,
  "trend": "improving",
  "threshold_distance_change_m": -2.5,
  "top_triggers": [
    { "trigger": "off-leash dog", "occurrences": 11, "avg_threshold": 3.2 },
    { "trigger": "skateboard",     "occurrences":  4, "avg_threshold": 2.5 }
  ],
  "weekly_breakdown": [
    { "week_starting": "2026-04-27", "walks": 5, "avg_threshold": 3.4 },
    { "week_starting": "2026-05-04", "walks": 6, "avg_threshold": 3.0 },
    { "week_starting": "2026-05-11", "walks": 7, "avg_threshold": 2.6 },
    { "week_starting": "2026-05-18", "walks": 6, "avg_threshold": 2.2 }
  ],
  "coaching_note": "🐾 Loki's 30-day trend is the kind of slow, steady decline we love to see — threshold score down 1.2 points and his working distance has closed by 2.5 m. Off-leash dogs are still the toughest trigger; everything else is becoming background noise."
}
```

---

## Tool: `recommend_protocol`

**Auth:** required · **Scope:** `coaching:read` · **Tier:** **pro** · **Idempotent:** yes

The richest tool. Pulls the dog's profile + the breed KB and returns a personalised force-free training protocol with step-by-step session plans, equipment guidance, green/red flags, and a Shadow-voice coaching note. This is the tool that demonstrates why MCP matters: generic breed advice is free in the markdown; protocols *grounded in this dog's history* are not.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "dog_id": { "type": "string", "format": "uuid" },
    "situation": {
      "type": "string",
      "minLength": 10,
      "maxLength": 1000,
      "description": "Describe the dog's behaviour, the trigger, and any recent context. More detail = more targeted protocol."
    }
  },
  "required": ["dog_id", "situation"],
  "additionalProperties": false
}
```

### Return schema (success)

```json
{
  "type": "object",
  "properties": {
    "dog_id":              { "type": "string" },
    "identified_type":     { "enum": ["fear-based", "frustration-based", "excitement-based", "mixed"] },
    "confidence":          { "enum": ["high", "medium", "low"], "description": "Confidence in the type classification. Low → suggest trainer referral." },
    "protocol_name":       { "type": "string", "description": "e.g. 'Engage-Disengage Level 2 for off-leash dog frustration'" },
    "session_plan": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "step":          { "type": "integer", "minimum": 1 },
          "duration_min":  { "type": "integer" },
          "what_to_do":    { "type": "string" },
          "what_to_look_for": { "type": "string" }
        },
        "required": ["step", "what_to_do"]
      }
    },
    "equipment":           { "type": "array", "items": { "type": "string" } },
    "green_flags":         { "type": "array", "items": { "type": "string" }, "description": "Signs the protocol is working." },
    "red_flags":           { "type": "array", "items": { "type": "string" }, "description": "Stop conditions — escalate to trainer." },
    "expected_timeline":   { "type": "string", "description": "Realistic timeframe — Shadow is honest about non-linear progress." },
    "trainer_referral_recommended": { "type": "boolean" },
    "coaching_note":       { "type": "string" }
  },
  "required": ["dog_id", "identified_type", "protocol_name", "session_plan", "coaching_note"]
}
```

### Error cases

- `auth_required`, `forbidden`, `not_found`, **`subscription_required`**, `invalid_params`, `rate_limited`, **`aversive_refused`**.

### Worked example

**Input:**
```json
{
  "dog_id": "9a8e4f1b-...",
  "situation": "Loki sees an off-leash dog 30m away on our morning walk. He locks on, body stiffens, then lunges forward barking. He pulls TOWARD the dog, not away. Has been worse this week after a botched encounter on Saturday."
}
```

**Returned content (truncated):**
```json
{
  "dog_id": "9a8e4f1b-...",
  "identified_type": "frustration-based",
  "confidence": "high",
  "protocol_name": "Engage-Disengage Level 2 + recovery week after trigger stacking",
  "session_plan": [
    { "step": 1, "duration_min": 5, "what_to_do": "Start at 40m — past his current threshold. Mark and reward for noticing the dog calmly.", "what_to_look_for": "Soft eyes, loose body, voluntary check-in within 3 seconds." },
    { "step": 2, "duration_min": 10, "what_to_do": "Close to 30m only after 5 clean check-ins at 40m. Mark BEFORE he locks on.", "what_to_look_for": "Voluntary disengagement (Level 2). If he locks, distance was too close — back off." },
    { "step": 3, "duration_min": 5, "what_to_do": "End on a win. Walk away in the direction away from the trigger.", "what_to_look_for": "Body shake-off — sign of post-arousal recovery." }
  ],
  "equipment": ["Front-clip harness", "20 ft biothane long line", "High-value treats (cheese, chicken)"],
  "green_flags": ["Voluntary check-ins increase", "Lunging window before reaction widens", "Latency to recovery after a trigger shortens"],
  "red_flags": ["Threshold distance growing instead of shrinking", "Two consecutive sessions over score 4", "Any redirected aggression toward handler"],
  "expected_timeline": "Frustration-based reactivity is typically 6–12 weeks of consistent work to see clear threshold-distance improvement. The setback after Saturday is normal trigger stacking — give him a 'cortisol vacation' this week (no triggers, decompression walks only) before resuming.",
  "trainer_referral_recommended": false,
  "coaching_note": "🐾 Saturday's encounter raised his baseline arousal, and that's bleeding into this week's walks. This is the classic frustration-stacking pattern, not regression. Give Loki the recovery window, then come back to Engage-Disengage at 40m and work back down. The pull-FORWARD is your diagnostic — he wants to greet, not fight. That's actually the easier reactivity type to resolve. ✅"
}
```

---

## Implementation parity checklist

These items must hold true between this spec and the deployed server:

- [ ] Tool names match `manifest.ts` exactly. No typos, no case differences.
- [ ] Every Zod schema in `tools/*.ts` accepts exactly the inputs documented here and rejects everything else.
- [ ] Every successful return includes a non-empty `coaching_note`.
- [ ] Every error sets `isError: true` and uses a code from the reserved list above.
- [ ] `lookup_breed` is the *only* tool reachable without a bearer token.
- [ ] `get_progress` and `recommend_protocol` check subscription tier and return `subscription_required` for free-tier callers.
- [ ] Aversive-method scanning runs before any backend write for `log_walk` and before any protocol generation for `recommend_protocol`.
- [ ] Rate limits enforced at the edge (CDN + middleware), not just in tool handlers.

A drift check should run in CI: parse `manifest.ts`, parse this Markdown, diff the tool surface. Any divergence fails the build.
