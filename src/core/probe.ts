import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newTypeScriptDiagnostics, parseTypeScriptDiagnostics, type TypeScriptDiagnostic } from './diagnostic-diff.js';
import { copyProject, executeWithProcessGroup, sanitizedEnvironment } from './verify.js';
import { validateExactVersion } from './diff-api.js';
import { migrations } from '../migrations/index.js';
import { registerTemporaryCleanup } from './process-cleanup.js';
import { randomUUID } from 'node:crypto';
import { parseManifest } from './manifest.js';
import { dockerBindArgs } from './docker-mount.js';

const nodeImage = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
export type ProbePhase = 'baseline-install' | 'baseline-typecheck' | 'target-install' | 'target-typecheck';
export type ProbeExecutor = (phase: ProbePhase, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; output: string }>;
export interface ProbeOptions { confirmed?: boolean; execute?: ProbeExecutor; timeoutMs?: number }
export interface ProbeResult {
  status: 'confirmation-required' | 'available' | 'unavailable';
  estimatedDownload: string;
  package: string;
  targetVersion: string;
  currentVersion?: string;
  preexisting: TypeScriptDiagnostic[];
  newDiagnostics: TypeScriptDiagnostic[];
  manualFindings: Array<{ file: string; line: number; message: string; symbol?: string; confidence: 'candidate'; guideUrl?: string }>;
  note?: string;
}

function parseTarget(target: string): { packageName: string; version: string } {
  const at = target.lastIndexOf('@');
  if (at <= 0) throw new Error('Probe target must be a package with an exact version, such as stripe@23.0.0.');
  const packageName = target.slice(0, at);
  const version = target.slice(at + 1);
  if (!/^(?:@[a-z0-9_][a-z0-9_.-]*\/)?[a-z0-9_][a-z0-9_.-]*$/i.test(packageName)) throw new Error('Invalid npm package name.');
  validateExactVersion(version);
  return { packageName, version };
}

const realExecutor = async (_phase: ProbePhase, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; output: string }> => {
  try {
    const result = await executeWithProcessGroup(command, args, cwd, env, timeoutMs);
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const cause = error as Error & { stdout?: string; stderr?: string };
    return { code: 1, output: `${cause.stdout ?? ''}${cause.stderr ?? ''}\n${cause.message}` };
  }
};

