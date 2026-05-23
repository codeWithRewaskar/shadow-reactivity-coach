# Add Shadow to Claude — MCP Server Install

Shadow is available as a hosted MCP server at `mcp.calming-paws.com`. Unlike the static
Markdown skill, the MCP server knows *your* dog: it reads your Calming Paws profile, logs
walks you take together, and surfaces longitudinal progress data so every coaching session
picks up exactly where the last one left off. The difference between pasting a prompt and
having a coach who remembers.

> ⚠️ **Scaffold status (v2.1.2):** the edge function in `mcp/edge-function/` is a
> reference implementation. The five tool handlers (`lookup_breed`,
> `get_dog_profile`, `log_walk`, `get_progress`, `recommend_protocol`) currently
> return illustrative mock responses. Deployers must wire them to their own
> Supabase tables (or other backend) before the server delivers real personalised
> coaching. Auth, rate limiting, scope enforcement, Protected Resource Metadata,
> and `WWW-Authenticate` discovery hints are production-shaped.

---

## Why MCP instead of the Markdown skill?

The SKILL.md file gives any LLM Shadow's complete knowledge base — breed profiles,
protocols, the three-type reactivity framework — and it's a great starting point.
The MCP server adds the layer that makes coaching *personal*:

- **Your dog's profile** — reactivity type, current threshold distance, active triggers
- **Walk logs** — log each walk from inside the conversation; Shadow uses real data, not your memory
- **Longitudinal progress** — threshold trends, reaction frequency, cortisol-vacation flags
- **Live protocol recommendations** — generated from your dog's actual walk history, not generic advice

---

## What you get

| Feature | Free Markdown Skill | MCP Server (demo) | MCP Server (signed in) | Calming Paws App |
|---------|:-------------------:|:-----------------:|:----------------------:|:----------------:|
| Force-free coaching | ✅ | ✅ | ✅ | ✅ |
| Three-type reactivity framework | ✅ | ✅ | ✅ | ✅ |
| 20 breed profiles | ✅ | ✅ | ✅ | ✅ |
| Breed lookup tool (`lookup_breed`) | — | ✅ | ✅ | ✅ |
| Dog profile (`get_dog_profile`) | — | — | ✅ | ✅ |
| Walk logging (`log_walk`) | — | — | ✅ | ✅ |
| Progress analytics (`get_progress`) | — | — | ✅ | ✅ |
| Personalised protocol (`recommend_protocol`) | — | — | ✅ | ✅ |
| Full mobile app + UI | — | — | — | ✅ |

The upgrade path: start with the skill, add the MCP server when you want Shadow to
remember your dog, move to the full app when you want the native mobile experience.

---

## Add to Claude Desktop

### One-click install

> **Note on one-click deep links:** As of May 2026, Anthropic's documented one-click
> install mechanism for remote MCP servers is the `.mcpb` Desktop Extension format
> (double-click a `.mcpb` file to install). A `claude://` URI scheme for remote HTTP
> servers has not been officially documented by Anthropic. When Anthropic publishes an
> official deep-link format for remote servers, this section will be updated.
>
> In the meantime, use the manual JSON config below — it takes about 60 seconds.

### Manual install (macOS)

1. Open **Claude Desktop** → **Settings** → **Developer** (or press `⌘,` then click the
   Developer tab).
