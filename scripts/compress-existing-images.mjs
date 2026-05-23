import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env
const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) return;
  env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
});

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE env vars');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET = 'products';
const MAX_WIDTH = 1200;
const QUALITY = 80;

async function run() {
  // Get all product image URLs
  const { data: images, error } = await supabase
    .from('product_images')
    .select('id, url')
    .order('id');

  if (error) { console.error('DB error:', error); process.exit(1); }

  console.log(`Found ${images.length} images to process\n`);

  let compressed = 0;
  let skipped = 0;
  let failed = 0;
  let totalSaved = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const url = img.url;

    // Already compressed (webp from our script)
    if (url.includes('-compressed.webp')) {
      skipped++;
      continue;
    }

    try {
      // Download original image
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  [${i + 1}/${images.length}] SKIP - HTTP ${res.status}: ${url.split('/').pop()}`);
        skipped++;
        continue;
      }

      const originalBuffer = Buffer.from(await res.arrayBuffer());
      const originalSize = originalBuffer.length;

      // Skip tiny images (already small)
      if (originalSize < 50000) { // < 50KB
        console.log(`  [${i + 1}/${images.length}] SKIP - already small (${(originalSize / 1024).toFixed(0)}KB)`);
        skipped++;
        continue;
      }

      // Compress with sharp
      const compressedBuffer = await sharp(originalBuffer)
        .resize(MAX_WIDTH, null, { withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: QUALITY })
        .toBuffer();

      const newSize = compressedBuffer.length;
      const savings = originalSize - newSize;
      const pctSaved = ((savings / originalSize) * 100).toFixed(0);

      // Only replace if we actually saved space
      if (newSize >= originalSize) {
        console.log(`  [${i + 1}/${images.length}] SKIP - compression didn't help`);
        skipped++;
        continue;
      }

      // Upload compressed version with new name
      const oldFileName = url.split('/').pop();
      const baseName = oldFileName.replace(/\.[^.]+$/, '');
      const newFileName = `${baseName}-compressed.webp`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(newFileName, compressedBuffer, {
          contentType: 'image/webp',
          upsert: true,
        });

      if (uploadError) {
        console.log(`  [${i + 1}/${images.length}] UPLOAD FAIL: ${uploadError.message}`);
        failed++;
        continue;
      }

      // Get new public URL
      const { data: { publicUrl } } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(newFileName);

      // Update database record
      const { error: updateError } = await supabase
        .from('product_images')
        .update({ url: publicUrl })
        .eq('id', img.id);

      if (updateError) {
        console.log(`  [${i + 1}/${images.length}] DB UPDATE FAIL: ${updateError.message}`);
        failed++;
        continue;
      }

      totalSaved += savings;
      compressed++;
      console.log(`  [${i + 1}/${images.length}] OK  ${(originalSize / 1024).toFixed(0)}KB -> ${(newSize / 1024).toFixed(0)}KB  (-${pctSaved}%)  ${oldFileName}`);

    } catch (err) {
      console.log(`  [${i + 1}/${images.length}] ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log('\n========== DONE ==========');
  console.log(`Compressed: ${compressed}`);
  console.log(`Skipped:    ${skipped}`);
  console.log(`Failed:     ${failed}`);
  console.log(`Total saved: ${(totalSaved / 1024 / 1024).toFixed(1)} MB`);
}

run().catch(console.error);
