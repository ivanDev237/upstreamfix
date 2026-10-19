import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareProposals } from '../src/action/migrate.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
