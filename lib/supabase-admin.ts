import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from './db/supabase-compat';

/**
 * Server-side service-role client: runs as the database owner on plain
 * Postgres and bypasses row-level security.
 * ONLY use this in API routes and server actions — NEVER in client components.
 * Always verify the caller is authorized first.
 */
// Typed as supabase-js so call sites keep their inferred row types; the
// compat client implements the part of that API this app uses.
export const supabaseAdmin = createClient() as unknown as SupabaseClient;
