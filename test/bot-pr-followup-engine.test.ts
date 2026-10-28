import { execFile as callback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runMigration } from '../src/core/runner.js';
import { verifyProposedMigration } from '../src/core/verify.js';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { createProgram } from '../src/cli.js';

const execFile = promisify(callback);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function robotHead(range = '^14.0.0'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-bot-head-'));
  roots.push(root);
  await execFile('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'firebase-admin': range },
    engines: { node: '>=22' }, scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {
    '': { dependencies: { 'firebase-admin': range } }, 'node_modules/firebase-admin': { version: '14.0.0' }
  } }, null, 2) + '\n');
  await writeFile(path.join(root, 'server.js'), "const admin = require('firebase-admin');\nadmin.initializeApp();\n");
  await execFile('git', ['add', '.'], { cwd: root });
  return root;
}

it('refuses to reinterpret a robot-updated v14 manifest without an explicit source major', async () => {
  const cwd = await robotHead();
  const outcome = await runMigration(firebaseAdminV14, { cwd, dryRun: true });
  expect(outcome.proposedFiles).toHaveLength(0);
  expect(outcome.manual.some((item) => item.reason.includes('only analyzes major'))).toBe(true);
});

it.each([12, 13])('migrates source major %i on a robot head without editing the manifest or lockfile', async (sourceMajor) => {
  const cwd = await robotHead();
  const manifest = await readFile(path.join(cwd, 'package.json'), 'utf8');
  const lock = await readFile(path.join(cwd, 'package-lock.json'), 'utf8');
  const outcome = await runMigration(firebaseAdminV14, { cwd, dryRun: true, sourceMajor });
  expect(outcome.manual).toHaveLength(0);
  expect(outcome.proposedFiles.map((file) => file.relativePath)).toEqual(['server.js']);
  expect(outcome.proposedFiles[0]?.after).toContain('initializeApp()');
  expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(manifest);
  expect(await readFile(path.join(cwd, 'package-lock.json'), 'utf8')).toBe(lock);
  const verification = await verifyProposedMigration(cwd, outcome.proposedDiff, { fileChanges: outcome.proposedFiles,
    execute: async () => ({ stdout: 'ok' }) });
  expect(verification.status).toBe('passed');
}, 20_000);

it('refuses source-major mode outside the supported Firebase robot transition', async () => {
  const cwd = await robotHead('^13.0.0');
  const outcome = await runMigration(firebaseAdminV14, { cwd, dryRun: true, sourceMajor: 13 });
  expect(outcome.manual.some((item) => item.reason.includes('dependency-bot follow-up'))).toBe(true);
  expect(outcome.proposedFiles).toHaveLength(0);
});

it('accepts --source-major 13 through the CLI and rejects an unsupported major', async () => {
  const cwd = await robotHead();
  const program = createProgram();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  await expect(program.parseAsync(['migrate', 'firebase-admin@14', '-C', cwd, '--source-major', '13'],
    { from: 'user' })).resolves.toBeDefined();
  await expect(createProgram().parseAsync(['migrate', 'firebase-admin@14', '-C', cwd, '--source-major', '11'],
    { from: 'user' })).rejects.toThrow('--source-major accepts only 12 or 13');
}, 20_000);
