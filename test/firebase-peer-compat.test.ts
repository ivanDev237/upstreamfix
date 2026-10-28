import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { allowsFirebaseAdmin14, resolveFirebasePeers, type FirebasePeerRegistry } from '../src/core/firebase-peer-compat.js';
import { runMigration } from '../src/core/runner.js';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { validatePublishableBundle, type Proposal } from '../src/action/publish.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project(companion: string, range: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-firebase-peer-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', engines: { node: '>=22' },
    dependencies: { 'firebase-admin': '^13.0.0', [companion]: range } }, null, 2) + '\n');
  await writeFile(path.join(root, 'index.js'), "const admin = require('firebase-admin');\nadmin.firestore();\n");
  return root;
}

it('understands common npm peer ranges conservatively', () => {
  expect(allowsFirebaseAdmin14('^8.0.0 || ^9.0.0 || ^13.0.0')).toBe(false);
  expect(allowsFirebaseAdmin14('^13.0.0 || ^14.0.0')).toBe(true);
  expect(allowsFirebaseAdmin14('>=12.0.0 <15.0.0')).toBe(true);
  expect(allowsFirebaseAdmin14('>=4.9.0')).toBe(true);
  expect(allowsFirebaseAdmin14('14.2.1')).toBe(true);
  expect(allowsFirebaseAdmin14('>=14.2.1 <14.3.0')).toBe(true);
  expect(allowsFirebaseAdmin14('workspace:*')).toBeUndefined();
});

it('blocks a test companion when no published version accepts firebase-admin 14', async () => {
  const root = await project('firebase-functions-test', '^3.5.0');
  const registry: FirebasePeerRegistry = async () => ({
    '3.4.1': { peerDependencies: { 'firebase-admin': '^12.0.0 || ^13.0.0' } },
    '3.5.0': { peerDependencies: { 'firebase-admin': '^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0 || ^12.0.0 || ^13.0.0' } },
  });
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true, peerRegistry: registry });
  expect(outcome.manual.some((item) => item.reason.includes('no published version accepts firebase-admin 14'))).toBe(true);
  expect(outcome.proposedFiles).toHaveLength(1); // source preview only; --write remains blocked by the manual item
  expect(outcome.proposedFiles[0]?.relativePath).toBe('index.js');
  expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies['firebase-admin']).toBe('^13.0.0');
});

it('does not treat older peerless releases as an upgrade for firebase-functions-test', async () => {
  const root = await project('firebase-functions-test', '^3.5.0');
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true,
    peerRegistry: async () => ({
      '2.0.0': {},
      '3.0.0': {},
      '3.5.0': { peerDependencies: { 'firebase-admin': '^8.0.0 || ^9.0.0 || ^13.0.0' } },
      '4.0.0-beta.1': { peerDependencies: { 'firebase-admin': '^14.0.0' } },
    }) });
  expect(outcome.manual[0]?.reason).toContain('Blocked by firebase-functions-test: no published version accepts firebase-admin 14');
  expect(outcome.manual[0]?.reason).toContain('firebase/firebase-functions-test/issues/347');
});

it('treats a newer peerless stable release as uncertain, not proven compatible', async () => {
  const root = await project('firebase-functions-test', '^3.5.0');
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true,
    peerRegistry: async () => ({
      '3.5.0': { peerDependencies: { 'firebase-admin': '^13.0.0' } },
      '4.0.0': {},
    }) });
  expect(outcome.manual[0]?.reason).toContain('could not be safely confirmed');
  expect(outcome.manual[0]?.reason).not.toContain('a compatible published version exists');
});

