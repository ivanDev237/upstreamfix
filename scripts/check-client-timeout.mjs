import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeClientCommand } from '../dist/action/docker-execute.js';

const execFile = promisify(execFileCallback);
const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-timeout-smoke-'));
try {
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const started = Date.now();
  let timedOut = false;
  try {
    await executeClientCommand('node', ['-e', 'setTimeout(() => {}, 60000)'], project, { HOME: home }, 1500);
  } catch (error) {
    timedOut = /timed?\s*out|timeout/i.test(String(error));
  }
  if (!timedOut || Date.now() - started > 15_000) throw new Error('The long-running client command did not stop within its deadline.');
  const { stdout } = await execFile('docker', ['ps', '-q', '--filter', 'name=upstreamfix-client-']);
  if (stdout.trim()) throw new Error('A client verification container survived its timeout.');
  console.log('Client command timeout enforced; no container survived.');
} finally {
  await rm(root, { recursive: true, force: true });
}
