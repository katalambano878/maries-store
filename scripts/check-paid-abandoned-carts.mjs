/**
 * Check abandoned_carts for entries where the customer has GENUINELY PAID
 * (an order exists for the same phone/email with payment_status = 'paid').
 *
 * This is a READ-ONLY report by default. Pass `--fix` to mark matching
 * carts as recovered.
 *
 * Usage:
 *   node scripts/check-paid-abandoned-carts.mjs         (report only)
 *   node scripts/check-paid-abandoned-carts.mjs --fix   (mark as recovered)
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const altPath = path.join(__dirname, '..', '.env');
  const p = fs.existsSync(envPath) ? envPath : fs.existsSync(altPath) ? altPath : null;
  if (!p) return {};
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}

const FIX = process.argv.includes('--fix');
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

function normPhone(p) {
  return (p || '').toString().replace(/\D+/g, '').replace(/^0+/, '');
}

async function main() {
  console.log('=== Abandoned Carts vs. Paid Orders Check ===');
  console.log(`Mode: ${FIX ? 'FIX (will mark matches as recovered)' : 'REPORT ONLY'}\n`);

  const { data: carts, error: cartsErr } = await supabase
    .from('abandoned_carts')
    .select('id, email, phone, first_name, last_name, cart_total, created_at, reminder_sent, recovered, recovered_at')
    .eq('recovered', false)
    .order('created_at', { ascending: false });

  if (cartsErr) {
    console.error('Failed to load abandoned_carts:', cartsErr.message);
    process.exit(1);
  }

  if (!carts || carts.length === 0) {
    console.log('No un-recovered abandoned carts found.');
    return;
  }

  console.log(`Loaded ${carts.length} un-recovered abandoned carts.\n`);

  const matches = [];
  const noMatch = [];

  for (const cart of carts) {
    const phone = cart.phone || '';
    const email = cart.email || '';
    const phoneDigits = normPhone(phone);
    const phoneLast9 = phoneDigits.slice(-9);
    const emailLc = norm(email);

    const orFilters = [];
    if (phone) orFilters.push(`phone.eq.${phone}`);
    if (phoneLast9) orFilters.push(`phone.ilike.%${phoneLast9}`);
    if (email) orFilters.push(`email.eq.${email}`);

    if (orFilters.length === 0) {
      noMatch.push({ cart, reason: 'no phone/email on cart' });
      continue;
    }

    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('id, order_number, phone, email, payment_status, status, total, created_at')
      .or(orFilters.join(','))
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: false })
      .limit(5);

    if (ordersErr) {
      console.error(`  Query failed for cart ${cart.id}:`, ordersErr.message);
      continue;
    }

    const paid = (orders || []).filter((o) => {
      const oPhone = normPhone(o.phone);
      const oEmail = norm(o.email);
      const phoneMatch = phoneDigits && oPhone && (oPhone === phoneDigits || oPhone.endsWith(phoneLast9) || phoneDigits.endsWith(oPhone.slice(-9)));
      const emailMatch = emailLc && oEmail && oEmail === emailLc;
      return phoneMatch || emailMatch;
    });

    if (paid.length > 0) {
      matches.push({ cart, paidOrders: paid });
    } else {
      noMatch.push({ cart, reason: 'no paid order found' });
    }
  }

  console.log(`\n--- RESULTS ---`);
  console.log(`Genuinely paid (still in abandoned_carts): ${matches.length}`);
  console.log(`Still unpaid / no match:                   ${noMatch.length}\n`);

  if (matches.length > 0) {
    console.log('=== Abandoned carts that have GENUINELY PAID ===\n');
    for (const { cart, paidOrders } of matches) {
      const name = `${cart.first_name || ''} ${cart.last_name || ''}`.trim() || '(no name)';
      console.log(`• Cart ${cart.id}`);
      console.log(`  Customer: ${name}`);
      console.log(`  Phone:    ${cart.phone || '-'}`);
      console.log(`  Email:    ${cart.email || '-'}`);
      console.log(`  Cart total: GH₵${Number(cart.cart_total || 0).toFixed(2)}`);
      console.log(`  Created:    ${cart.created_at}`);
      console.log(`  Reminder sent: ${cart.reminder_sent ? 'yes' : 'no'}`);
      console.log(`  Matched paid orders:`);
      for (const o of paidOrders) {
        console.log(`    - ${o.order_number || o.id}  GH₵${Number(o.total || 0).toFixed(2)}  ${o.status}/${o.payment_status}  ${o.created_at}`);
      }
      console.log('');
    }
  }

  if (FIX && matches.length > 0) {
    console.log(`--- Marking ${matches.length} carts as recovered ---`);
    let ok = 0;
    let fail = 0;
    for (const { cart } of matches) {
      const { error } = await supabase
        .from('abandoned_carts')
        .update({ recovered: true, recovered_at: new Date().toISOString() })
        .eq('id', cart.id);
      if (error) {
        fail++;
        console.log(`  FAIL ${cart.id}: ${error.message}`);
      } else {
        ok++;
      }
    }
    console.log(`\nUpdated: ${ok}   Failed: ${fail}`);
  } else if (matches.length > 0) {
    console.log('Re-run with --fix to mark these as recovered.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
