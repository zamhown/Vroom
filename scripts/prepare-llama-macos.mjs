#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareNativeLibraries } from './lib/macho.mjs';

const [packageDirectory, output] = process.argv.slice(2);
if (process.platform !== 'darwin' || !packageDirectory || !output || process.argv.length !== 4)
  throw new Error('Usage on macOS: prepare-llama-macos.mjs <NuGet package directory> <intermediate directory>');
for (const architecture of ['arm64', 'x64']) {
  const source = path.join(packageDirectory, `runtimes/osx-${architecture}/native`);
  const destination = path.join(output, architecture);
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  hash.update(fs.readFileSync(new URL('./lib/macho.mjs', import.meta.url)));
  const names = fs
    .readdirSync(source)
    .filter(name => fs.statSync(path.join(source, name)).isFile())
    .sort();
  for (const name of names) hash.update(name).update(fs.readFileSync(path.join(source, name)));
  const stamp = path.join(output, `${architecture}.sha256`);
  const digest = hash.digest('hex');
  if (
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, 'utf8') === digest &&
    names.every(name => fs.existsSync(path.join(destination, name)))
  )
    continue;
  prepareNativeLibraries(source, destination);
  fs.writeFileSync(stamp, digest);
}
