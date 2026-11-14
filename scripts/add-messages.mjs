#!/usr/bin/env node
// Adds or updates interface messages in both built-in language packs.
// Usage: node scripts/add-messages.mjs messages.json
// messages.json: { "message.id": { "zh-CN": "…", "en": "…" }, … }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const locale of ['zh-CN', 'en']) {
  const file = path.join(root, 'resources', 'localization', 'packs', `${locale}.json`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [id, values] of Object.entries(input)) {
    if (typeof values[locale] !== 'string' || !values[locale].trim()) throw new Error(`${id} is missing ${locale}`);
    pack.messages[id] = values[locale];
  }
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + '\n');
}
console.log(`Updated ${Object.keys(input).length} messages.`);
