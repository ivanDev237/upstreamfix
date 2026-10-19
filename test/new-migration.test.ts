import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { generateMigrationScaffold } from '../scripts/new-migration.js';

const roots: string[] = [];
const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration scaffold generator', () => {
  it('generates a migration, mapping, failing rule test, and opt-in real SDK test', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-scaffold-'));
    roots.push(root);
    const directory = await generateMigrationScaffold(root, '@acme/storage-sdk', 'v22');

    expect(directory).toBe(path.join(root, 'src', 'migrations', 'acme-storage-sdk-v22'));
    expect(await readFile(path.join(directory, 'index.ts'), 'utf8')).toContain("packageName: \"@acme/storage-sdk\"");
    expect(await readFile(path.join(directory, 'mapping.ts'), 'utf8')).toContain('rules: MigrationRule[] = []');
    expect(await readFile(path.join(root, 'test/migrations/acme-storage-sdk-v22.test.ts'), 'utf8'))
      .toContain('expect(migration.rules.length).toBeGreaterThan(0)');
    const sdkTest = await readFile(path.join(root, 'test/migrations/acme-storage-sdk-v22.real-sdk.test.ts'), 'utf8');
    expect(sdkTest).toContain('UPSTREAMFIX_RUN_REAL_SDK_TESTS');
    expect(sdkTest).toContain('typecheck(cwd)');
    expect(sdkTest).toContain('"@acme/storage-sdk" + \'@^21\'');
    expect(sdkTest).toContain('"@acme/storage-sdk" + \'@^22\'');
    const generatedProject = new Project({ useInMemoryFileSystem: true });
    const sourceFile = generatedProject.createSourceFile('generated.test.ts', sdkTest);
    expect((sourceFile.compilerNode as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
  });

  it('rejects invalid identifiers and never overwrites an existing scaffold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-scaffold-'));
    roots.push(root);
    await expect(generateMigrationScaffold(root, '../evil', '22')).rejects.toThrow('Invalid npm package name');
    await expect(generateMigrationScaffold(root, 'valid-package', 'not-a-version')).rejects.toThrow('Invalid target major');
    await generateMigrationScaffold(root, 'valid-package', '22');
    await expect(generateMigrationScaffold(root, 'valid-package', '22')).rejects.toThrow('Refusing to overwrite');
  });

  it('never overwrites a scaffold created concurrently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-scaffold-race-'));
    roots.push(root);
    const results = await Promise.allSettled([generateMigrationScaffold(root, 'race-sdk', '22'), generateMigrationScaffold(root, 'race-sdk', '22')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('runs through the documented command line in a temporary project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-scaffold-cli-'));
    roots.push(root);
    await execFile(process.execPath, [
      '--import', path.join(projectRoot, 'node_modules/tsx/dist/loader.mjs'),
      path.join(projectRoot, 'scripts/new-migration.ts'), 'valid-sdk', '22',
    ], { cwd: root, timeout: 10_000 });

    expect(await readFile(path.join(root, 'src/migrations/valid-sdk-v22/index.ts'), 'utf8')).toContain('fromMajor: 21');
  });
});
