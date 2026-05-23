import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const altPath = path.join(__dirname, '..', '.env');
  const p = fs.existsSync(envPath) ? envPath : fs.existsSync(altPath) ? altPath : null;
  if (!p) return {};
  const obj = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (m) obj[m[1]] = m[2];
  }
  return obj;
}
const env = { ...process.env, ...loadEnv() };
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

async function main() {
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, slug')
    .eq('status', 'active');

  if (error) { console.error(error); process.exit(1); }

  const bad = products.filter(p => !p.slug || p.slug.length <= 2);
  console.log(`Found ${bad.length} products with broken slugs out of ${products.length} total\n`);

  if (bad.length === 0) { console.log('Nothing to fix!'); return; }

  const allSlugs = new Set(products.map(p => p.slug));

  for (const p of bad) {
    let newSlug = toSlug(p.name);
    let counter = 2;
    while (allSlugs.has(newSlug)) {
      newSlug = `${toSlug(p.name)}-${counter++}`;
    }
    allSlugs.add(newSlug);

    console.log(`  "${p.name}" : "${p.slug}" → "${newSlug}"`);
    const { error: updateErr } = await supabase
      .from('products')
      .update({ slug: newSlug })
      .eq('id', p.id);

    if (updateErr) console.error(`    ERROR: ${updateErr.message}`);
    else console.log(`    ✓ fixed`);
  }

  console.log('\nDone!');
}

main();
