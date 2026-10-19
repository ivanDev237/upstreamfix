import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigration } from '../src/core/runner.js';
import { createProgram } from '../src/cli.js';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { loadRecipe, parseRecipe } from '../src/recipes/index.js';
import { recipeSchema } from '../src/recipes/schema.js';
import { verifyProposedMigration } from '../src/core/verify.js';

const directories: string[] = [];
const recipePath = path.resolve('docs/recipes/firebase-admin-v14.yml');
const execFile = promisify(execFileCallback);

async function fixture(source: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-recipe-'));
  directories.push(cwd);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { 'firebase-admin': '^13.0.0' }, engines: { node: '>=22' },
  }, null, 2) + '\n');
  await writeFile(path.join(cwd, 'server.ts'), source);
  return cwd;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('declarative recipes', () => {
  it.each([
    "import * as admin from 'firebase-admin';\nadmin.initializeApp();\nconst db = admin.firestore();\n",
    "import * as admin from 'firebase-admin';\nconst app = admin.app();\nconst apps = admin.apps;\nconst auth = admin.auth();\n",
    "const admin = require('firebase-admin');\nadmin.initializeApp();\nconst db = admin.firestore();\n",
    "import * as admin from 'firebase-admin';\nconst db = admin.app().firestore();\n",
    "import admin from 'firebase-admin';\nconst app = admin.app();\n",
    "#!/usr/bin/env node\n'use strict';\nconst admin = require('firebase-admin');\nconst db = admin.firestore();\n",
  ])('matches Firebase service-getter and app-lifecycle output exactly for fixture %#', async (source) => {
    const cwd = await fixture(source);
    const recipe = await loadRecipe(recipePath);
    const expected = await runMigration(firebaseAdminV14, { cwd, dryRun: true });
    const actual = await runMigration(recipe, { cwd, dryRun: true });
    expect(actual).toEqual(expected);
  });

  it('rejects syntax errors and nested overlapping edits without rewriting the file', async () => {
    const recipe = await loadRecipe(recipePath);
    const bad = await fixture("import * as admin from 'firebase-admin';\nconst broken = ;\nadmin.firestore();\n");
    const badResult = await runMigration(recipe, { cwd: bad, dryRun: true });
    expect(badResult.manual.some((item) => item.reason.includes('syntax errors'))).toBe(true);
    expect(badResult.proposedFiles).toHaveLength(0);
    const overlapping = await fixture("import * as admin from 'firebase-admin';\nadmin.app().database(admin.app().options.databaseURL);\n");
    const result = await runMigration(recipe, { cwd: overlapping, dryRun: true });
    expect(result.manual.some((item) => item.reason.includes('overlap') || item.reason.includes('no safe recipe mapping'))).toBe(true);
    expect(result.proposedFiles).toHaveLength(0);
  });

  it('reports always-manual patterns without changing the dependency', async () => {
    const recipe = await loadRecipe(recipePath);
    const cwd = await fixture("import * as admin from 'firebase-admin';\nadmin.instanceId();\n");
    const result = await runMigration(recipe, { cwd, dryRun: true });
    expect(result.manual.map((item) => item.reason).join(' ')).toContain('Instance ID');
    expect(result.proposedFiles).toHaveLength(0);
  });

  it('rejects malformed and dangerous YAML with a bounded parser', async () => {
    expect(() => parseRecipe('package: x\npackage: y\n')).toThrow(/duplicate/i);
    expect(() => parseRecipe('package: &anchor x\n')).toThrow(/unsupported|anchor/i);
    expect(() => parseRecipe('package: !!js/function foo\n')).toThrow(/unsupported|tag/i);
    expect(() => parseRecipe('x'.repeat(70_000))).toThrow(/size/i);
    expect(() => parseRecipe('package: ../evil\n')).toThrow(/package|schema/i);
  });

  it('supports a recipe passed through the experimental CLI flag', async () => {
    const cwd = await fixture("import * as admin from 'firebase-admin';\nadmin.firestore();\n");
    const printed: string[] = [];
    const previous = console.log;
    console.log = (...args) => { printed.push(args.map(String).join(' ')); };
    try {
      await createProgram().parseAsync(['node', 'upstreamfix', 'migrate', '--recipe', recipePath, '--cwd', cwd]);
    } finally {
      console.log = previous;
    }
    expect(printed.join('\n')).toContain('service-getter');
    expect(await readFile(path.join(cwd, 'server.ts'), 'utf8')).toContain('admin.firestore()');
  });

  it('applies export renames, import moves and method renames without changing local names', async () => {
    const recipe = parseRecipe(`schemaVersion: 1
id: acme-sdk@2
package: acme-sdk
fromMajor: 1
toMajor: 2
releasedAt: 2026-10-19
title: Acme SDK v2
guideUrl: https://example.org/upgrade
nodeMajor: 22
rules:
  - kind: export-rename
    id: rename-client
    name: OldClient
    to: NewClient
  - kind: import-move
    id: move-helper
    name: helper
    from: acme-sdk/helpers
  - kind: method-rename
    id: rename-method
    name: fetchOld
    to: fetchNew
    receiver: client
`);
    const cwd = await fixture('');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'acme-sdk': '^1.0.0' }, engines: { node: '>=22' } }));
    await writeFile(path.join(cwd, 'server.ts'), "import { OldClient as client } from 'acme-sdk';\nimport { helper } from 'acme-sdk';\nclient.fetchOld();\nhelper();\n");
    const result = await runMigration(recipe, { cwd, dryRun: true });
    const source = result.proposedFiles.find((item) => item.relativePath === 'server.ts')?.after;
    expect(source).toContain("import { NewClient as client } from 'acme-sdk'");
    expect(source).toContain("import { helper } from 'acme-sdk/helpers'");
    expect(source).toContain('client.fetchNew()');
    expect(result.proposedFiles.find((item) => item.relativePath === 'package.json')?.after).toContain('^2.0.0');
    expect(result.manual).toHaveLength(0);
  });

  it('withholds a mixed import instead of dropping its default binding', async () => {
    const recipe = parseRecipe(`schemaVersion: 1
id: acme-sdk@2
package: acme-sdk
fromMajor: 1
toMajor: 2
releasedAt: 2026-10-19
title: Acme SDK v2
guideUrl: https://example.org/upgrade
nodeMajor: 22
rules:
  - kind: import-move
    id: move-helper
    name: helper
    from: acme-sdk/helpers
`);
    const cwd = await fixture('');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'acme-sdk': '^1.0.0' }, engines: { node: '>=22' } }));
    await writeFile(path.join(cwd, 'server.ts'), "import Acme, { helper } from 'acme-sdk';\nhelper(); Acme();\n");
    const result = await runMigration(recipe, { cwd, dryRun: true });
    expect(result.manual.some((item) => item.reason.includes('mixed'))).toBe(true);
    expect(result.proposedFiles).toHaveLength(0);
  });

  it('rejects malformed schema fields with a path-specific error', () => {
    const valid = `schemaVersion: 1
id: acme-sdk@2
package: acme-sdk
fromMajor: 1
toMajor: 2
releasedAt: 2026-10-19
title: Acme SDK v2
guideUrl: https://example.org/upgrade
nodeMajor: 22
rules:
  - kind: namespace-call
    id: get-client
    name: client
    to: getClient
    from: acme-sdk/client
`;
    expect(() => parseRecipe(valid.replace('from: acme-sdk/client', 'from: ../secret'))).toThrow(/rules\[0\]\.from/);
    expect(() => parseRecipe(valid.replace('nodeMajor: 22', 'nodeMajor: twenty-two'))).toThrow(/nodeMajor/);
    expect(() => parseRecipe(valid.replace('to: getClient', 'to: getClient\n    pattern: (a+)+'))).toThrow(/pattern/);
  });

  it('keeps the published JSON schema equal to the runtime validator schema', async () => {
    const published = JSON.parse(await readFile('docs/recipe.schema.json', 'utf8')) as unknown;
    expect(recipeSchema).toEqual(published);
  });

  it('passes the ordinary proposal through temporary-copy verification and reporting', async () => {
    const cwd = await fixture("import * as admin from 'firebase-admin';\nadmin.initializeApp();\n");
    const manifestFile = path.join(cwd, 'package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.scripts = { typecheck: 'node -e "process.exit(0)"' };
    await writeFile(manifestFile, JSON.stringify(manifest));
    await execFile('git', ['init', '-q'], { cwd });
    await execFile('git', ['add', 'server.ts', 'package.json'], { cwd });
    const recipe = await loadRecipe(recipePath);
    const outcome = await runMigration(recipe, { cwd, dryRun: true });
    const verification = await verifyProposedMigration(cwd, outcome.proposedDiff, {
      packageName: recipe.packageName,
      fileChanges: outcome.proposedFiles,
      execute: async () => ({ stdout: 'offline check passed' }),
    });
    expect(verification.status).toBe('passed');
    expect(verification.checks.some((check) => check.name.includes('Typecheck'))).toBe(true);
    expect(await readFile(path.join(cwd, 'server.ts'), 'utf8')).toContain('admin.initializeApp()');
  });
});
