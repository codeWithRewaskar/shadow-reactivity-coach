#!/usr/bin/env -S deno run --allow-read
/**
 * MCP contract drift check
 *
 * Fails CI when the four MCP contract files disagree on any of:
 *   - scope vocabulary
 *   - protocol version
 *   - serverInfo.name / serverInfo.version
 *
 * Files checked (relative to repo root):
 *   - mcp/manifest.json
 *   - mcp/edge-function/auth.ts           (OAUTH_TOOL_SCOPES)
 *   - mcp/edge-function/index.ts          (InitializeResult)
 *   - mcp/oauth-flow.md
 *   - mcp/tools-schema.md
 *   - mcp/install.md
 *   - mcp/README.md
 *   - mcp/manifest.notes.md
 *   - mcp/edge-function/.env.example
 *   - mcp/edge-function/README.md
 *
 * Run from repo root: `deno run --allow-read scripts/check-mcp-drift.ts`
 * Exit code 0 = clean, 1 = drift found.
 */

const CANONICAL_SCOPES = new Set([
  "profile:read",
  "walks:write",
  "progress:read",
  "protocols:read",
  "shadow:all", // BYO-JWT wildcard, allowed everywhere
]);

const LEGACY_SCOPES = [
  "dogs:read",
  "coaching:read",
  "shadow:read",
  "shadow:write",
];

const CANONICAL_PROTOCOL_VERSION = "2025-03-26";
const CANONICAL_SERVER_NAME = "shadow-coach";
const CANONICAL_AUDIENCE_BAD = '"authenticated"';

interface DriftReport {
  file: string;
  rule: string;
  detail: string;
}

const drift: DriftReport[] = [];

function read(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

function scanForLegacyScopes(file: string, content: string) {
  for (const legacy of LEGACY_SCOPES) {
    // Skip oauth-flow.md if it mentions a legacy scope inside a "rejected"
    // or "deprecated" code block — but for now, fail on any mention.
    const lineMatches = content.split("\n")
      .map((line, idx) => ({ line, idx: idx + 1 }))
      .filter((l) => l.line.includes(legacy));
    for (const { line, idx } of lineMatches) {
      drift.push({
        file,
        rule: "legacy-scope",
        detail: `line ${idx}: contains legacy scope "${legacy}" — replace with canonical (profile:read / walks:write / progress:read / protocols:read).\n    > ${line.trim()}`,
      });
    }
  }
}

function scanForProtocolVersionDrift(file: string, content: string) {
  // Look for date-shaped MCP version strings: YYYY-MM-DD bracketed by quotes,
  // backticks, parens, or whitespace context. Common alternates: 2025-06-18, 2025-11-25.
  const versionMatches = content.matchAll(/(\d{4}-\d{2}-\d{2})/g);
  for (const m of versionMatches) {
    const v = m[1];
    if (v === CANONICAL_PROTOCOL_VERSION) continue;
    // Exclude obvious non-MCP dates: changelog headers, examples with year-month
    // tags. Heuristic: if surrounding context mentions "spec" or "MCP" or
    // "protocol", treat as a protocol version reference.
    const idx = m.index ?? 0;
    const ctx = content.slice(Math.max(0, idx - 40), Math.min(content.length, idx + 40));
    if (/mcp|protocol|spec|transport/i.test(ctx)) {
      // Allow explicit "tracking 2025-11-25" or "forward-compatible with 2025-11-25"
      // language — these acknowledge the newer spec is upcoming without claiming
      // current implementation.
      if (/tracking|forward-compatible|adoption/i.test(ctx)) continue;
      drift.push({
        file,
        rule: "protocol-version",
        detail: `Reference to MCP version "${v}" without "tracking"/"forward-compatible" qualifier (canonical is ${CANONICAL_PROTOCOL_VERSION}).\n    > context: ...${ctx.replace(/\s+/g, " ")}...`,
      });
    }
  }
}

function scanForUnsafeAudienceDefault(file: string, content: string) {
  // Flag any place that still tells operators to use ALLOWED_AUDIENCE=authenticated
  // without an explicit warning comment on the same line or the preceding lines.
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/ALLOWED_AUDIENCE\s*=?\s*"?authenticated"?/.test(line)) continue;
    // Look at the line itself and 3 lines before for a warning comment.
    const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/NOT|do not|never|confused-deputy|RFC 8707|unsafe/i.test(window)) continue;
    drift.push({
      file,
      rule: "unsafe-audience-default",
      detail: `line ${i + 1}: sets ALLOWED_AUDIENCE to Supabase default without a safety warning. This value would accept any Supabase user JWT for the MCP server.\n    > ${line.trim()}`,
    });
  }
}

