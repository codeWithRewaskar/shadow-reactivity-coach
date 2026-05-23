# Testing Shadow MCP with `@modelcontextprotocol/inspector`

The MCP Inspector is the official web UI for poking an MCP server. It's the fastest way to verify the transport, browse tools and resources, and call tools with form-driven argument input.

Repo: [github.com/modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector).

## 1. Run it

No global install needed — `npx` will fetch and run the latest release:

```bash
npx @modelcontextprotocol/inspector
```

The inspector starts two services:

- **MCPI** (the React UI) on `http://localhost:6274`
- **MCPP** (the proxy that talks to your MCP server) on `http://localhost:6277`

When the UI opens, you'll see a connection form on the left.

## 2. Connect to the local Shadow server

Make sure the Shadow edge function is running first (`supabase functions serve shadow-coach --env-file .env.local` from `mcp/edge-function/` — see that README for env setup).

In the Inspector UI:

| Field | Value |
|-------|-------|
| Transport | `Streamable HTTP` |
| URL | `http://localhost:54321/functions/v1/shadow-coach` |
| Headers (optional) | `Authorization: Bearer <TOKEN>` if exercising auth'd tools |

Click **Connect**. The inspector sends `initialize` under the hood. On success, the left rail shows the server name (`shadow-coach`), version, and capabilities — both `tools` and `resources` should light up.

## 3. What to expect

- **Initialize**: server returns protocol version `2025-03-26`, capabilities `{ tools: {listChanged:false}, resources: {subscribe:false, listChanged:false} }`.
- **Tools** tab: 5 tools listed — `lookup_breed`, `get_dog_profile`, `log_walk`, `get_progress`, `recommend_protocol`. Each shows its inputSchema and outputSchema (added in v2.1.5 for MCP 2025-06-18 clients).
- **Resources** tab: 1 resource listed — `shadow://skill/SKILL.md` (`text/markdown`). Click it to read the full SKILL.md inline.

## 4. First thing to try

Open the **Tools** tab, click `lookup_breed`, fill in:

```json
{ "breed": "Border Collie" }
```

Click **Run Tool**. You should get back the full `BreedProfile` JSON with reactivity type `excitement-based`, common triggers, training nuances, and a coaching note. No auth required.

For an auth'd tool, paste a Supabase access token into the Headers section of the connection form (`Authorization: Bearer <jwt>`), reconnect, then try `get_dog_profile` with a real `dog_id` UUID from your Calming Paws app.

## 5. Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| CORS error in browser console | The inspector origin (`http://localhost:6274`) isn't in `ALLOWED_ORIGINS`. Add it to your edge function's `.env.local`. |
| `401 Unauthorized` on connect | Trying to GET the server root without an Authorization header. Use the Streamable HTTP transport — it POSTs by default. |
| `Missing or expired Mcp-Session-Id` | Inspector lost session state. Click **Reconnect** to issue a fresh `initialize`. |
| `auth_required` on a tool call | Expected — that tool requires a Bearer token. Add `Authorization: Bearer <TOKEN>` to the connection headers and reconnect. |
| Inspector can't find the server | Check that `supabase functions serve shadow-coach` is still running and that the URL matches its `--port` (default 54321). |

## 6. Why use this over curl

The inspector is great for:

- Exploring the schema visually (form-driven argument input)
- Reading the SKILL.md resource without piping through `jq`
- Watching the request/response history as you iterate

curl is great for:

- Scripted, repeatable runs (see `curl-recipes.sh`)
- Capturing exact request/response payloads for bug reports
- Running on machines without a browser

Use whichever's faster for the task at hand.
