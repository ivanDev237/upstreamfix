import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { executeWithProcessGroup } from '../core/verify.js';
import { dockerBindArgs } from '../core/docker-mount.js';

const execFile = promisify(execFileCallback);
const image = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Run customer-controlled package commands in a disposable PID/mount namespace. */
export async function executeClientCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const home = env.HOME;
  if (!home || !path.isAbsolute(home) || !cwd.startsWith(`${path.dirname(home)}${path.sep}`)) {
    throw new Error('Container verification requires a temporary project and home directory.');
  }
  const temporaryRoot = path.dirname(home);
  const name = `upstreamfix-client-${randomUUID()}`;
  const isInstall = args.includes('install') || args.includes('ci') || args.includes('--version');
  const safeEnv = { ...env, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const dockerArgs = [
    'run', '--rm', '--init', '--name', name,
    '--network', isInstall ? 'bridge' : 'none',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--memory-swap=2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    ...dockerBindArgs(temporaryRoot, temporaryRoot),
    '--workdir', cwd,
    ...Object.entries(safeEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image, command, ...args,
  ];
  try {
    return await executeWithProcessGroup('docker', dockerArgs, temporaryRoot, {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temporaryRoot,
    }, timeoutMs);
  } finally {
    await execFile('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(() => undefined);
  }
}
