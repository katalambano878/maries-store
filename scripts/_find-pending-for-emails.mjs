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

const emails = ['timahworld@gmail.com', 'carolynassuah@yahoo.com'];
for (const email of emails) {
  console.log(`\n=== Orders for ${email} ===`);
  const { data, error } = await sb
    .from('orders')
    .select('order_number, total, currency, status, payment_status, created_at, metadata')
    .eq('email', email)
    .order('created_at', { ascending: false });
  if (error) { console.error(error); continue; }
  for (const o of data || []) {
    console.log(`  ${o.order_number}  ${o.currency} ${o.total}  status=${o.status}  payment=${o.payment_status}  gateway=${o.metadata?.payment_gateway || '-'}  created=${o.created_at}`);
  }
}
