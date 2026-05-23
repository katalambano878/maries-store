/**
 * Manually mark specific orders as paid using the mark_order_paid RPC.
 * Use when Paystack received the money but the webhook never updated the DB.
 *
 * Edit ORDERS below then run:
 *   node scripts/mark-orders-paid.mjs
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const env = { ...loadEnv(), ...process.env };
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Orders confirmed by admin as paid (money received in Paystack).
const ORDERS = [
  { order_number: 'ORD-1776618702167-61', who: 'timahworld@gmail.com (Timah Agyei)' },
  { order_number: 'ORD-1776502906776-269', who: 'carolynassuah@yahoo.com' },
];

for (const { order_number, who } of ORDERS) {
  console.log(`\n--- ${order_number}  (${who}) ---`);

  const { data: before, error: beforeErr } = await sb
    .from('orders')
    .select('order_number, status, payment_status, total, currency, metadata')
    .eq('order_number', order_number)
    .maybeSingle();
  if (beforeErr || !before) {
    console.log(`  NOT FOUND: ${beforeErr?.message || 'no match'}`);
    continue;
  }
  console.log(`  Before: status=${before.status}  payment=${before.payment_status}  total=${before.currency} ${before.total}  stock_reduced=${before.metadata?.stock_reduced ? 'yes' : 'no'}`);

  const { data, error } = await sb.rpc('mark_order_paid', {
    order_ref: order_number,
    moolre_ref: null,
  });
  if (error) {
    console.log(`  RPC FAILED: ${error.message}`);
    continue;
  }

  const { data: after } = await sb
    .from('orders')
    .select('order_number, status, payment_status, metadata')
    .eq('order_number', order_number)
    .maybeSingle();
  console.log(`  After:  status=${after?.status}  payment=${after?.payment_status}  stock_reduced=${after?.metadata?.stock_reduced ? 'yes' : 'no'}`);
  console.log(`  ✓ marked as paid`);
}

console.log('\nDone.');
