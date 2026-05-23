/**
 * Fix RLS policies on orders & order_items tables so both
 * guest (anon) and authenticated users can place orders.
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const altPath = path.join(__dirname, '..', '.env');
  const p = fs.existsSync(envPath) ? envPath : fs.existsSync(altPath) ? altPath : null;
  if (!p) return {};
  return Object.fromEntries(
    fs.readFileSync(p, 'utf-8').split('\n')
      .filter(l => /^[A-Z_]+=/.test(l.trim()))
      .map(l => { const eq = l.indexOf('='); return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()]; })
  );
}

const env = { ...process.env, ...loadEnv() };
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const PROJECT_REF = SUPABASE_URL?.match(/([a-zA-Z0-9]{20,})\.supabase\.co/)?.[1];
const POOLER_REGIONS = ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'ca-central-1', 'us-west-1'];

const SQL = `
-- =============================================
-- FIX: orders & order_items RLS for checkout
-- =============================================

-- 1. GRANT permissions to roles
GRANT SELECT, INSERT, UPDATE ON public.orders TO anon;
GRANT SELECT, INSERT, UPDATE ON public.orders TO authenticated;
GRANT SELECT, INSERT ON public.order_items TO anon;
GRANT SELECT, INSERT ON public.order_items TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 2. Drop all existing order policies (clean slate)
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can create guest orders" ON public.orders;
DROP POLICY IF EXISTS "Anyone can create orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can view guest orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can view guest orders by email" ON public.orders;
DROP POLICY IF EXISTS "Users can update own orders" ON public.orders;
DROP POLICY IF EXISTS "Anon can update guest orders" ON public.orders;

DROP POLICY IF EXISTS "Users can view own order items" ON public.order_items;
DROP POLICY IF EXISTS "Users can insert order items" ON public.order_items;
DROP POLICY IF EXISTS "Anyone can insert order items" ON public.order_items;

-- 3. Recreate orders policies
CREATE POLICY "Auth users view own orders"
  ON public.orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Anon view guest orders"
  ON public.orders FOR SELECT
  USING (user_id IS NULL);

CREATE POLICY "Anyone can place orders"
  ON public.orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Auth users update own orders"
  ON public.orders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Anon update guest orders"
  ON public.orders FOR UPDATE
  USING (user_id IS NULL);

-- 4. Recreate order_items policies
CREATE POLICY "View own order items"
  ON public.order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_items.order_id
        AND (orders.user_id = auth.uid() OR orders.user_id IS NULL)
    )
  );

CREATE POLICY "Anyone can insert order items"
  ON public.order_items FOR INSERT
  WITH CHECK (true);
`;

async function tryConnect(connStr, label) {
  const client = new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    console.log(`Connected via ${label}`);
    return client;
  } catch (err) {
    console.log(`${label} failed: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== Fix Orders RLS Policies ===\n');

  let client = null;

  if (env.DATABASE_URL) {
    client = await tryConnect(env.DATABASE_URL, 'DATABASE_URL');
  }

  if (!client && env.SUPABASE_DB_PASSWORD && PROJECT_REF) {
    const pw = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
    for (const region of POOLER_REGIONS) {
      client = await tryConnect(`postgresql://postgres.${PROJECT_REF}:${pw}@aws-0-${region}.pooler.supabase.com:5432/postgres`, `Session pooler (${region})`);
      if (client) break;
      client = await tryConnect(`postgresql://postgres.${PROJECT_REF}:${pw}@aws-0-${region}.pooler.supabase.com:6543/postgres`, `Transaction pooler (${region})`);
      if (client) break;
    }
    if (!client) {
      const pw2 = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
      client = await tryConnect(`postgresql://postgres:${pw2}@db.${PROJECT_REF}.supabase.co:5432/postgres`, 'Direct connection');
    }
  }

  if (!client) {
    console.error('\nERROR: No database connection available.');
    console.error('Add DATABASE_URL or SUPABASE_DB_PASSWORD to .env.local');
    console.error(`\nOr run this SQL manually in: https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new\n`);
    console.log(SQL);
    process.exit(1);
  }

  try {
    console.log('\nRunning RLS fix...');
    await client.query(SQL);
    console.log('\n✓ All orders & order_items RLS policies fixed!');
    console.log('  - Guests (anon) can now place orders');
    console.log('  - Authenticated users can place & view their orders');
    console.log('  - Order items follow the same rules');
  } catch (err) {
    console.error('\nSQL failed:', err.message);
    console.error('\nRun this SQL manually in Supabase SQL Editor:');
    console.log(SQL);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