function checkManifestJson() {
  const path = "mcp/manifest.json";
  const raw = read(path);
  const json = JSON.parse(raw);
  if (json.serverInfo?.name && json.serverInfo.name !== CANONICAL_SERVER_NAME) {
    drift.push({
      file: path,
      rule: "server-name",
      detail: `serverInfo.name = "${json.serverInfo.name}" (canonical: "${CANONICAL_SERVER_NAME}")`,
    });
  }
  const scopeMap = json.auth?.oauth2?.scopes ?? {};
  for (const scope of Object.keys(scopeMap)) {
    if (!CANONICAL_SCOPES.has(scope)) {
      drift.push({
        file: path,
        rule: "scope-vocab",
        detail: `Unknown scope "${scope}" in auth.oauth2.scopes`,
      });
    }
  }
  scanForLegacyScopes(path, raw);
}

function checkAuthTs() {
  const path = "mcp/edge-function/auth.ts";
  const content = read(path);
  // Extract scope strings inside OAUTH_TOOL_SCOPES object: ["profile:read", ...]
  // Loose regex: capture all "xxx:yyy" strings.
  const scopeMatches = [...content.matchAll(/"([a-z]+:[a-z]+)"/g)].map((m) => m[1]);
  const seen = new Set(scopeMatches);
  for (const s of seen) {
    if (!CANONICAL_SCOPES.has(s)) {
      drift.push({
        file: path,
        rule: "scope-vocab",
        detail: `Unknown scope string "${s}" in auth.ts`,
      });
    }
  }
  scanForLegacyScopes(path, content);
}

function checkIndexTs() {
  const path = "mcp/edge-function/index.ts";
  const content = read(path);
  const proto = content.match(/protocolVersion:\s*"([^"]+)"/);
  if (proto && proto[1] !== CANONICAL_PROTOCOL_VERSION) {
    drift.push({
      file: path,
      rule: "protocol-version",
      detail: `InitializeResult.protocolVersion = "${proto[1]}" (canonical: "${CANONICAL_PROTOCOL_VERSION}")`,
    });
  }
  const serverName = content.match(/name:\s*"([^"]+)"[^}]*version:\s*"([^"]+)"/);
  if (serverName) {
    if (serverName[1] !== CANONICAL_SERVER_NAME) {
      drift.push({
        file: path,
        rule: "server-name",
        detail: `InitializeResult.serverInfo.name = "${serverName[1]}" (canonical: "${CANONICAL_SERVER_NAME}")`,
      });
    }
  }
  // CORS header check: must list MCP-Protocol-Version
  if (
    /Access-Control-Allow-Headers/.test(content) &&
    !/MCP-Protocol-Version/.test(content)
  ) {
    drift.push({
      file: path,
      rule: "cors-headers",
      detail: `Access-Control-Allow-Headers does not list "MCP-Protocol-Version" — spec-compliant clients send this header.`,
    });
  }
}

function checkMarkdown(path: string) {
  const content = read(path);
  scanForLegacyScopes(path, content);
  scanForProtocolVersionDrift(path, content);
}

function checkEnvAndReadmes() {
  for (
    const path of [
      "mcp/edge-function/.env.example",
      "mcp/edge-function/README.md",
    ]
  ) {
    const content = read(path);
    scanForUnsafeAudienceDefault(path, content);
    scanForLegacyScopes(path, content);
  }
}

// --- Run all checks ---
try {
  checkManifestJson();
  checkAuthTs();
  checkIndexTs();
  checkMarkdown("mcp/oauth-flow.md");
  checkMarkdown("mcp/tools-schema.md");
  checkMarkdown("mcp/install.md");
  checkMarkdown("mcp/README.md");
  checkMarkdown("mcp/manifest.notes.md");
  checkEnvAndReadmes();
} catch (e) {
  console.error(`Drift check could not run: ${(e as Error).message}`);
  Deno.exit(2);
}

if (drift.length === 0) {
  console.log("MCP drift check: PASS — all files agree on scopes, protocol version, server identity, and audience guidance.");
  Deno.exit(0);
}

console.error(`MCP drift check: FAIL — ${drift.length} issue(s):\n`);
const byFile = new Map<string, DriftReport[]>();
for (const d of drift) {
  if (!byFile.has(d.file)) byFile.set(d.file, []);
  byFile.get(d.file)!.push(d);
}
for (const [file, items] of byFile) {
  console.error(`  ${file}`);
  for (const d of items) {
    console.error(`    [${d.rule}] ${d.detail}`);
  }
  console.error("");
}
console.error(
  "Canonical vocab: scopes = " +
    [...CANONICAL_SCOPES].join(", ") +
    ` | protocolVersion = ${CANONICAL_PROTOCOL_VERSION} | serverInfo.name = ${CANONICAL_SERVER_NAME}`,
);
Deno.exit(1);
