import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { executeWithProcessGroup } from '../core/verify.js';
import { dockerBindArgs } from '../core/docker-mount.js';

const execFile = promisify(execFileCallback);
const image = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Run customer-controlled package commands in a disposable PID/mount namespace. */
export function buildClientDockerArgs(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, allowInstallNetwork: boolean, name: string): string[] {
  const home = env.HOME;
  if (!home || !path.isAbsolute(home) || !cwd.startsWith(`${path.dirname(home)}${path.sep}`)) {
    throw new Error('Container verification requires a temporary project and home directory.');
  }
  const temporaryRoot = path.dirname(home);
  const safeEnv: NodeJS.ProcessEnv = { ...env, PATH: '/usr/local/bin:/usr/bin:/bin', COREPACK_ENABLE_PROJECT_SPEC: '1' };
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) delete safeEnv[key];
  const program = command === 'pnpm' || command === 'yarn' ? 'corepack' : command;
  const programArgs = command === 'pnpm' || command === 'yarn'
    ? [command, ...args]
    : args;
  return [
    'run', '--rm', '--pull=never', '--init', '--name', name,
    '--network', allowInstallNetwork ? 'bridge' : 'none',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--memory-swap=2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    ...dockerBindArgs(cwd, cwd),
    ...dockerBindArgs(home, home),
    '--workdir', cwd,
    ...Object.entries(safeEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image, program, ...programArgs,
  ];
}

export async function executeClientCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, allowInstallNetwork = false): Promise<{ stdout: string; stderr: string }> {
  const home = env.HOME;
  if (!home) throw new Error('Container verification requires an isolated home.');
  const temporaryRoot = path.dirname(home);
  const name = `upstreamfix-client-${randomUUID()}`;
  const dockerArgs = buildClientDockerArgs(command, args, cwd, env, allowInstallNetwork, name);
  const hostHome = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-docker-host-'));
  const hostEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: hostHome, DOCKER_CONFIG: path.join(hostHome, '.docker') };
  try {
    await mkdir(hostEnv.DOCKER_CONFIG);
    return await executeWithProcessGroup('docker', dockerArgs, temporaryRoot, hostEnv, timeoutMs);
  } finally {
    await execFile('docker', ['rm', '-f', name], { timeout: 10_000, env: hostEnv }).catch(() => undefined);
    await rm(hostHome, { recursive: true, force: true });
  }
}
