import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root } from './lib/process.mjs';

export function inspectRepository(directory) {
  // Include tracked files even if ignored, and new source files before the first commit.
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: directory,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ];
  const problems = [];
  const forbiddenPath =
    /(^|\/)(?:node_modules|bin|obj|dist|runtime|artifacts|\.artifacts|\.vs|\.idea|TestResults|coverage|wwwroot)(\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:db(?:-.*)?|sqlite3?(?:-.*)?|gguf|pfx|p12|pem|key|snk|log|mp4|mkv|mov|zip|7z|exe|dll)$/i;
  const oldBrand = /g[r]ingotts/i;
  const secret =
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/;
  for (const name of files) {
    const full = path.join(directory, name);
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) {
      problems.push(`${name}: symbolic links are not allowed in the public source tree`);
      continue;
    }
    if (forbiddenPath.test(name)) problems.push(`${name}: local data, credentials or generated output`);
    if (fs.statSync(full).size > 10 * 1024 * 1024) {
      problems.push(`${name}: exceeds 10 MiB source limit`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    if (oldBrand.test(name)) problems.push(`${name}: obsolete brand in path`);
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    if (oldBrand.test(content)) problems.push(`${name}: obsolete brand in content`);
    if (secret.test(content)) problems.push(`${name}: possible private credential (value redacted)`);
  }
  return { files: files.length, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = inspectRepository(root);
  if (result.problems.length) {
    console.error(result.problems.join('\n'));
    process.exitCode = 1;
  } else console.log(`Repository hygiene passed (${result.files} source files).`);
}
