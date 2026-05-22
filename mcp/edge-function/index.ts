/**
 * index.ts — Shadow MCP Server entry point
 *
 * MCP Transport: Streamable HTTP (spec version 2025-03-26)
 * Reference: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 *
 * Transport summary implemented here:
 *   POST /  — Accepts JSON-RPC requests. Responds with application/json
 *             for simple request/response, or text/event-stream for SSE
 *             when the client Accept header includes it. This scaffold always
 *             responds with application/json (no long-running streams needed
 *             for these tools).
 *   GET  /  — Returns HTTP 405 (this server has no server-initiated streams).
 *   DELETE / — Terminates the session (responds 200, clears session state).
 *
 * Session management: optional Mcp-Session-Id header. We assign a session ID
 * on InitializeResult and require it on subsequent requests.
 *
 * Runtime: Supabase Edge Functions — Deno 2.x
 * Import conventions: npm: and jsr: specifiers (no https:// imports).
 * Entrypoint: Deno.serve() — the built-in, no std/http/server.ts needed.
 *
 * Auth: handled by auth.ts (demo / OAuth 2.1 / BYO JWT).
 * Rate limiting: handled by ratelimit.ts (in-memory scaffold).
 */

import { resolveAuth, checkToolAccess } from "./auth.ts";
import { checkRateLimit, getClientIP } from "./ratelimit.ts";
import { buildToolsList } from "./manifest.ts";

// Tool handlers
import { LookupBreedParamsSchema, lookupBreed } from "./tools/lookup_breed.ts";
import { GetDogProfileParamsSchema, getDogProfile } from "./tools/get_dog_profile.ts";
import { LogWalkParamsSchema, logWalk } from "./tools/log_walk.ts";
import { GetProgressParamsSchema, getProgress } from "./tools/get_progress.ts";
import { RecommendProtocolParamsSchema, recommendProtocol } from "./tools/recommend_protocol.ts";

// --- JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// JSON-RPC standard error codes
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// --- Session management ---
// Lightweight in-memory session store (ephemeral — resets on cold start).
// TODO (production): Replace with Supabase KV or Upstash Redis for
// cross-instance session sharing.

interface Session {
  created_at: number;
  user_id?: string;
}
const sessions = new Map<string, Session>();

function generateSessionId(): string {
  // Cryptographically secure random session ID (URL-safe base64)
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// --- CORS helpers ---

function getAllowedOrigins(): string[] {
  const env = Deno.env.get("ALLOWED_ORIGINS") ?? "https://calming-paws.com";
  return env.split(",").map((o) => o.trim()).filter(Boolean);
}

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = getAllowedOrigins();
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id, Accept",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// Validate the Origin header to prevent DNS rebinding attacks
// (required by MCP spec 2025-03-26 transport security guidance).
function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Requests with no Origin (e.g. direct curl, server-to-server) are allowed.
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
}

// --- Response builders ---

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// --- Tool dispatch ---

interface ToolCallContent {
  type: "text";
  text: string;
}

interface ToolCallResult {
  content: ToolCallContent[];
  isError: boolean;
}

async function dispatchToolCall(
  toolName: string,
  args: unknown,
  req: Request
): Promise<ToolCallResult> {
  // Resolve auth context
  const ctx = await resolveAuth(req);

  // Check per-tool access control
  const accessError = checkToolAccess(ctx, toolName);
  if (accessError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: accessError.code,
            message: accessError.message,
            ...(accessError.cta ? { cta: accessError.cta } : {}),
          }),
        },
      ],
      isError: true,
    };
  }

  // Rate limiting
  const rateLimitKind = ctx.kind === "demo" ? "demo" : "auth";
  const rateLimitKey = ctx.kind === "demo" ? getClientIP(req) : (ctx.user_id ?? "unknown");
  const rl = checkRateLimit(rateLimitKind, rateLimitKey);
  if (!rl.allowed) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "rate_limited",
            message: `Too many requests. Please wait ${rl.retry_after ?? 60} seconds and try again.`,
            retry_after: rl.retry_after,
          }),
        },
      ],
      isError: true,
    };
  }

  // Parse and validate params, then call the handler
  switch (toolName) {
    case "lookup_breed": {
      const parsed = LookupBreedParamsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", errors: parsed.error.issues }) }],
          isError: true,
        };
      }
      return lookupBreed(parsed.data, ctx);
    }

    case "get_dog_profile": {
      const parsed = GetDogProfileParamsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", errors: parsed.error.issues }) }],
          isError: true,
        };
      }
      return getDogProfile(parsed.data, ctx);
    }

    case "log_walk": {
      const parsed = LogWalkParamsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", errors: parsed.error.issues }) }],
          isError: true,
        };
      }
      return logWalk(parsed.data, ctx);
    }

    case "get_progress": {
      const parsed = GetProgressParamsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", errors: parsed.error.issues }) }],
          isError: true,
        };
      }
      return getProgress(parsed.data, ctx);
    }

    case "recommend_protocol": {
      const parsed = RecommendProtocolParamsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", errors: parsed.error.issues }) }],
          isError: true,
        };
      }
      return recommendProtocol(parsed.data, ctx);
    }

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ code: "not_found", message: `Unknown tool: ${toolName}` }) }],
        isError: true,
      };
  }
}

