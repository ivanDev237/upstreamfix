import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareProposals, boundProposalReport } from '../src/action/migrate.js';
import { parseActionConfig } from '../src/action/config.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
it('P3.4 requires an explicit reviewed Action opt-in for experimental OpenAI', () => {
  expect(parseActionConfig('').experimental).toEqual([]);
  expect(parseActionConfig('experimental:\n  - openai@5\n').experimental).toEqual(['openai@5']);
  expect(() => parseActionConfig('experimental:\n  - stripe@22\n')).toThrow();
});
it('P3.4 keeps OpenAI disabled in the Action until the reviewed config opts in', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-openai-action-'));
  roots.push(root);
  const client = path.join(root, 'client');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"dependencies":{"openai":"^4.0.0"},"engines":{"node":">=20"}}\n');
  await writeFile(path.join(client, 'client.ts'), "import OpenAI from 'openai';\nconst client = new OpenAI();\nclient.files.del('file_1');\n");
  await execFile('git', ['add', '.'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  const disabled = await prepareProposals(client, path.join(root, 'disabled'), base, 'workflow_dispatch');
  expect(disabled.find((item) => item.migration === 'openai@5')).toMatchObject({ status: 'none', verification: 'skipped' });
  expect(disabled.find((item) => item.migration === 'openai@5')?.report).toContain('Experimental migration disabled');
});
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each(['remote.origin.pushurl', 'url.https://token@evil.invalid/.pushinsteadof'])('X8 rejects checkout credentials hidden in %s', async (key) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-credentials-'));
  roots.push(root);
  await execFile('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), '{"name":"safe"}\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  await execFile('git', ['config', '--local', key, key.startsWith('remote') ? 'https://token@evil.invalid/repo.git' : 'https://github.com/'], { cwd: root });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await expect(prepareProposals(root, path.join(root, '..', 'output-' + path.basename(root)), base, 'workflow_dispatch'))
    .rejects.toThrow(/credentials/i);
});

it('X8 signal cleanup owns both the Docker container and its host-only HOME', async () => {
  const source = await readFile(new URL('../src/action/docker-execute.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/registerTemporaryCleanup\(async \(\) => \{[\s\S]*?removeContainer\(\)[\s\S]*?rm\(hostHome/);
});

it('bounds a 120k report without splitting a Unicode character and keeps the full artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-long-report-'));
  roots.push(root);
  const original = `${'x'.repeat(87_999)}😀${'y'.repeat(32_000)}`;
  const short = await boundProposalReport(root, 'openai@5', original);
  expect(short.length).toBeLessThanOrEqual(90_000);
  expect(short).toContain('artifact');
  expect(short).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  expect(await readFile(path.join(root, 'report-openai-5.md'), 'utf8')).toBe(original);
});

it('records migrations that no longer apply without writing inside the client checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-action-migrate-'));
  roots.push(root);
  const client = path.join(root, 'client');
  const output = path.join(root, 'output');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"name":"safe","version":"1.0.0"}\n');
  await execFile('git', ['add', 'package.json'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  const proposals = await prepareProposals(client, output, base, 'workflow_dispatch');
  expect(proposals.length).toBeGreaterThan(0);
  expect(proposals.every((proposal) => proposal.status === 'none')).toBe(true);
  expect(JSON.parse(await readFile(path.join(output, 'proposals.json'), 'utf8'))).toEqual(proposals);
  await expect(readFile(path.join(client, 'proposals.json'), 'utf8')).rejects.toThrow();
});

it('emits a none proposal for an ignored migration so stale bot PRs can close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-action-ignore-'));
  roots.push(root);
  const client = path.join(root, 'client');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"name":"safe","version":"1.0.0"}\n');
  await writeFile(path.join(client, '.upstreamfix.yml'), 'ignore:\n  - firebase-admin@14\n');
  await execFile('git', ['add', '.'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  const proposals = await prepareProposals(client, path.join(root, 'output'), base, 'workflow_dispatch');
  expect(proposals.find((item) => item.migration === 'firebase-admin@14')).toMatchObject({ status: 'none', verification: 'skipped' });
});

it.each(['pnpm-lock.yaml', 'yarn.lock'])('Y3 reports %s for manual review before creating a migration branch', async (lockName) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-manual-lock-'));
  roots.push(root);
  const client = path.join(root, 'client');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"name":"fixture","dependencies":{"firebase-admin":"^13.0.0"},"engines":{"node":">=22"}}\n');
  await writeFile(path.join(client, 'server.ts'), "import * as admin from 'firebase-admin';\nadmin.initializeApp();\n");
  await writeFile(path.join(client, lockName), '# existing lockfile\n');
  await execFile('git', ['add', '.'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  const proposals = await prepareProposals(client, path.join(root, 'output'), base, 'workflow_dispatch');
  const firebase = proposals.find((item) => item.migration === 'firebase-admin@14');
  expect(firebase).toMatchObject({ status: 'manual', verification: 'skipped' });
  expect(firebase?.report).toMatch(/lockfile/i);
  expect(firebase?.commit).toBeUndefined();
});

it('refuses pull-request events before examining a client repository', async () => {
  await expect(prepareProposals('/does-not-exist', '/tmp/upstreamfix-unused', 'a'.repeat(40), 'pull_request_target'))
    .rejects.toThrow('Only schedule, workflow_dispatch and repository_dispatch');
});

it('prepares migrations for a GitHub App repository_dispatch like a manual dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-action-app-dispatch-'));
  roots.push(root);
  const client = path.join(root, 'client');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"name":"safe","version":"1.0.0"}\n');
  await execFile('git', ['add', 'package.json'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  await expect(prepareProposals(client, path.join(root, 'output'), base, 'repository_dispatch')).resolves.toBeInstanceOf(Array);
  await expect(readFile(path.join(root, 'output', 'proposals.json'), 'utf8')).resolves.toBeDefined();
});

it('refuses to run client code when checkout stored a credential in Git config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-action-token-'));
  roots.push(root);
  const client = path.join(root, 'client');
  await execFile('git', ['init', '-q', client]);
  await writeFile(path.join(client, 'package.json'), '{"name":"safe","version":"1.0.0"}\n');
  await execFile('git', ['add', 'package.json'], { cwd: client });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: client });
  const base = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  await execFile('git', ['config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic trap'], { cwd: client });
  await expect(prepareProposals(client, path.join(root, 'output'), base, 'workflow_dispatch'))
    .rejects.toThrow('Git credentials');
});
