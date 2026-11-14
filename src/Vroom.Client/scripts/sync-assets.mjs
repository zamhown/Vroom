import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(client, 'dist');
const targets = [resolve(client, '../Vroom.App/Resources/Raw/wwwroot'), resolve(client, '../Vroom.Web/wwwroot')];
for (const target of targets) {
  await mkdir(target, { recursive: true });
  // Only generated assets within these exact build destinations are replaced.
  for (const entry of await readdir(target)) {
    const candidate = resolve(target, entry);
    if (relative(target, candidate).startsWith('..' + sep)) throw new Error('Invalid output path');
    await rm(candidate, { recursive: true, force: true });
  }
  await cp(source, target, { recursive: true });
}
console.log('React assets synchronized to MAUI and local web host.');
