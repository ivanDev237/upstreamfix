import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareProposals, boundProposalReport } from '../src/action/migrate.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

it('refuses pull-request events before examining a client repository', async () => {
  await expect(prepareProposals('/does-not-exist', '/tmp/upstreamfix-unused', 'a'.repeat(40), 'pull_request_target'))
    .rejects.toThrow('Only schedule and workflow_dispatch');
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