// --- MCP method handlers ---

async function handleInitialize(
  req: JsonRpcRequest
): Promise<{ response: JsonRpcSuccess; sessionId: string }> {
  const sessionId = generateSessionId();
  sessions.set(sessionId, { created_at: Date.now() });

  const result = {
    protocolVersion: "2025-03-26",
    serverInfo: {
      name: "shadow-coach",
      version: "2.1.0",
      description:
        "Shadow — Force-free reactive dog training coach, powered by Calming Paws (https://calming-paws.com/)",
    },
    capabilities: {
      tools: {
        // We don't dynamically change the tool list, but we declare it for spec compliance.
        listChanged: false,
      },
    },
  };

  return { response: rpcSuccess(req.id ?? null, result), sessionId };
}

function handleToolsList(req: JsonRpcRequest): JsonRpcSuccess {
  return rpcSuccess(req.id ?? null, buildToolsList());
}

async function handleToolsCall(
  req: JsonRpcRequest,
  httpReq: Request
): Promise<JsonRpcSuccess> {
  const params = req.params as Record<string, unknown> | undefined;
  const toolName = params?.name as string | undefined;
  const toolArgs = params?.arguments ?? {};

  if (!toolName) {
    return rpcSuccess(req.id ?? null, {
      content: [{ type: "text", text: JSON.stringify({ code: "invalid_params", message: "Missing tool name" }) }],
      isError: true,
    });
  }

  const result = await dispatchToolCall(toolName, toolArgs, httpReq);
  return rpcSuccess(req.id ?? null, result);
}

// --- Main request handler ---

/** Canonical resource URI advertised in Protected Resource Metadata. */
function getResourceUri(): string {
  return Deno.env.get("MCP_RESOURCE_URI") ?? "https://mcp.calming-paws.com";
}

/** Authorization server(s) advertised in Protected Resource Metadata. */
function getAuthorizationServers(): string[] {
  const env = Deno.env.get("MCP_AUTH_SERVERS");
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (supabaseUrl) return [`${supabaseUrl.replace(/\/+$/, "")}/auth/v1`];
  return ["https://calming-paws.com"];
}

