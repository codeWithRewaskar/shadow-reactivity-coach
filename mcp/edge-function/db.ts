/**
 * db.ts — Supabase client factory for tool handlers.
 *
 * The Shadow MCP server's data-plane access pattern:
 *
 *   1. The caller's JWT is verified in auth.ts and stored in AuthContext.bearer_token.
 *   2. Tool handlers construct a per-request Supabase client via makeUserClient(jwt),
 *      which forwards the caller's bearer token on every PostgREST request.
 *   3. Supabase's RLS policies (the source of truth for authz) then gate every
 *      INSERT/SELECT/UPDATE/DELETE by the user identified in the JWT.
 *
 * This means we deliberately use the ANON key here, not the service-role key.
 * The service-role key bypasses RLS and would defeat the user-scoped
 * authorization model. With the anon key + user JWT, RLS does the gating.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Build a Supabase client scoped to a single caller's JWT.
 *
 * Every PostgREST request issued by this client will carry the user's bearer
 * token in the Authorization header — RLS sees `auth.uid()` as the calling
 * user and applies the project's existing policies.
 *
 * @param jwt The raw bearer token from AuthContext.bearer_token. Must be a
 *            verified token (auth.ts validates aud/iss/exp/signature before
 *            we ever land here).
 */
export function makeUserClient(jwt: string): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Re-export the SupabaseClient type so tool handlers can declare the
// dependency-injection seam without re-importing the npm specifier.
export type { SupabaseClient };
