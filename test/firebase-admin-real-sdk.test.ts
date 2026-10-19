import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { runRealSdkNpm, runRealSdkNode } from './helpers/real-sdk-command.js';

const temporaryDirectories: string[] = [];
const realSdkVersions = ['13.10.0', '14.0.0', '14.5.0'];
const enabled = process.env.UPSTREAMFIX_RUN_REAL_SDK_TESTS === '1';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!enabled)('firebase-admin v14 migration against real SDK releases', () => {
  it.each(realSdkVersions)('generates code that typechecks with firebase-admin@%s', async (version) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-real-sdk-'));
    temporaryDirectories.push(cwd);
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ private: true, engines: { node: '>=22.0.0' }, dependencies: { 'firebase-admin': version } }),
    );

    await runRealSdkNpm(cwd, ['install', '--no-save', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', `firebase-admin@${version}`]);

    const requireFromFixture = createRequire(path.join(cwd, 'package.json'));
    expect(requireFromFixture.resolve('firebase-admin/app')).toBeTruthy();
    expect(requireFromFixture.resolve('firebase-admin/firestore')).toBeTruthy();

    const sourcePath = path.join(cwd, 'server.ts');
    await writeFile(sourcePath, "import * as admin from 'firebase-admin';\nadmin.initializeApp();\nconst db = admin.firestore();\n");
    const project = new Project({ compilerOptions: { allowJs: true } });
    project.addSourceFileAtPath(sourcePath);
    const result = firebaseAdminV14.transform(project);
    const transformed = result.fileUpdates?.find((update) => update.file === sourcePath)?.contents ?? '';
    const transformedPath = path.join(cwd, 'migrated.ts');
    await writeFile(transformedPath, transformed);

    expect(result.manual).toHaveLength(0);
    expect(transformed).toContain('firebase-admin/app');
    expect(transformed).toContain('firebase-admin/firestore');
    expect(transformed).toContain('getFirestore()');

    const repoRoot = process.cwd();
    await runRealSdkNode(cwd, [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      path.join(repoRoot, 'node_modules/@types'),
      transformedPath,
    ], 60_000);

    expect(await readFile(transformedPath, 'utf8')).toBe(transformed);
  }, 300_000);

  it('keeps same-named aliases isolated across real-SDK source files and local re-exports', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-real-sdk-multifile-'));
    temporaryDirectories.push(cwd);
    const manifestPath = path.join(cwd, 'package.json');
    const manifest = {
      private: true,
      engines: { node: '>=22.0.0' },
      dependencies: { 'firebase-admin': '13.10.0' },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await runRealSdkNpm(cwd, ['install', '--no-save', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', 'firebase-admin@13.10.0']);

    const sources = new Map([
      ['firebase.ts', "import * as admin from 'firebase-admin';\nexport const app = admin.initializeApp();\nexport const db = admin.firestore(app);\n"],
      ['notify.ts', "import * as admin from 'firebase-admin';\nexport const messaging = admin.messaging();\n"],
      ['auth.ts', "import * as admin from 'firebase-admin';\nexport const auth = admin.auth();\n"],
      ['default-namespace.ts', "import * as admin from 'firebase-admin';\nexport default admin;\n"],
      ['consumer.ts', "import * as admin from './default-namespace.js';\nexport default admin;\n"],
    ]);
    for (const [file, contents] of sources) await writeFile(path.join(cwd, file), contents);

    const project = new Project({ compilerOptions: { allowJs: true } });
    for (const file of sources.keys()) project.addSourceFileAtPath(path.join(cwd, file));
    const result = firebaseAdminV14.transform(project);
    const updates = new Map(result.fileUpdates?.map((update) => [path.basename(update.file), update.contents]));

    expect([...updates.keys()].sort()).toEqual(['auth.ts', 'firebase.ts', 'notify.ts']);
    expect(result.manual.some((item) => item.file === path.join(cwd, 'consumer.ts'))).toBe(false);
    expect(updates.get('firebase.ts')).toContain('getFirestore(app)');
    expect(updates.get('firebase.ts')).not.toContain('getMessaging');
    expect(updates.get('firebase.ts')).not.toContain('getAuth');
    expect(updates.get('notify.ts')).toContain('getMessaging()');
    expect(updates.get('notify.ts')).not.toContain('getFirestore');
    expect(updates.get('notify.ts')).not.toContain('getAuth');
    expect(updates.get('auth.ts')).toContain('getAuth()');
    expect(updates.get('auth.ts')).not.toContain('getFirestore');
    expect(updates.get('auth.ts')).not.toContain('getMessaging');

    for (const [file, contents] of updates) await writeFile(path.join(cwd, file), contents);
    manifest.dependencies['firebase-admin'] = '14.5.0';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await runRealSdkNpm(cwd, ['install', '--no-save', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', 'firebase-admin@14.5.0']);

    const repoRoot = process.cwd();
    await runRealSdkNode(cwd, [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      path.join(repoRoot, 'node_modules/@types'),
      ...[...sources.keys()].map((file) => path.join(cwd, file)),
    ], 60_000);
  }, 360_000);
});
