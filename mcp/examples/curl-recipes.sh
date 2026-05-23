# Shadow MCP — copy/paste curl recipes
#
# Usage: copy any block into your terminal. These are NOT meant to be run as a
# script — each block is independent and uses environment variables you set
# along the way. The blocks below assume the server is running at:
#
#     http://localhost:54321/functions/v1/shadow-coach
#
# If your local Supabase function URL is different, set:
#
#     export MCP=http://your-local-host:port/functions/v1/shadow-coach
#
# and substitute "$MCP" for the URL in each block.
#
# Replace <TOKEN> with a Supabase access token from your Calming Paws app
# session whenever a block needs auth. For testing without OAuth, the
# `lookup_breed` tool and all transport plumbing (initialize, resources/*)
# work without a token.
#
# The blocks assume jq is on PATH — install with `brew install jq` (macOS)
# or `apt-get install jq` (Linux). It only makes responses easier to read;
# you can drop the `| jq` if you prefer raw JSON.

export MCP=http://localhost:54321/functions/v1/shadow-coach


# === 1. Initialize a session ===
# Capture the Mcp-Session-Id from the response headers — every subsequent
# call needs it. Curl prints headers with `-i`.
#
# Expected: 200 OK, JSON-RPC result with protocolVersion "2025-03-26",
# capabilities.tools, capabilities.resources, and an Mcp-Session-Id header.

curl -i -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl-recipes", "version": "0.0.1" }
    }
  }'

# Grab the session id from the response and stash it for the rest of the recipes:
export SESSION_ID="<paste-Mcp-Session-Id-header-from-step-1>"


# === 2. List tools ===
# Expected: { tools: [ {name, description, inputSchema, outputSchema}, ... ] }
# 5 tools should be listed: lookup_breed, get_dog_profile, log_walk,
# get_progress, recommend_protocol.

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }' | jq


# === 3. List resources ===
# Expected: { resources: [ { uri: "shadow://skill/SKILL.md", ... } ] }

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }' | jq


# === 4. Read SKILL.md resource ===
# Expected: { contents: [ { uri, mimeType: "text/markdown", text: "..." } ] }
# The `text` field contains the full SKILL.md document (~256 lines).
# Pipe through jq's `.result.contents[0].text` to extract just the markdown.

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "resources/read",
    "params": { "uri": "shadow://skill/SKILL.md" }
  }' | jq -r '.result.contents[0].text' | head -30


# === 5. Call lookup_breed (no auth required) ===
# Expected: { content: [ { type: "text", text: <JSON BreedProfile> } ], isError: false }
# Try other breeds: "Chihuahua", "GSD", "Lab", or an alias like "BC".

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "lookup_breed",
      "arguments": { "breed": "Border Collie" }
    }
  }' | jq


# === 6. Call get_dog_profile without auth (expect auth_required error) ===
# Expected: result.isError = true, result.content[0].text contains
# { "code": "auth_required", "message": "...", "cta": "https://calming-paws.com/" }
# This is the demo-mode gate: only lookup_breed is reachable without auth.

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "get_dog_profile",
      "arguments": { "dog_id": "11111111-1111-1111-1111-111111111111" }
    }
  }' | jq


# === 7. Call get_dog_profile with a Bearer token ===
# Replace <TOKEN> with a Supabase access token. The dog_id must be a real
# UUID for a dog you own (RLS gates the SELECT).
# Expected: isError=false, content[0].text contains a JSON DogProfile.

export TOKEN="<TOKEN>"
export DOG_ID="<your-dog-uuid>"

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 7,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"get_dog_profile\",
      \"arguments\": { \"dog_id\": \"$DOG_ID\" }
    }
  }" | jq


# === 8. Call log_walk (auth'd) ===
# Logs a walk with a sample threshold score and trigger list. RLS will
# reject the write if the caller doesn't own DOG_ID.
# Expected: isError=false, content[0].text contains
# { walk_id, dog_id, logged_at, triggers, threshold_score, coaching_note }.

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 8,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"log_walk\",
      \"arguments\": {
        \"dog_id\": \"$DOG_ID\",
        \"triggers\": [\"other dog\", \"cyclist\"],
        \"threshold_score\": 2,
        \"notes\": \"Quiet morning walk — Border Collie stayed sub-threshold near a passing bike at 30 feet.\"
      }
    }
  }" | jq


# === 9. Trigger the force-free guardrail ===
# Notes mention "shock collar" — the tool will refuse with a redirect.
# Expected: isError=true, content[0].text contains
# { "code": "force_free_violation", "message": "...", "resources": [...] }.
# No DB write happens — the guardrail runs before any insert.

curl -s -X POST "$MCP" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 9,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"log_walk\",
      \"arguments\": {
        \"dog_id\": \"$DOG_ID\",
        \"triggers\": [\"other dog\"],
        \"threshold_score\": 3,
        \"notes\": \"Tried a shock collar today, what protocol should I follow?\"
      }
    }
  }" | jq


# === 10. End the session ===
# DELETE /<path> with the Mcp-Session-Id clears server-side session state.
# Expected: HTTP 200, empty body.

curl -i -s -X DELETE "$MCP" \
  -H "Mcp-Session-Id: $SESSION_ID"
