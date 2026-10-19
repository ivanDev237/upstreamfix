import { execFile as execFileCallback } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { lockfileCommandEnvironment } from '../../src/core/runner.js';

const execFile = promisify(execFileCallback);

export function realSdkCommandOptions(cwd: string, timeout: number) {
  const home = path.join(cwd, '.upstreamfix-test-home');
  return { cwd, timeout, env: lockfileCommandEnvironment(home) };
}

export async function runRealSdkNpm(cwd: string, args: string[], timeout = 240_000): Promise<void> {
  await mkdir(path.join(cwd, '.upstreamfix-test-home'), { recursive: true });
  await execFile('npm', args, realSdkCommandOptions(cwd, timeout));
}

export async function runRealSdkNode(cwd: string, args: string[], timeout = 90_000): Promise<void> {
  await mkdir(path.join(cwd, '.upstreamfix-test-home'), { recursive: true });
  await execFile(process.execPath, args, realSdkCommandOptions(cwd, timeout));
}
