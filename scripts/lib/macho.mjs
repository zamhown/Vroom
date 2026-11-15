import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const systemLibrary = value =>
  value.startsWith('/System/Library/') || value.startsWith('/System/iOSSupport/') || value.startsWith('/usr/lib/');
export function linkedLibraries(output) {
  return [
    ...new Set(
      output
        .split('\n')
        .slice(1)
        .map(line => /^\s+(.+?) \(compatibility version /.exec(line)?.[1])
        .filter(Boolean),
    ),
  ];
}
export function rpaths(output) {
  return [...output.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
}
export function newerVersion(left, right) {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? left : right;
  }
  return left;
}
export function minimumMacOS(output) {
  const versions = [
    ...output.matchAll(/cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform (?:1|MACOS)\s+minos ([\d.]+)/g),
  ].map(match => match[1]);
  versions.push(
    ...[...output.matchAll(/cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)/g)].map(match => match[1]),
  );
  return versions.reduce(newerVersion, '14.0');
}
const execute = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const macho = file => {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (fs.readSync(fd, bytes, 0, 4, 0) !== 4) return false;
    return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(bytes.readUInt32BE());
  } finally {
    fs.closeSync(fd);
  }
};

/** Relocate an upstream package whose dylibs are shipped as a sibling set.
 * LLamaSharp's macOS assets retain CI-only rpaths. Rewrite copies, never NuGet's cache. */
export function prepareNativeLibraries(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source).filter(name => fs.statSync(path.join(source, name)).isFile())) {
    const input = path.join(source, name);
    const output = path.join(destination, name);
    fs.copyFileSync(input, output);
    fs.chmodSync(output, 0o755);
    if (!macho(output)) continue;
    for (const dependency of linkedLibraries(execute('/usr/bin/otool', ['-L', input]))) {
      if (systemLibrary(dependency)) continue;
      const sibling = path.basename(dependency);
      if (!dependency.startsWith('@rpath/') || !fs.existsSync(path.join(source, sibling)))
        throw new Error(`Unsupported native package dependency: ${input} -> ${dependency}`);
      if (sibling !== name)
        execute('/usr/bin/install_name_tool', ['-change', dependency, '@loader_path/' + sibling, output]);
    }
    for (const value of new Set(rpaths(execute('/usr/bin/otool', ['-l', input]))))
      execute('/usr/bin/install_name_tool', ['-delete_rpath', value, output]);
    execute('/usr/bin/install_name_tool', ['-id', '@rpath/' + name, output]);
    execute('/usr/bin/codesign', ['--force', '--sign', '-', output]);
  }
}

/** Copy a complete Mach-O dependency graph and rewrite it relative to its new location.
 * Never mutate installed Homebrew libraries. Missing/foreign-architecture edges fail publication. */
export function bundleMachO(destination, architecture) {
  const libraries = path.join(destination, 'lib');
  fs.mkdirSync(libraries, { recursive: true });
  const copied = new Map();
  const records = [];
  const expand = (value, source, executable) =>
    value
      .replace(/^@loader_path(?=\/|$)/, path.dirname(source))
      .replace(/^@executable_path(?=\/|$)/, path.dirname(executable));
  function copy(input, output, executable = input, inherited = []) {
    const source = fs.realpathSync(input);
    if (copied.has(source)) return copied.get(source);
    output ??= path.join(
      libraries,
      createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12) + '-' + path.basename(source),
    );
    execute('/usr/bin/lipo', ['-verify_arch', architecture, source]);
    copied.set(source, output); // Cyclic dylib dependencies are legal.
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(source, output);
    fs.chmodSync(output, 0o755);
    const paths = rpaths(execute('/usr/bin/otool', ['-l', source]));
    const search = [...paths.map(value => expand(value, source, executable)), ...inherited];
    for (const dependency of linkedLibraries(execute('/usr/bin/otool', ['-L', source]))) {
      if (systemLibrary(dependency)) continue;
      const candidates = dependency.startsWith('@rpath/')
        ? search.map(directory => path.join(directory, dependency.slice(7)))
        : [expand(dependency, source, executable)];
      const resolved = candidates.find(value => path.isAbsolute(value) && fs.existsSync(value));
      if (!resolved) throw new Error(`Unresolved native dependency: ${source} -> ${dependency}`);
      if (fs.realpathSync(resolved) === source) continue; // LC_ID_DYLIB is included by otool -L.
      const bundled = copy(resolved, undefined, executable, search);
      execute('/usr/bin/install_name_tool', [
        '-change',
        dependency,
        '@loader_path/' + path.relative(path.dirname(output), bundled),
        output,
      ]);
    }
    if (output.endsWith('.dylib'))
      execute('/usr/bin/install_name_tool', ['-id', '@rpath/' + path.basename(output), output]);
    for (const value of new Set(paths)) execute('/usr/bin/install_name_tool', ['-delete_rpath', value, output]);
    execute('/usr/bin/codesign', ['--force', '--sign', '-', output]);
    const recipe = /^(.*\/Cellar\/[^/]+\/[^/]+)\//.exec(source)?.[1];
    if (recipe) {
      const legal = path.join(
        destination,
        'licenses',
        path.basename(path.dirname(recipe)) + '-' + path.basename(recipe),
      );
      fs.mkdirSync(legal, { recursive: true });
      for (const name of fs.readdirSync(recipe))
        if (/^(?:LICENSE|COPYING|NOTICE|AUTHORS|INSTALL_RECEIPT|\.brew)/i.test(name))
          fs.cpSync(path.join(recipe, name), path.join(legal, name), { recursive: true, dereference: true });
    }
    records.push({
      file: path.relative(destination, output),
      source,
      sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    });
    return output;
  }
  return { copy, records };
}

export function auditMachO(directory, boundary = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(file);
      if (path.relative(boundary, real).startsWith('..')) throw new Error(`External package symlink: ${file}`);
    } else if (entry.isDirectory()) files.push(...auditMachO(file, boundary));
    else if (macho(file)) {
      for (const dependency of linkedLibraries(execute('/usr/bin/otool', ['-L', file])))
        if (dependency.startsWith('/') && !systemLibrary(dependency))
          throw new Error(`Nonportable dependency: ${file} -> ${dependency}`);
      for (const value of rpaths(execute('/usr/bin/otool', ['-l', file])))
        if (value.startsWith('/') && !systemLibrary(value)) throw new Error(`Nonportable rpath: ${file} -> ${value}`);
      files.push(file);
    }
  }
  return files;
}
