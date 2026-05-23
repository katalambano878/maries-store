#!/usr/bin/env node
/**
 * Compress images in public/ folder for faster load times.
 * - Converts JPG/PNG to optimized WebP (keeping originals as fallback)
 * - Also re-compresses the original JPG/PNG in-place
 * - Uses a temp-file strategy to avoid Windows file-locking issues
 * Run: npm run compress-images
 */
import { readdir, stat, readFile, writeFile, rename, unlink, copyFile } from 'fs/promises';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const QUALITY = { jpeg: 78, webp: 80, png: 80, avif: 60 };
const MAX_WIDTH = 1920;

async function compressImages() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('Run: npm install sharp');
    process.exit(1);
  }

  let totalOriginal = 0;
  let totalNew = 0;
  let count = 0;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) {
        await walk(full);
      } else if (e.isFile() && EXTENSIONS.includes(extname(e.name).toLowerCase())) {
        await compress(full, sharp);
      }
    }
  }

  async function compress(filePath, sharpLib) {
    try {
      const ext = extname(filePath).toLowerCase();
      const name = basename(filePath, ext);
      const dir = dirname(filePath);
      const origSize = (await stat(filePath)).size;

      // Read file into memory to avoid lock issues
      const inputBuffer = await readFile(filePath);
      const image = sharpLib(inputBuffer);
      const metadata = await image.metadata();

      // Resize if wider than MAX_WIDTH
      const needsResize = metadata.width && metadata.width > MAX_WIDTH;
      const pipeline = needsResize
        ? sharpLib(inputBuffer).resize({ width: MAX_WIDTH, withoutEnlargement: true }).rotate()
        : sharpLib(inputBuffer).rotate();

      // Re-compress original format in-place
      let compressedBuffer;
      if (ext === '.png') {
        compressedBuffer = await pipeline.clone().png({ quality: QUALITY.png, compressionLevel: 9, palette: true }).toBuffer();
      } else {
        compressedBuffer = await pipeline.clone().jpeg({ quality: QUALITY.jpeg, mozjpeg: true }).toBuffer();
      }

      // Only write if actually smaller
      if (compressedBuffer.length < origSize) {
        const tmpPath = filePath + '.tmp';
        await writeFile(tmpPath, compressedBuffer);
        try { await unlink(filePath); } catch { /* ignore */ }
        await rename(tmpPath, filePath);

        totalOriginal += origSize;
        totalNew += compressedBuffer.length;
        count++;
        const saved = ((1 - compressedBuffer.length / origSize) * 100).toFixed(1);
        console.log(`  ${filePath.replace(PUBLIC, 'public')}: ${fmt(origSize)} → ${fmt(compressedBuffer.length)} (${saved}% smaller)`);
      } else {
        console.log(`  ${filePath.replace(PUBLIC, 'public')}: already optimized (${fmt(origSize)})`);
      }

      // Also generate WebP version if it doesn't exist or is outdated
      const webpPath = join(dir, name + '.webp');
      const webpBuffer = await pipeline.clone().webp({ quality: QUALITY.webp }).toBuffer();
      if (!existsSync(webpPath) || webpBuffer.length < (await stat(webpPath).catch(() => ({ size: Infinity }))).size) {
        await writeFile(webpPath, webpBuffer);
        console.log(`  → ${webpPath.replace(PUBLIC, 'public')}: ${fmt(webpBuffer.length)} (WebP)`);
      }
    } catch (err) {
      console.warn(`  SKIP ${filePath.replace(PUBLIC, 'public')}: ${err.message}`);
    }
  }

  function fmt(bytes) {
    return (bytes / 1024).toFixed(1) + 'KB';
  }

  console.log('Compressing images in public/...\n');
  await walk(PUBLIC);

  console.log(`\n--- Summary ---`);
  console.log(`Files compressed: ${count}`);
  if (count > 0) {
    console.log(`Total: ${fmt(totalOriginal)} → ${fmt(totalNew)} (${((1 - totalNew / totalOriginal) * 100).toFixed(1)}% saved)`);
  }
  console.log('Done.');
}

compressImages().catch((e) => {
  console.error(e);
  process.exit(1);
});
