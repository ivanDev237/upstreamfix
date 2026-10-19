import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_PROJECT_DIRECTORIES, isSupportedSourceMajor } from './project-discovery.js';
import { runMigration } from './runner.js';
import { npmLatestVersion } from './watch.js';
import { migrations } from '../migrations/index.js';

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

async function declaredVersions(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(absolute);
      if (entry.isFile() && entry.name === 'package.json') {
        const manifest = JSON.parse(await readFile(absolute, 'utf8')) as Record<string, Record<string, string>>;
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          for (const [name, version] of Object.entries(manifest[section] ?? {})) {
            if (!found.has(name)) found.set(name, version);
          }
        }
      }
    }
  }
  await visit(root);
  return found;
}

export async function analyzeImpact(cwd: string, lookup: (packageName: string) => Promise<string> = npmLatestVersion): Promise<ImpactItem[]> {
  const versions = await declaredVersions(path.resolve(cwd));
  const packages = [...new Set(migrations.map((migration) => migration.packageName))].filter((name) => versions.has(name)).sort();
  const results: ImpactItem[] = [];
  for (const packageName of packages) {
    const declaredVersion = versions.get(packageName)!;
    const latestVersion = await lookup(packageName);
    if (!/^\d+\.\d+\.\d+/.test(latestVersion)) throw new Error(`Invalid registry version for ${packageName}.`);
    const latestMajor = Number(latestVersion.split('.')[0]);
    const migration = migrations.find((candidate) => candidate.packageName === packageName && isSupportedSourceMajor(declaredVersion, candidate.fromMajor));
    if (!migration) {
      results.push({ package: packageName, declaredVersion, latestVersion, latestMajor, affected: 0, automatic: 0, manual: 0, automaticShare: null, note: 'No catalog migration matches this declared version; affected usages are unknown.' });
      continue;
    }
    const outcome = await runMigration(migration, { cwd, dryRun: true, analysisOnly: true });
    const automatic = outcome.changes.length;
    const manual = outcome.manual.length;
    const affected = automatic + manual;
    results.push({ package: packageName, declaredVersion, latestVersion, latestMajor, migration: migration.id, affected, automatic, manual, automaticShare: affected ? automatic / affected : null });
  }
  return results;
}
