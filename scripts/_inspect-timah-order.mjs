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

const { data: order, error } = await sb
  .from('orders')
  .select('*')
  .eq('order_number', 'ORD-1776618702167-61')
  .maybeSingle();

if (error) { console.error(error); process.exit(1); }
if (!order) { console.log('order not found'); process.exit(0); }

console.log('ORDER KEYS:', Object.keys(order).sort().join(', '));
console.log('\nFULL ORDER:');
console.dir(order, { depth: 5 });

console.log('\n=== Abandoned carts by this customer ===');
const { data: carts } = await sb
  .from('abandoned_carts')
  .select('*')
  .or(`email.eq.${order.email},phone.eq.${order.phone}`);
console.dir(carts, { depth: 5 });