it('proposes firebase-functions 7.3.0 alongside firebase-admin 14', async () => {
  const root = await project('firebase-functions', '^6.0.0');
  const registry: FirebasePeerRegistry = async () => ({
    '6.0.0': { peerDependencies: { 'firebase-admin': '^11.0.0 || ^12.0.0 || ^13.0.0' } },
    '7.3.0': { peerDependencies: { 'firebase-admin': '^13.0.0 || ^14.0.0' } },
  });
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true, peerRegistry: registry });
  expect(outcome.manual).toHaveLength(0);
  const manifest = outcome.proposedFiles.find((file) => file.relativePath === 'package.json');
  expect(JSON.parse(manifest!.after).dependencies).toMatchObject({
    'firebase-admin': '^14.0.0', 'firebase-functions': '^7.3.0' });
  expect(outcome.manifestNotes.join(' ')).toContain('firebase-functions ^6.0.0 → ^7.3.0');
});

it('keeps a bot follow-up source-only when its PR still has an incompatible companion', async () => {
  const root = await project('firebase-functions', '^6.0.0');
  const manifest = (await readFile(path.join(root, 'package.json'), 'utf8')).replace('^13.0.0', '^14.0.0');
  await writeFile(path.join(root, 'package.json'), manifest);
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true, sourceMajor: 13,
    peerRegistry: async () => ({
      '6.0.0': { peerDependencies: { 'firebase-admin': '^13.0.0' } },
      '7.3.0': { peerDependencies: { 'firebase-admin': '^14.0.0' } },
    }) });
  expect(outcome.manual.some((item) => item.reason.includes('update that bot PR'))).toBe(true);
  expect(outcome.proposedFiles.every((file) => file.relativePath !== 'package.json')).toBe(true);
});

it('does not invent a compatible upgrade if registry metadata cannot be checked', async () => {
  const root = await project('firebase-functions-test', '^3.5.0');
  const outcome = await runMigration(firebaseAdminV14, { cwd: root, dryRun: true,
    peerRegistry: async () => { throw new Error('offline'); } });
  expect(outcome.manual.some((item) => item.reason.includes('Could not confirm published'))).toBe(true);
});

it('detects a locked third-party peer blocker before installing dependencies', async () => {
  const root = await project('thirdparty-sdk', '^2.0.0');
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { 'firebase-admin': '^13.0.0', 'thirdparty-sdk': '^2.0.0' } },
    'node_modules/thirdparty-sdk': { version: '2.0.0', peerDependencies: { 'firebase-admin': '^13.0.0' } },
  } }));
  const resolution = await resolveFirebasePeers(path.join(root, 'package.json'), async () => ({
    '2.0.0': { peerDependencies: { 'firebase-admin': '^13.0.0' } },
    '3.0.0': { peerDependencies: { 'firebase-admin': '^13.0.0' } },
  }));
  expect(resolution.manual[0]?.reason).toContain('Blocked by thirdparty-sdk');
});

it('publisher accepts only the mapped companion bump alongside firebase-admin 14', () => {
  const before = JSON.stringify({ dependencies: { 'firebase-admin': '^13.0.0', 'firebase-functions': '^6.0.0' } });
  const after = JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0', 'firebase-functions': '^7.3.0' } });
  const forged = JSON.stringify({ dependencies: { 'firebase-admin': '^14.0.0', 'firebase-functions': '^7.4.0' } });
  const proposal: Proposal = { schema: 1, migration: 'firebase-admin@14', status: 'ready', base: 'a'.repeat(40),
    branch: 'upstreamfix/firebase-admin-14', commit: 'b'.repeat(40), files: ['package.json'],
    verification: 'passed', report: '', reviewers: [], labels: [] };
  const identity = { author: 'upstreamfix[bot]', committer: 'upstreamfix[bot]',
    authorEmail: '41898282+github-actions[bot]@users.noreply.github.com',
    committerEmail: '41898282+github-actions[bot]@users.noreply.github.com',
    subject: 'Apply firebase-admin@14 migration with UpstreamFix' };
  expect(() => validatePublishableBundle(proposal, { 'package.json': { before, after } }, identity)).not.toThrow();
  expect(() => validatePublishableBundle(proposal, { 'package.json': { before, after: forged } }, identity)).toThrow();
});
