import fs from 'node:fs';
import path from 'node:path';

// Use PATH and standard Windows locations, without hardcoded editor-specific paths.
export function resolvePowerShell(env = process.env) {
  const entries = Object.entries(env);
  const value = key => entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const candidates = (value('PATH') ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'));
  for (const key of ['ProgramW6432', 'ProgramFiles']) {
    if (value(key)) candidates.push(path.join(value(key), 'PowerShell/7/pwsh.exe'));
  }
  if (value('SystemRoot')) {
    candidates.push(path.join(value('SystemRoot'), 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  }
  const executable = candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!executable)
    throw new Error('No PowerShell installation found. Restore Windows PowerShell or install PowerShell 7.');
  return executable;
}

// This policy applies to the child process only; no machine or user setting is changed.
export function powershellArguments(script, args = []) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
}

export function powershellEnvironment(env = process.env) {
  // Let each shell build its own default module paths; inherited PowerShell 7 modules can break 5.1.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}