2. Click **Edit Config** to open `claude_desktop_config.json`, or open it directly:
   ```
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```
3. Add the `shadow-coach` entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "shadow-coach": {
      "type": "http",
      "url": "https://mcp.calming-paws.com/mcp"
    }
  }
}
```

4. Save the file and **restart Claude Desktop**.
5. On first use, Claude Desktop will prompt you to sign in with your Calming Paws account
   to unlock the full tool set. You can skip sign-in to use demo mode (`lookup_breed` only).

### Manual install (Windows)

Same steps, different config path:

```
%APPDATA%\Claude\claude_desktop_config.json
```

The JSON snippet is identical to macOS.

---

## Add to Claude Code

Claude Code supports remote MCP servers natively via the `claude mcp add` command.

### One-liner (no auth — demo mode)

```bash
claude mcp add --transport http shadow-coach https://mcp.calming-paws.com/mcp
```

### With OAuth sign-in (full tool set)

```bash
claude mcp add --transport http shadow-coach https://mcp.calming-paws.com/mcp
```

Then inside a Claude Code session:

```
/mcp
```

Claude Code will detect the server requires authentication and open a browser window to
complete the Calming Paws OAuth flow. Tokens are stored securely in your system keychain
and refresh automatically.

### Commit to your project (`.mcp.json`)

To share Shadow with your whole team via version control, add to `.mcp.json` at your
project root:

```json
{
  "mcpServers": {
    "shadow-coach": {
      "type": "http",
      "url": "https://mcp.calming-paws.com/mcp"
    }
  }
}
```

Then `git commit` the file. Everyone who clones the repo gets Shadow when they run
`claude` in that directory.

---

## Demo mode vs signed-in mode

Shadow works in two modes depending on whether you're authenticated with Calming Paws.

### Demo mode (no account required)

Available immediately after adding the server — no sign-in needed.

**Available tool:** `lookup_breed`

Ask Shadow anything about a breed and it returns the full reactivity profile, common
triggers, training nuances, threshold notes, and management tips from the 20-breed
knowledge base. Good for a quick consult. Not personalised to your dog.

Example:
> "What should I know about border collie reactivity before I start threshold work?"

### Signed-in mode (Calming Paws account)

Sign in at [calming-paws.com](https://calming-paws.com/) or authenticate via the OAuth
flow when prompted.

**Available tools:** `get_dog_profile`, `log_walk`, `get_progress`, `recommend_protocol`
(plus `lookup_breed`)

Shadow now knows your dog. It reads your profile, logs walks, tracks triggers over time,
and generates protocols grounded in your actual data — not hypotheticals.

Example:
> "We just got back from a walk. Luna reacted twice to cyclists at about 40 feet. Log it
> and tell me if her threshold is improving."

---

## Troubleshooting

**Server not showing up in Claude Desktop**

- Confirm the JSON in `claude_desktop_config.json` is valid (no trailing commas, all
  brackets closed). Paste it into [jsonlint.com](https://jsonlint.com) if unsure.
- Make sure you restarted Claude Desktop after editing the config — a full quit and reopen,
  not just closing the window.
- Check the server status at [status.calming-paws.com](https://calming-paws.com/status).

**Auth loop / browser keeps opening**

- Clear the stored token: in Claude Code run `/mcp` → select `shadow-coach` →
  **Clear authentication**, then re-authenticate.
- In Claude Desktop, remove and re-add the server entry in Settings → Extensions.
- If the loop persists, clear cookies for `calming-paws.com` and `mcp.calming-paws.com`
  in your browser, then try again.

**Only `lookup_breed` works, other tools return "unauthorized"**

You're in demo mode. Run `/mcp` (Claude Code) or check Settings → Extensions (Claude
Desktop) and complete the Calming Paws sign-in flow.

**Tools show up but return empty data**

Your Calming Paws account exists but has no dog profile yet. Visit
[calming-paws.com](https://calming-paws.com/) to set up your dog's profile, then return
to Claude.

**Server connecting slowly on first use**

The server may take a few seconds on a cold start. Claude Code retries automatically with
exponential backoff. If it consistently fails to connect after 30 seconds, check
[status.calming-paws.com](https://calming-paws.com/status) or open an issue at
[github.com/codeWithRewaskar/shadow-reactivity-coach](https://github.com/codeWithRewaskar/shadow-reactivity-coach/issues).

---

## Server details

| Property | Value |
|----------|-------|
| Server name | `shadow-coach` |
| MCP endpoint | `https://mcp.calming-paws.com/mcp` |
| Server card | `https://mcp.calming-paws.com/.well-known/mcp/server-card.json` |
| Transport | Streamable HTTP (MCP spec 2025-03-26; tracking 2025-11-25 RFC 9728/8707 adoption) |
| Auth | OAuth 2.1 with PKCE |
| Demo tool | `lookup_breed` |
| Auth'd tools | `get_dog_profile`, `log_walk`, `get_progress`, `recommend_protocol` |

---

🐾 Powered by [Calming Paws](https://calming-paws.com/) — the full reactive-dog companion
app with live dog profiles, walk logs, trigger tracking, and progress analytics built in.
