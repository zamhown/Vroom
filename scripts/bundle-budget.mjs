#!/usr/bin/env node
// Fails when the client's start-up bundle grows past its budget. Workers (Monaco language services,
// FFmpeg/HLS helpers) load on demand and are reported but not budgeted.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'src', 'Vroom.Client', 'dist', 'assets');
const budgets = { 'index-': 2_300_000, 'spectrum-styles-': 700_000 };
if (!fs.existsSync(assets)) {
  console.error('Build the client first: npm --prefix src/Vroom.Client run build');
  process.exit(1);
}
let failed = false;
for (const file of fs.readdirSync(assets).filter(f => /\.(js|css)$/.test(f))) {
  const bytes = fs.statSync(path.join(assets, file)).size;
  const prefix = Object.keys(budgets).find(p => file.startsWith(p));
  const gzip = zlib.gzipSync(fs.readFileSync(path.join(assets, file))).length;
  if (prefix && bytes > budgets[prefix]) {
    console.error(`${file}: ${bytes} bytes exceeds the ${budgets[prefix]} byte budget`);
    failed = true;
  } else if (prefix) console.log(`${file}: ${bytes} bytes (${gzip} gzip) within budget`);
}
process.exit(failed ? 1 : 0);
