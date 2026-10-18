import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function generateMigrationScaffold(root: string, packageName: string, targetVersion: string): Promise<string> {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
    throw new Error(`Invalid npm package name: ${packageName}`);
  }
  const versionMatch = /^v?(\d+)(?:\.\d+\.\d+)?$/.exec(targetVersion);
  if (!versionMatch) throw new Error(`Invalid target major version: ${targetVersion}`);
  const toMajor = Number(versionMatch[1]);
  if (toMajor < 2) throw new Error('Target version must have a previous major version.');

  const slug = packageName.replace(/^@/, '').replaceAll('/', '-').replace(/[^A-Za-z0-9._-]+/g, '-');
  const directoryName = `${slug}-v${toMajor}`;
  const migrationDirectory = path.join(root, 'src', 'migrations', directoryName);
  const testDirectory = path.join(root, 'test', 'migrations');
  const migrationFile = path.join(migrationDirectory, 'index.ts');
  const mappingFile = path.join(migrationDirectory, 'mapping.ts');
  const unitTest = path.join(testDirectory, `${directoryName}.test.ts`);
  const realSdkTest = path.join(testDirectory, `${directoryName}.real-sdk.test.ts`);
  for (const file of [migrationFile, mappingFile, unitTest, realSdkTest]) {
    try {
      await readFile(file);
      throw new Error(`Refusing to overwrite existing file: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  await mkdir(migrationDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  const pkg = JSON.stringify(packageName);
  const id = JSON.stringify(`${packageName}@${toMajor}`);
  await Promise.all([
    writeFile(migrationFile, `import type { Project } from 'ts-morph';
import type { Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import { rules } from './mapping.js';

export const migration: Migration = {
  id: ${id},
  packageName: ${pkg},
  fromMajor: ${toMajor - 1},
  toMajor: ${toMajor},
  releasedAt: 'YYYY-MM-DD', // Replace with the upstream release date.
  title: '${packageName} v${toMajor - 1} → v${toMajor}',
  guideUrl: 'https://REPLACE-WITH-OFFICIAL-MIGRATION-GUIDE',
  rules: rules.map((rule) => rule.name),
  transform(_project: Project): MigrationResult {
    return { changes: [], manual: [], filesChanged: [] };
  },
  updateManifest(_manifest: PackageManifest): string[] {
    return [];
  },
};
`, 'utf8'),
    writeFile(mappingFile, `/** Add conservative, tested migration rules here. */
export interface MigrationRule {
  name: string;
  description: string;
}

export const rules: MigrationRule[] = [];
`, 'utf8'),
    writeFile(unitTest, `import { describe, expect, it } from 'vitest';
import { migration } from '../../src/migrations/${directoryName}/index.js';

describe('${packageName} v${toMajor - 1} → v${toMajor} migration', () => {
  it('has at least one documented migration rule before it can be used', () => {
    expect(migration.rules.length).toBeGreaterThan(0);
  });

  it('starts with no manual findings for an empty source project', () => {
    const result = migration.transform({ getSourceFiles: () => [] } as never);
    expect(result.manual).toEqual([]);
  });
});
`, 'utf8'),
    writeFile(realSdkTest, realSdkTestTemplate({ packageName, fromMajor: toMajor - 1, toMajor, directoryName }), 'utf8'),
  ]);
  return migrationDirectory;
}

interface RealSdkTemplateOptions {
  packageName: string;
  fromMajor: number;
  toMajor: number;
  directoryName: string;
}

function realSdkTestTemplate(options: RealSdkTemplateOptions): string {
  const packageName = JSON.stringify(options.packageName);
  return `import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { migration } from '../../src/migrations/${options.directoryName}/index.js';

const execFile = promisify(execFileCallback);
const enabled = process.env.UPSTREAMFIX_RUN_REAL_SDK_TESTS === '1';

describe.skipIf(!enabled)('${options.packageName} real SDK compatibility', () => {
  it('typechecks a fixture before and after migration against both SDK majors', async () => {
    expect(migration.rules.length, 'Add migration rules before enabling the real SDK test.').toBeGreaterThan(0);
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-real-sdk-'));
    try {
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' }, include: ['fixture.ts'] }));
      await writeFile(path.join(cwd, 'fixture.ts'), '// Replace this with a minimal real usage of the old SDK API.\\n');
      await install(cwd, ${packageName} + '@^${options.fromMajor}', 'typescript');
      expect(await readFile(path.join(cwd, 'fixture.ts'), 'utf8')).not.toContain('Replace this with a minimal real usage');
      await typecheck(cwd);

      const fixture = path.join(cwd, 'fixture.ts');
      const project = new Project({ skipAddingFilesFromTsConfig: true });
      project.addSourceFileAtPath(fixture);
      const result = migration.transform(project);
      expect(result.manual, 'Resolve fixture usages that the migration cannot handle automatically.').toEqual([]);
      expect(result.fileUpdates?.some((update) => update.file === fixture), 'The migration should rewrite the fixture against the target SDK.').toBe(true);
      for (const update of result.fileUpdates ?? []) await writeFile(update.file, update.contents);
      await install(cwd, ${packageName} + '@^${options.toMajor}');
      await typecheck(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});

async function install(cwd: string, ...packages: string[]): Promise<void> {
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packages], { cwd, timeout: 120_000 });
}

async function typecheck(cwd: string): Promise<void> {
  await execFile('npm', ['exec', '--', 'tsc', '--noEmit'], { cwd, timeout: 60_000 });
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageName, targetVersion] = process.argv.slice(2);
  if (!packageName || !targetVersion) {
    console.error('Usage: npm run new-migration -- <npm-package> <target-major>');
    process.exitCode = 1;
  } else {
    generateMigrationScaffold(process.cwd(), packageName, targetVersion)
      .then((directory) => console.log(`Generated migration scaffold at ${path.relative(process.cwd(), directory)}; add rules and register it in src/migrations/index.ts.`))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