export async function probeProject(cwd: string, target: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000)) {
    throw new Error('Probe timeout must be at least one second.');
  }
  const { packageName, version } = parseTarget(target);
  const base: ProbeResult = {
    status: 'confirmation-required', package: packageName, targetVersion: version,
    estimatedDownload: 'Estimated cold download: 100–500 MB for two npm installs, plus the pinned Node Docker image if absent.',
    preexisting: [], newDiagnostics: [], manualFindings: [],
  };
  if (!options.confirmed) return base;
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-probe-'));
  const unregisterCleanup = registerTemporaryCleanup(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const execute: ProbeExecutor = options.execute ?? ((phase, command, args, directory, env) =>
    realExecutor(phase, command, args, directory, env, options.timeoutMs ?? 5 * 60 * 1000));
  let unregisterContainerCleanup: (() => void) | undefined;
  let removeContainer: (() => Promise<void>) | undefined;
  try {
    await mkdir(project);
    await mkdir(home);
    await writeFile(path.join(home, 'npmrc.user'), '');
    await writeFile(path.join(home, 'npmrc.global'), '');
    await copyProject(path.resolve(cwd), project, 'probe');
    const manifestPath = path.join(project, 'package.json');
    const manifest = parseManifest<Record<string, Record<string, string>>>(await readFile(manifestPath, 'utf8'));
    const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
    const section = sections.find((name) => typeof manifest[name]?.[packageName] === 'string');
    if (!section) return { ...base, status: 'unavailable', note: `${packageName} is not declared in the root package.json.` };
    const lockContents = await readFile(path.join(project, 'package-lock.json'), 'utf8').catch(() => undefined);
    if (!lockContents) {
      return { ...base, status: 'unavailable', note: 'A root package-lock.json is required for a reproducible npm baseline.' };
    }
    const lock = JSON.parse(lockContents) as { packages?: Record<string, { version?: unknown }> };
    const lockedVersion = lock.packages?.[`node_modules/${packageName}`]?.version;
    if (typeof lockedVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(lockedVersion)) {
      return { ...base, status: 'unavailable', note: `The lockfile does not contain an exact installed ${packageName} version.` };
    }
    const currentVersion = lockedVersion;
    const env = sanitizedEnvironment(home);
    const dockerEnv = { ...env };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      if (process.env[key]) dockerEnv[key] = process.env[key];
    }
    const containerName = `upstreamfix-probe-${process.pid}-${randomUUID()}`;
    removeContainer = async () => {
      await execute('baseline-typecheck', 'docker', ['rm', '-f', containerName], project, dockerEnv).catch(() => undefined);
    };
    unregisterContainerCleanup = registerTemporaryCleanup(removeContainer);
    const run = async (phase: ProbePhase, command: string, args: string[]) => {
      const result = await execute(phase, command, args, project, command === 'docker' ? dockerEnv : env);
      if (command === 'docker' && result.code !== 0) {
        await execute(phase, 'docker', ['rm', '-f', containerName], project, dockerEnv).catch(() => undefined);
      }
      return result;
    };
    const baselineInstall = await run('baseline-install', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']);
    if (baselineInstall.code !== 0) return { ...base, currentVersion, status: 'unavailable', note: `Baseline installation failed: ${baselineInstall.output.slice(-2000)}` };

    await makeDockerReadable(project);

    const typeArgs = [
      'run', '--rm', '--init', '--name', containerName, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--memory=1536m', '--memory-swap=1536m', '--pids-limit=128', '--user=65534:65534',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=64m', ...dockerBindArgs(project, '/workspace', true), '-w', '/workspace',
      nodeImage, 'node', '/workspace/node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false',
      '--tsBuildInfoFile', '/tmp/upstreamfix-probe.tsbuildinfo',
    ];
    const before = await run('baseline-typecheck', 'docker', typeArgs);
    const baselineDiagnostics = parseTypeScriptDiagnostics(before.output);
    if (before.code !== 0 && baselineDiagnostics.length === 0) {
      return { ...base, currentVersion, status: 'unavailable', note: `Baseline typecheck failed without readable diagnostics: ${before.output.slice(-2000)}` };
    }

    const targetInstall = await run('target-install', 'npm', ['install', `${packageName}@${version}`, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']);
    if (targetInstall.code !== 0) return { ...base, currentVersion, status: 'unavailable', preexisting: baselineDiagnostics, note: `Target installation failed: ${targetInstall.output.slice(-2000)}` };
    await makeDockerReadable(project);
    const after = await run('target-typecheck', 'docker', typeArgs);
    const afterDiagnostics = parseTypeScriptDiagnostics(after.output);
    if (after.code !== 0 && afterDiagnostics.length === 0) {
      return { ...base, currentVersion, status: 'unavailable', preexisting: baselineDiagnostics, note: `Target typecheck failed without readable diagnostics: ${after.output.slice(-2000)}` };
    }
    const newDiagnostics = newTypeScriptDiagnostics(baselineDiagnostics, afterDiagnostics);
    const guideUrl = migrations.find((migration) => migration.packageName === packageName && migration.toMajor === Number(version.split('.')[0]))?.guideUrl;
    const manualFindings = newDiagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      line: diagnostic.line,
      message: diagnostic.message,
      symbol: /['`"]([^'`"]+)['`"]/.exec(diagnostic.message)?.[1],
      confidence: 'candidate' as const,
      ...(guideUrl ? { guideUrl } : {}),
    }));
    return { ...base, currentVersion, status: 'available', preexisting: baselineDiagnostics, newDiagnostics, manualFindings,
      note: 'New compiler errors are candidates, not proof that the SDK caused them. No code was rewritten.' };
  } catch (error) {
    return { ...base, status: 'unavailable', note: error instanceof Error ? error.message : String(error) };
  } finally {
    if (removeContainer) await removeContainer();
    unregisterContainerCleanup?.();
    unregisterCleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function makeDockerReadable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await makeDockerReadable(absolute);
    else if (info.isFile()) await chmod(absolute, info.mode | 0o444);
  }
}