/** `WWW-Authenticate: Bearer ...` header per RFC 9728 §5.3. */
function wwwAuthenticateHeader(): string {
  const resource = getResourceUri();
  return `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const corsHeaders = buildCorsHeaders(req);

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // DNS rebinding protection (MCP spec security requirement)
  if (!isOriginAllowed(req)) {
    return jsonResponse(
      { error: "Origin not allowed" },
      403,
      corsHeaders
    );
  }

  // --- Protected Resource Metadata (RFC 9728) ---
  // Required by MCP authorization spec. MUST be served by the resource
  // server (this MCP) — not the authorization server.
  if (
    req.method === "GET" &&
    url.pathname.endsWith("/.well-known/oauth-protected-resource")
  ) {
    return jsonResponse(
      {
        resource: getResourceUri(),
        authorization_servers: getAuthorizationServers(),
        scopes_supported: [
          "profile:read",
          "walks:write",
          "progress:read",
          "protocols:read",
        ],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://calming-paws.com/docs/mcp",
      },
      200,
      corsHeaders
    );
  }

  // GET — we don't offer a persistent SSE stream. Return 401 with
  // WWW-Authenticate when the caller is unauthenticated so MCP clients
  // can discover the Protected Resource Metadata document; otherwise 405.
  if (req.method === "GET") {
    if (!req.headers.get("Authorization")) {
      return new Response(
        "Unauthorized — fetch /.well-known/oauth-protected-resource to discover the authorization server.",
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "WWW-Authenticate": wwwAuthenticateHeader(),
          },
        }
      );
    }
    return new Response("Method Not Allowed — this MCP server does not offer server-initiated SSE streams.", {
      status: 405,
      headers: { ...corsHeaders, Allow: "POST, DELETE, OPTIONS" },
    });
  }

  // DELETE — terminate session
  if (req.method === "DELETE") {
    const sessionId = req.headers.get("Mcp-Session-Id");
    if (sessionId) sessions.delete(sessionId);
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...corsHeaders, Allow: "POST, DELETE, OPTIONS" },
    });
  }

  // --- POST — parse JSON-RPC ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      rpcError(null, RPC_PARSE_ERROR, "Parse error: invalid JSON"),
      400,
      corsHeaders
    );
  }

  // We handle only single JSON-RPC objects (not batches) in this scaffold.
  // Batch support can be added by mapping over an array.
  if (Array.isArray(body)) {
    return jsonResponse(
      rpcError(null, RPC_INVALID_REQUEST, "Batch requests are not supported by this server"),
      400,
      corsHeaders
    );
  }

  const rpcReq = body as JsonRpcRequest;
  if (!rpcReq.jsonrpc || rpcReq.jsonrpc !== "2.0" || !rpcReq.method) {
    return jsonResponse(
      rpcError(rpcReq.id ?? null, RPC_INVALID_REQUEST, "Invalid JSON-RPC 2.0 request"),
      400,
      corsHeaders
    );
  }

  // Session ID validation (required on all non-initialize requests)
  const incomingSessionId = req.headers.get("Mcp-Session-Id");
  if (rpcReq.method !== "initialize" && rpcReq.method !== "notifications/initialized") {
    if (!incomingSessionId || !sessions.has(incomingSessionId)) {
      // Clients without a session ID (other than on first init) must start over.
      return jsonResponse(
        rpcError(
          rpcReq.id ?? null,
          RPC_INVALID_REQUEST,
          "Missing or expired Mcp-Session-Id. Send an initialize request to start a new session."
        ),
        400,
        corsHeaders
      );
    }
  }

  // --- Route to MCP method ---
  let responseBody: JsonRpcResponse;
  const responseHeaders: Record<string, string> = { ...corsHeaders };

  try {
    switch (rpcReq.method) {
      case "initialize": {
        const { response, sessionId } = await handleInitialize(rpcReq);
        responseBody = response;
        responseHeaders["Mcp-Session-Id"] = sessionId;
        break;
      }

      case "notifications/initialized":
        // Client sends this after receiving InitializeResult — no response needed.
        return new Response(null, { status: 202, headers: corsHeaders });

      case "ping":
        responseBody = rpcSuccess(rpcReq.id ?? null, {});
        break;

      case "tools/list":
        responseBody = handleToolsList(rpcReq);
        break;

      case "tools/call":
        responseBody = await handleToolsCall(rpcReq, req);
        break;

      default:
        responseBody = rpcError(
          rpcReq.id ?? null,
          RPC_METHOD_NOT_FOUND,
          `Method not found: ${rpcReq.method}`
        );
    }
  } catch (err: unknown) {
    console.error("[shadow-coach] Internal error:", err);

    // Auth errors with known codes
    if (err instanceof Error && "code" in err) {
      const authErr = err as Error & { code: string };
      if (authErr.code === "auth_expired") {
        responseBody = rpcError(rpcReq.id ?? null, RPC_INVALID_PARAMS, "Token expired. Re-authenticate and try again.");
        // Surface the Protected Resource Metadata discovery hint so clients can refresh.
        responseHeaders["WWW-Authenticate"] = wwwAuthenticateHeader();
      } else if (authErr.code === "auth_invalid") {
        responseBody = rpcError(rpcReq.id ?? null, RPC_INVALID_PARAMS, `Auth error: ${err.message}`);
        responseHeaders["WWW-Authenticate"] = wwwAuthenticateHeader();
      } else {
        responseBody = rpcError(rpcReq.id ?? null, RPC_INTERNAL_ERROR, "Internal server error");
      }
    } else {
      responseBody = rpcError(rpcReq.id ?? null, RPC_INTERNAL_ERROR, "Internal server error");
    }
  }

  return jsonResponse(responseBody, 200, responseHeaders);
}

// --- Deno.serve entrypoint ---
// Supabase Edge Functions use Deno.serve() as the built-in entrypoint.
// Do not use `import { serve } from "https://deno.land/std/http/server.ts"` —
// that pattern is deprecated in Deno 2.x and not recommended for Edge Functions.

Deno.serve(handleRequest);
