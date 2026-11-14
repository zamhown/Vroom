import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRepository } from './check-repository.mjs';

test('hygiene covers untracked source, tracked ignored data and credential content without printing secrets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom-repository-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    fs.writeFileSync(path.join(directory, '.gitignore'), 'runtime/\n');
    fs.mkdirSync(path.join(directory, 'runtime'));
    fs.writeFileSync(path.join(directory, 'runtime/catalog.db'), 'private catalog');
    fs.writeFileSync(path.join(directory, 'README.md'), '# Vroom\n');
    assert.deepEqual(inspectRepository(directory).problems, []);
    execFileSync('git', ['add', '-f', 'runtime/catalog.db'], { cwd: directory });
    assert.match(inspectRepository(directory).problems.join('\n'), /catalog\.db/);
    fs.writeFileSync(path.join(directory, 'new-source.ts'), `const name = '${['Grin', 'gotts'].join('')}';`);
    assert.match(inspectRepository(directory).problems.join('\n'), /new-source\.ts: obsolete brand/);
    const credential = ['ghp', 'a'.repeat(36)].join('_');
    fs.writeFileSync(path.join(directory, 'config.txt'), credential);
    const report = inspectRepository(directory).problems.join('\n');
    assert.match(report, /config\.txt: possible private credential/);
    assert(!report.includes(credential));
  } finally {
    // This exact directory is created by mkdtemp above, never a caller-supplied path.
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
