import fs from 'node:fs';
import path from 'node:path';

// Some SDKs write localized NuGet diagnostics before the machine-readable payload.
// Parse a complete JSON line rather than depending on the CLI display language.
export function installedWorkloads(output) {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value.installed) && value.installed.every(id => typeof id === 'string')) return value.installed;
    } catch {
      // Keep looking for the structured result, never infer success from prose.
    }
  }
  throw new Error('The .NET SDK did not return a valid workload inventory.');
}

export function dotnetEnvironment(root, environment = process.env) {
  const local = path.join(root, '.artifacts/dotnet');
  const executable = path.join(local, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  return fs.existsSync(executable)
    ? { ...environment, DOTNET_ROOT: local, PATH: local + path.delimiter + (environment.PATH ?? '') }
    : { ...environment };
}
