import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')]; })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  // 1. Create "Hair Extensions" category if it doesn't exist
  let { data: existing } = await sb.from('categories').select('id').eq('slug', 'hair-extensions').single();

  let catId;
  if (existing) {
    catId = existing.id;
    console.log('Category "Hair Extensions" already exists:', catId);
  } else {
    const { data: cat, error } = await sb.from('categories').insert({
      name: 'Hair Extensions',
      slug: 'hair-extensions',
      status: 'active',
    }).select('id').single();
    if (error) { console.error('Failed to create category:', error); return; }
    catId = cat.id;
    console.log('Created category "Hair Extensions":', catId);
  }

  // 2. Fix broken slugs for existing products
  const slugFixes = [
    { oldSlug: 'd', newSlug: 'wig-rosie', name: 'Wig Rosie' },
    { oldSlug: 'w', newSlug: 'wig-princess-frontal-blonde', name: 'Wig Princess Frontal Blonde' },
  ];
  for (const fix of slugFixes) {
    const { error } = await sb.from('products')
      .update({ slug: fix.newSlug, category_id: catId })
      .eq('slug', fix.oldSlug);
    if (error) console.error(`Failed to fix slug ${fix.oldSlug}:`, error);
    else console.log(`Fixed slug: "${fix.oldSlug}" -> "${fix.newSlug}" + moved to Hair Extensions`);
  }

  // 3. Move existing wig products to Hair Extensions category
  const moveToCategory = ['wig-baby-bounce', 'deep-wave-curls-closure'];
  for (const slug of moveToCategory) {
    const { error } = await sb.from('products').update({ category_id: catId }).eq('slug', slug);
    if (error) console.error(`Failed to move ${slug}:`, error);
    else console.log(`Moved "${slug}" to Hair Extensions category`);
  }

  // 4. Define new products to create
  const newProducts = [
    {
      name: 'Wig Maya',
      slug: 'wig-maya',
      quantity: 11,
      price: 0,
      variants: [
        { name: 'Black', option1: 'Black', quantity: 1, price: 0 },
        { name: 'Blonde', option1: 'Blonde', quantity: 7, price: 0 },
        { name: 'Burgundy', option1: 'Burgundy', quantity: 3, price: 0 },
      ],
    },
    {
      name: 'Wig Mini Bounce',
      slug: 'wig-mini-bounce',
      quantity: 4,
      price: 0,
      variants: [],
    },
    {
      name: 'Wig Sassy',
      slug: 'wig-sassy',
      quantity: 1,
      price: 0,
      variants: [],
    },
    {
      name: 'Wig Abena Pixie',
      slug: 'wig-abena-pixie',
      quantity: 5,
      price: 0,
      variants: [],
    },
    {
      name: '10 Inches Bob Wig',
      slug: '10-inches-bob-wig',
      quantity: 2,
      price: 0,
      variants: [],
    },
    {
      name: '14 Inches Bob Wig',
      slug: '14-inches-bob-wig',
      quantity: 1,
      price: 0,
      variants: [],
    },
    {
      name: 'Pixie Frontal Wig',
      slug: 'pixie-frontal-wig',
      quantity: 9,
      price: 0,
      variants: [],
    },
    {
      name: 'Pixie Closure Wig',
      slug: 'pixie-closure-wig',
      quantity: 5,
      price: 0,
      variants: [],
    },
    {
      name: 'Tuneful Curls Wig',
      slug: 'tuneful-curls-wig',
      quantity: 2,
      price: 0,
      variants: [],
    },
    {
      name: 'Bodywave Wig Frontal',
      slug: 'bodywave-wig-frontal',
      quantity: 11,
      price: 0,
      variants: [
        { name: '20 inches', option1: '20 inches', quantity: 2, price: 0 },
        { name: '22 inches', option1: '22 inches', quantity: 3, price: 0 },
        { name: '24 inches', option1: '24 inches', quantity: 5, price: 0 },
        { name: '30 inches', option1: '30 inches', quantity: 1, price: 0 },
      ],
    },
    {
      name: 'Body Wave Closure Wig',
      slug: 'body-wave-closure-wig',
      quantity: 3,
      price: 0,
      variants: [
        { name: '20 inches', option1: '20 inches', quantity: 1, price: 0 },
        { name: '26 inches', option1: '26 inches', quantity: 2, price: 0 },
      ],
    },
  ];

  let created = 0, skipped = 0;
  for (const prod of newProducts) {
    const { data: dup } = await sb.from('products').select('id').eq('slug', prod.slug).single();
    if (dup) {
      console.log(`SKIP (already exists): ${prod.name} [${prod.slug}]`);
      skipped++;
      continue;
    }

    const { data: inserted, error } = await sb.from('products').insert({
      name: prod.name,
      slug: prod.slug,
      quantity: prod.quantity,
      price: prod.price,
      category_id: catId,
      status: 'active',
    }).select('id').single();

    if (error) {
      console.error(`FAIL creating ${prod.name}:`, error);
      continue;
    }

    console.log(`CREATED: ${prod.name} [${prod.slug}] qty=${prod.quantity}`);

    if (prod.variants.length > 0) {
      const variantsToInsert = prod.variants.map(v => ({
        product_id: inserted.id,
        name: v.name,
        option1: v.option1,
        quantity: v.quantity,
        price: v.price,
      }));
      const { error: vErr } = await sb.from('product_variants').insert(variantsToInsert);
      if (vErr) console.error(`  FAIL variants for ${prod.name}:`, vErr);
      else console.log(`  + ${prod.variants.length} variants added`);
    }
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped`);
}

main().catch(console.error);
