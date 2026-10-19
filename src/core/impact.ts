import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_PROJECT_DIRECTORIES, isSupportedSourceMajor } from './project-discovery.js';
import { runMigration } from './runner.js';
import { npmLatestVersion } from './watch.js';
import { migrations } from '../migrations/index.js';
import { parseManifest } from './manifest.js';

export interface ImpactItem {
  package: string;
  declaredVersion: string;
  latestVersion: string;
  latestMajor: number;
  migration?: string;
  affected: number;
  automatic: number;
  manual: number;
  automaticShare: number | null;
  note?: string;
}

async function declaredVersions(root: string): Promise<{ found: Map<string, Set<string>>; warnings: string[] }> {
  const found = new Map<string, Set<string>>();
  const warnings: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(absolute);
      if (entry.isFile() && entry.name === 'package.json') {
        let manifest: Record<string, Record<string, string>>;
        try { manifest = parseManifest<Record<string, Record<string, string>>>(await readFile(absolute, 'utf8')); }
        catch { warnings.push(`Invalid manifest: ${path.relative(root, absolute)}`); continue; }
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          for (const [name, version] of Object.entries(manifest[section] ?? {})) {
            if (typeof version !== 'string') continue;
            const versions = found.get(name) ?? new Set<string>();
            versions.add(version);
            found.set(name, versions);
          }
        }
      }
    }
  }
  await visit(root);
  return { found, warnings };
}

export async function analyzeImpact(cwd: string, lookup: (packageName: string) => Promise<string> = npmLatestVersion): Promise<ImpactItem[]> {
  const { found: versions, warnings } = await declaredVersions(path.resolve(cwd));
  const packages = [...new Set(migrations.map((migration) => migration.packageName))].filter((name) => versions.has(name)).sort();
  const results: ImpactItem[] = [];
  for (const packageName of packages) {
    const declared = [...versions.get(packageName)!].sort();
    const declaredVersion = declared.join(', ');
    const latestVersion = await lookup(packageName);
    if (!/^\d+\.\d+\.\d+/.test(latestVersion)) throw new Error(`Invalid registry version for ${packageName}.`);
    const latestMajor = Number(latestVersion.split('.')[0]);
    if (declared.length > 1) {
      results.push({ package: packageName, declaredVersion, latestVersion, latestMajor, affected: 0, automatic: 0, manual: 0, automaticShare: null,
        note: `Multiple declared versions need separate review; no migration rate was inferred. ${warnings.join('; ')}` });
      continue;
    }
    const migration = migrations.find((candidate) => candidate.packageName === packageName && isSupportedSourceMajor(declared[0]!, candidate.fromMajor));
    if (!migration) {
      results.push({ package: packageName, declaredVersion, latestVersion, latestMajor, affected: 0, automatic: 0, manual: 0, automaticShare: null, note: `No catalog migration matches this declared version; affected usages are unknown. ${warnings.join('; ')}`.trim() });
      continue;
    }
    const outcome = await runMigration(migration, { cwd, dryRun: true, analysisOnly: true });
    const automatic = outcome.changes.length;
    const manual = outcome.manual.length;
    const affected = automatic + manual;
    results.push({ package: packageName, declaredVersion, latestVersion, latestMajor, migration: migration.id, affected, automatic, manual, automaticShare: affected ? automatic / affected : null, ...(warnings.length ? { note: warnings.join('; ') } : {}) });
  }
  return results;
}
