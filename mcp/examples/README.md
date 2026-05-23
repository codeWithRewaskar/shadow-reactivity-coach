# Shadow MCP — Examples

How to exercise the Shadow MCP server end-to-end while developing or evaluating it. Two recipes are bundled here — pick whichever fits your style:

| File | What it is |
|------|------------|
| [`curl-recipes.sh`](./curl-recipes.sh) | Copy-paste bash blocks that cover the full session lifecycle: initialize → list tools → list resources → read SKILL.md → call tools → trigger the force-free guardrail → tear down. |
| [`inspector.md`](./inspector.md) | Walk-through for the official `@modelcontextprotocol/inspector` web UI — the easiest way to poke the server visually. |

## Typical flow

1. **Run the server locally.** From inside this repo:

   ```bash
   cd mcp/edge-function
   supabase functions serve shadow-coach --env-file .env.local
   ```

   The function listens on `http://localhost:54321/functions/v1/shadow-coach`. See [`edge-function/README.md`](../edge-function/README.md) for the full setup (env vars, Supabase project ref, etc.).

2. **Exercise it.** Open `curl-recipes.sh` and copy blocks into your shell, or run `npx @modelcontextprotocol/inspector` and follow `inspector.md`.

3. **(Optional) Test the auth path.** The `lookup_breed` tool works without any auth, so you can verify the transport plumbing before standing up a token. To exercise the auth'd tools (`get_dog_profile`, `log_walk`, `get_progress`, `recommend_protocol`), you'll need a Supabase access token from a real Calming Paws app session — paste it as `Authorization: Bearer <TOKEN>`.

## OAuth in one paragraph

For production deployments, MCP clients discover the authorization server via the Protected Resource Metadata document served at `/.well-known/oauth-protected-resource`. The client then does the OAuth 2.1 + PKCE dance against Supabase Auth, receives a JWT, and forwards it on every JSON-RPC request as `Authorization: Bearer <jwt>`. Inside the server, `auth.ts` verifies the token, extracts scopes, and `checkToolAccess` gates each tool by its required scopes. Locally, you can skip the OAuth dance by pasting a Supabase user JWT directly. See [`../oauth-flow.md`](../oauth-flow.md) for the full sequence.

## What's exercised

| Surface | Recipe block |
|---------|--------------|
| `initialize` + session ID propagation | curl 1, inspector "Initialize" |
| `tools/list` | curl 2, inspector tools tab |
| `resources/list` + `resources/read` (SKILL.md) | curl 3-4 |
| `tools/call` with `lookup_breed` (no auth) | curl 5 |
| `tools/call` auth gate (`auth_required` error) | curl 6 |
| `tools/call` with Bearer token | curl 7-8 |
| Force-free guardrail (`force_free_violation`) | curl 9 |
| `DELETE /` session teardown | curl 10 |

Once you've got these green, you've covered the transport contract, the auth boundary, the resources surface, and the guardrail logic — which is most of what matters in v2.1.
