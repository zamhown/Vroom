import { client, flags, formatRepository, node, requireDependencies, run } from './lib/process.mjs';
flags([]);
requireDependencies();
run('dotnet', ['tool', 'restore']);
run('dotnet', ['csharpier', 'format', '.']);
formatRepository(true);
run(node, ['scripts/sync-branding.mjs']);
run('npm', ['run', 'format'], { cwd: client });
