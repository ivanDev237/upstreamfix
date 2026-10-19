import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Migration, PackageManifest } from '../core/types.js';
import { IGNORED_PROJECT_DIRECTORIES, isSupportedSourceMajor } from '../core/project-discovery.js';
import { firebaseAdminV14 } from './firebase-admin-v14/index.js';
import { stripeV22 } from './stripe-v22/index.js';
import { stripeV23 } from './stripe-v23/index.js';
import { openaiV5 } from './openai-v5/index.js';

/** The shipped migration catalog. Adding a migration requires registering it here, not in core or the CLI. */
export const migrations: readonly Migration[] = [firebaseAdminV14, stripeV22, stripeV23, openaiV5];

export async function findApplicableMigrations(cwd: string, options: { includeExperimental?: boolean } = {}): Promise<Migration[]> {
  const manifests = await readManifests(path.resolve(cwd));
  return migrations.filter((migration) => (!migration.experimental || options.includeExperimental) && manifests.some((manifest) => {
    const sections = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies];
    return sections.some((section) => {
      const range = section?.[migration.packageName];
      return typeof range === 'string' && isSupportedSourceMajor(range, migration.fromMajor);
    });
  }));
}

async function readManifests(root: string): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && entry.name === 'package.json') {
        try {
          manifests.push(JSON.parse(await readFile(absolute, 'utf8')) as PackageManifest);
        } catch {
          // An invalid manifest cannot prove that a migration applies.
        }
      }
    }
  }
  await visit(root);
  return manifests;
}
