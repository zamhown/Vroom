#!/usr/bin/env node
// Runs a real browser against an isolated local fixture. No external website, personal
// browser profile, catalog, or system/parent proxy configuration is changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, '.artifacts/source-browser-check-'));
const args = [
  'test',
  path.join(root, 'tests/Vroom.Tests/Vroom.Tests.csproj'),
  '--filter',
  'FullyQualifiedName~SourceBrowserIntegrationTests',
  '--logger',
  'trx;LogFileName=browser.trx',
  '--results-directory',
  output,
  '--verbosity',
  'quiet',
];
const code = await new Promise((resolve, reject) => {
  const child = spawn('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('close', resolve);
});
const trx = await fs.readFile(path.join(output, 'browser.trx'), 'utf8');
const attributes = /<Counters\b([^>]+)>/.exec(trx)?.[1] ?? '';
const count = name => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(attributes)?.[1] ?? NaN);
const passed = code === 0 && count('total') > 0 && count('passed') === count('total') && count('notExecuted') === 0;
const report = {
  passed,
  platform: process.platform,
  architecture: process.arch,
  realBrowserExecuted: passed,
  tests: count('total'),
  report: path.join(output, 'browser.trx'),
  nativeAppIntegration: 'requires desktop app verification',
};
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!passed) {
  console.error(
    'Browser verification did not pass. Install Chrome or Edge; skipped tests do not verify browser support.',
  );
  process.exitCode = 1;
}
