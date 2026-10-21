#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dockerBindArgs } from '../src/core/docker-mount.js';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Project } from 'ts-morph';
import type { Migration, PackageManifest } from '../src/core/types.js';
import { escapeUntrustedMarkdownCell as cell, maskSecrets } from '../src/core/report.js';
import { newTypeScriptDiagnostics, parseTypeScriptDiagnostics } from '../src/core/diagnostic-diff.js';
import { runMigration, type RunOutcome } from '../src/core/runner.js';
import { applyProposedFiles, readRegularFile } from '../src/core/verify.js';
import { IGNORED_PROJECT_DIRECTORIES, isSupportedSourceMajor } from '../src/core/project-discovery.js';
import { firebaseAdminV14 } from '../src/migrations/firebase-admin-v14/index.js';
import { migrations } from '../src/migrations/index.js';

const execFile = promisify(execFileCallback);
const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, 'benchmark/repos.json');
const reportPath = path.join(repoRoot, 'benchmark/results.md');
const timeoutMs = 15 * 60 * 1000;
const nodeImage = 'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const defaultCacheRoot = path.join(repoRoot, 'benchmark', '.cache');

export async function readBenchmarkManifest(file: string): Promise<PackageManifest> {
  let raw: string;
  try { raw = await readRegularFile(file); }
  catch { throw new Error('Unsafe package.json: benchmark manifest is not a regular file or cannot be read safely.'); }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest');
    return value as PackageManifest;
  } catch { throw new Error('Unsafe package.json: benchmark manifest could not be parsed safely.'); }
}

export interface DockerLimits {
  memoryMb: number;
  tempMb: number;
}

/** Leave room for the host, Docker daemon and tmpfs allocations. Refuse a run before downloading when RAM is tight. */
export function resolveDockerLimits(requestedMemoryMb?: number, freeBytes = os.freemem()): DockerLimits {
  if (requestedMemoryMb !== undefined && (!Number.isSafeInteger(requestedMemoryMb) || requestedMemoryMb < 512 || requestedMemoryMb > 4096)) {
    throw new Error('--memory-mb must be an integer between 512 and 4096.');
  }
  const freeMb = Math.floor(freeBytes / 1024 / 1024);
  const hostReserveMb = 768;
  const tempMb = 128;
  const safeMemoryMb = Math.floor((freeMb - hostReserveMb - tempMb) / 128) * 128;
  if (safeMemoryMb < 512) throw new Error(`Only ${freeMb} MiB of RAM is free. At least 1408 MiB is required before starting a benchmark container.`);
  return { memoryMb: Math.min(requestedMemoryMb ?? 1536, safeMemoryMb), tempMb };
}

function dockerMemoryArgs(limits: DockerLimits, uid: number, gid: number): string[] {
  return [`--memory=${limits.memoryMb}m`, `--memory-swap=${limits.memoryMb}m`, '--tmpfs', `/tmp:rw,nosuid,nodev,size=${limits.tempMb}m`,
    '--tmpfs', `/home/benchmark:rw,nosuid,nodev,size=32m,uid=${uid},gid=${gid}`];
}

/** The only host directory shared across repositories. Never mount it in a test container. */
export async function prepareBenchmarkCache(cacheRoot: string, manager: BenchRepo['packageManager']): Promise<string> {
  const resolved = path.resolve(cacheRoot);
  try {
    if ((await lstat(resolved)).isSymbolicLink()) throw new Error(`Benchmark cache must not be a symbolic link: ${resolved}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const selected = path.join(resolved, manager);
  await mkdir(selected, { recursive: true, mode: 0o700 });
  if ((await lstat(selected)).isSymbolicLink()) throw new Error(`Benchmark cache must not be a symbolic link: ${selected}`);
  return selected;
}

export interface BenchRepo {
  name: string;
  url: string;
  branch: string;
  commit: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  packageManagerPaths?: Record<string, 'npm' | 'pnpm' | 'yarn'>;
  yarnMode?: 'classic' | 'berry';
  reviewed: boolean;
  reviewNote: string;
  /** Dummy values passed only to the isolated, network-disabled check container. */
  env?: Record<string, string>;
  /** A previously verified repository-level defect that makes baseline installation invalid. */
  invalidReason?: string;
  typecheckScript?: string;
  typecheckScriptText?: string;
  typecheckPath?: string;
  testScript?: string;
  testScriptText?: string;
  testPath?: string;
}

export interface CheckResult {
  before: string;
  after: string;
}

export interface BenchResult {
  name: string;
  commit: string;
  status: string;
  usages: number;
  migrated: number;
  manual: number;
  manualFindings?: Array<{ file: string; line: number; reason: string }>;
  typecheck: CheckResult;
  tests: CheckResult;
  details: string;
}

const cleanEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  TMPDIR: os.tmpdir(),
  TEMP: os.tmpdir(),
  TMP: os.tmpdir(),
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  CI: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: '0',
  NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc.user'),
  NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npmrc.global'),
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
  YARN_NODE_LINKER: 'node-modules',
});

async function run(command: string, args: string[], cwd: string, home: string, timeout = timeoutMs): Promise<string> {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    console.log(`${command} is still running in ${path.basename(cwd)} after ${Math.floor((Date.now() - startedAt) / 60_000)} minute(s).`);
  }, 60_000);
  heartbeat.unref();
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd,
      env: cleanEnv(home),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return `${stdout}${stderr}`.trim();
  } catch (cause) {
    const error = cause as Error & { stdout?: string; stderr?: string; code?: string | number; signal?: string; killed?: boolean };
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    const exit = error.code !== undefined ? `exit code ${error.code}` : 'exit code unavailable';
    const signal = error.signal ? `, signal ${error.signal}` : '';
    const tail = output.length > 1400 ? `… ${output.slice(-1400)}` : output;
    throw new Error(`Command failed (${exit}${signal}${error.killed ? ', process killed' : ''}). ${tail || error.message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && /\.(?:[cm]?js|jsx|tsx?)$/i.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

async function packageFilesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && entry.name === 'package.json') files.push(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return files;
}

export function validateRepoEntry(repo: BenchRepo): void {
  if (!repo.reviewed || repo.reviewNote.trim().length < 20) throw new Error(`${repo.name}: repository scope and commands must be reviewed before benchmarking.`);
  if (!/^[0-9a-f]{40}$/i.test(repo.commit)) throw new Error(`${repo.name}: commit must be a full 40-character SHA.`);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(repo.branch) || repo.branch.startsWith('-')) throw new Error(`${repo.name}: invalid branch name.`);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo.url)) {
    throw new Error(`${repo.name}: only public GitHub HTTPS repository URLs are accepted.`);
  }
  if (!['npm', 'pnpm', 'yarn'].includes(repo.packageManager)) throw new Error(`${repo.name}: unsupported package manager.`);
  for (const [relativePath, manager] of Object.entries(repo.packageManagerPaths ?? {})) {
    const portable = relativePath.replaceAll('\\', '/');
    if (typeof relativePath !== 'string' || portable.startsWith('/') || /^[A-Za-z]:/.test(portable)
      || portable.split('/').includes('..') || !['npm', 'pnpm', 'yarn'].includes(manager)) {
      throw new Error(`${repo.name}: packageManagerPaths must use supported managers and relative paths inside the checkout.`);
    }
  }
  for (const [key, value] of Object.entries(repo.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new Error(`${repo.name}: invalid benchmark environment variable.`);
    }
    if (isSecretLike(value) && !(key.startsWith('STRIPE_') && /KEY$/.test(key) && value === 'sk_test_fake'))
      throw new Error(`${repo.name}: benchmark env contains a value that resembles a real secret; use a clearly fake fixture value.`);
  }
}

function isSecretLike(value: string): boolean {
  return /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}|whsec_[A-Za-z0-9_]{8,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/]{40,}={0,2}$/.test(value);
}

export function containerEnvArgs(env: Record<string, string> = {}): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

export function validatePackageManagerField(value: unknown, packageName: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/.test(value)) {
    throw new Error(`${packageName}: unsafe packageManager field; only exact npm, pnpm, or Yarn versions are supported.`);
  }
}

export async function validatePatchPaths(diffs: string[]): Promise<void> {
  for (const diff of diffs) {
    const header = diff.split('\n').find((line) => line.startsWith('+++ b/'));
    if (!header) throw new Error('Migration returned a diff without a valid destination path.');
    const file = header.slice('+++ b/'.length);
    const normalized = path.normalize(file);
    if (path.isAbsolute(file) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Migration returned an unsafe patch path: ${file}`);
    }
  }
}

export function installArgs(
  manager: BenchRepo['packageManager'],
  phase: 'baseline' | 'post-migration',
  yarnMode: BenchRepo['yarnMode'] = 'classic',
  hasLockfile = true,
): [string, string[]] {
  if (manager === 'npm') return ['npm', [phase === 'baseline' && hasLockfile ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']];
  if (manager === 'pnpm') return ['pnpm', ['install', '--ignore-scripts', '--prefer-offline', phase === 'baseline' && hasLockfile ? '--frozen-lockfile' : '--no-frozen-lockfile', '--store-dir', '/cache/pnpm']];
  return yarnMode === 'berry'
    ? ['yarn', ['install', phase === 'baseline' && hasLockfile ? '--immutable' : '--no-immutable', '--mode=skip-builds']]
    : ['yarn', ['install', '--ignore-scripts', '--non-interactive', '--prefer-offline', ...(phase === 'baseline' && hasLockfile ? ['--frozen-lockfile'] : [])]];
}

async function findMigrationPackages(root: string, migration: Migration): Promise<string[]> {
  const manifests = await packageFilesBelow(root);
  const dirs: string[] = [];
  for (const file of manifests) {
    const manifest = await readBenchmarkManifest(file);
    validatePackageManagerField(manifest.packageManager, path.relative(root, file));
    const range = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
      .map((section) => section?.[migration.packageName])
      .find((value): value is string => typeof value === 'string');
    if (range && isSupportedSourceMajor(range, migration.fromMajor)) dirs.push(path.dirname(file));
  }
  return dirs;
}

async function installDirs(root: string, migrationDirs: string[], repo: BenchRepo): Promise<string[]> {
  const rootPackage = path.join(root, 'package.json');
  const dirs = new Set<string>();
  try {
    await readBenchmarkManifest(rootPackage);
    dirs.add(root);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Unsafe package.json')) throw error;
    if (await lstat(rootPackage).then(() => true, () => false)) throw error;
    // Some projects keep the selected package in a nested directory.
  }
  for (const directory of migrationDirs) {
    await readBenchmarkManifest(path.join(directory, 'package.json'));
    const lockExists = await Promise.all(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(async (name) => {
      try { await readFile(path.join(directory, name)); return true; } catch { return false; }
    }));
    if (lockExists.some(Boolean) || dirs.size === 0) dirs.add(directory);
  }
  for (const relativeDirectory of Object.keys(repo.packageManagerPaths ?? {})) dirs.add(path.resolve(root, relativeDirectory));
  return [...dirs];
}

async function clearPackageManagerCredentialFiles(root: string): Promise<void> {
  const secretBearingConfigNames = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnpmfile.mjs', 'yarn.config.cjs']);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
      } else if (entry.isFile() && secretBearingConfigNames.has(entry.name)) {
        await rm(path.join(directory, entry.name), { force: true });
      }
    }
  }
  await visit(root);
}

function managerForDirectory(repo: BenchRepo, root: string, directory: string): BenchRepo['packageManager'] {
  const relative = path.relative(root, directory).split(path.sep).join('/');
  const overrides = Object.entries(repo.packageManagerPaths ?? {})
    .filter(([prefix]) => relative === prefix || relative.startsWith(`${prefix}/`))
    .sort(([left], [right]) => right.length - left.length);
  return overrides[0]?.[1] ?? repo.packageManager;
}

async function installDependencies(repo: BenchRepo, root: string, dirs: string[], home: string, phase: 'baseline' | 'post-migration', memoryMb?: number): Promise<void> {
  for (const dir of dirs) {
    const manager = managerForDirectory(repo, root, dir);
    const lockName = manager === 'npm' ? 'package-lock.json' : manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock';
    const [command, args] = installArgs(manager, phase, repo.yarnMode, await fileExists(path.join(dir, lockName)));
    console.log(`${repo.name}: ${phase} ${manager} installation in ${path.relative(root, dir) || '.'}.`);
    const cacheDir = await prepareBenchmarkCache(defaultCacheRoot, manager);
    await runIsolatedDockerInstall(root, dir, command, args, home, cacheDir, memoryMb);
  }
}

async function runIsolatedDockerInstall(checkout: string, packageDir: string, manager: string, managerArgs: string[], home: string, cacheDir: string, memoryMb?: number): Promise<void> {
  // Never invoke a package manager on the host after third-party tests have run.
  // Their writable checkout can contain planted hooks or modified Git config.
  const limits = resolveDockerLimits(memoryMb);
  assertInstallMemory(limits);
  const containerTracking = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-container-'));
  const cidFile = path.join(containerTracking, 'container-id');
  const dockerArgs = buildBenchmarkInstallDockerArgs(checkout, packageDir, manager, managerArgs, cacheDir, limits);
  // Retain the container only until its OOMKilled state has been inspected.
  dockerArgs.splice(dockerArgs.indexOf('--rm'), 1);
  dockerArgs.splice(1, 0, '--cidfile', cidFile);
  try {
    await run('docker', dockerArgs, checkout, home);
  } catch (error) {
    const id = await readContainerId(cidFile);
    if (id) {
      const oomKilled = await run('docker', ['inspect', '--format', '{{.State.OOMKilled}}', id], checkout, home)
        .then((value) => value.trim() === 'true').catch(() => false);
      if (oomKilled) {
        throw new Error(`Installation container OOMKilled at ${limits.memoryMb} MiB. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw error;
  } finally {
    const id = await readContainerId(cidFile);
    if (id) await run('docker', ['rm', '-f', id], checkout, home).catch(() => undefined);
    await rm(containerTracking, { recursive: true, force: true });
  }
}

function assertInstallMemory(limits: DockerLimits): void {
  if (limits.memoryMb < 1536) {
    throw new Error(`Only ${limits.memoryMb} MiB can be allocated to a benchmark installation. At least 1536 MiB is required; free host RAM or run the benchmark on GitHub Actions before downloading dependencies.`);
  }
}

async function readContainerId(cidFile: string): Promise<string | undefined> {
  const value = await readFile(cidFile, 'utf8').then((text) => text.trim()).catch(() => '');
  return /^[a-f0-9]{64}$/i.test(value) ? value : undefined;
}

export function buildBenchmarkInstallDockerArgs(checkout: string, packageDir: string, manager: string, managerArgs: string[], cacheDir = path.join(defaultCacheRoot, manager), limits: DockerLimits = resolveDockerLimits()): string[] {
  const relativeDir = path.relative(checkout, packageDir).split(path.sep).join('/') || '.';
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const installCommand = manager === 'npm' ? ['npm', ...managerArgs] : ['corepack', manager, ...managerArgs];
  const dockerArgs = [
    'run', '--rm', '--network=bridge', ...dockerMemoryArgs(limits, uid, gid), '--cpus=1', '--pids-limit=256',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', `${uid}:${gid}`,
    ...dockerBindArgs(checkout, '/workspace'), ...dockerBindArgs(path.join(checkout, '.git'), '/workspace/.git', true),
    ...dockerBindArgs(cacheDir, '/cache'),
    '--workdir', `/workspace/${relativeDir}`, '--env', 'HOME=/home/benchmark', '--env', 'CI=1',
    '--env', 'NPM_CONFIG_USERCONFIG=/home/benchmark/npmrc.user', '--env', 'NPM_CONFIG_GLOBALCONFIG=/home/benchmark/npmrc.global',
    '--env', 'NPM_CONFIG_AUDIT=false', '--env', 'NPM_CONFIG_FUND=false', '--env', 'NPM_CONFIG_CACHE=/cache/npm',
    '--env', 'YARN_CACHE_FOLDER=/cache/yarn-classic', '--env', 'YARN_GLOBAL_FOLDER=/cache/yarn',
    '--env', 'YARN_ENABLE_GLOBAL_CACHE=1', '--env', 'COREPACK_HOME=/cache/corepack',
    '--env', 'COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0', nodeImage, ...installCommand,
  ];
  return dockerArgs;
}

export async function assertPinnedCommitIsBranchAncestor(
  checkout: string,
  repo: Pick<BenchRepo, 'name' | 'branch' | 'commit'>,
  home: string,
): Promise<void> {
  const shallow = (await run('git', ['rev-parse', '--is-shallow-repository'], checkout, home)).trim() === 'true';
  if (shallow) await run('git', ['fetch', '--unshallow', 'origin', repo.branch], checkout, home);
  await run('git', ['fetch', 'origin', repo.branch], checkout, home);
  await run('git', ['merge-base', '--is-ancestor', repo.commit, `refs/remotes/origin/${repo.branch}`], checkout, home);
}

export function confirmBenchmarkNodeRuntime(manifest: PackageManifest, migration: Migration): string | undefined {
  if (migration.id !== 'openai@5' || manifest.engines?.node !== undefined) return undefined;
  manifest.engines = { ...manifest.engines, node: '>=20' };
  return 'Node.js >=20 was declared in the disposable benchmark copy after explicit benchmark-only confirmation of its Node 24 container; the repository production runtime remains unverified.';
}

async function ensureTargetMajorInBenchmarkCopy(root: string, packageDirs: string[], migration: Migration): Promise<string[]> {
  const notes: string[] = [];
  for (const directory of packageDirs) {
    const file = path.join(directory, 'package.json');
    const manifest = await readBenchmarkManifest(file);
    const beforeUpdate = JSON.stringify(manifest);
    const runtimeNote = confirmBenchmarkNodeRuntime(manifest, migration);
    if (runtimeNote) notes.push(runtimeNote);
    notes.push(...(migration.updateManifest?.(manifest) ?? []));
    let changed = JSON.stringify(manifest) !== beforeUpdate;
    const exactTarget = `${migration.toMajor}.0.0`;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const current = manifest[section]?.[migration.packageName];
      if (current && (isSupportedSourceMajor(current, migration.fromMajor) || isSupportedSourceMajor(current, migration.toMajor)) && current !== exactTarget) {
        manifest[section]![migration.packageName] = exactTarget;
        changed = true;
      }
    }
    if (changed) {
      await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      notes.push(`${path.relative(root, file)} was set to exact ${migration.packageName} ${exactTarget} in the disposable benchmark copy so post-migration checks are reproducible, even when migration findings require manual review.`);
    }
    notes.push(...(migration.inspectManifest?.(manifest) ?? []));
  }
  return notes;
}

async function runIsolatedDockerScript(
  checkout: string,
  packageDir: string,
  scriptName: string | undefined,
  checkKind: 'typecheck' | 'test',
  home: string,
  env: Record<string, string> = {},
  memoryMb?: number,
): Promise<string> {
  const manifest = await readBenchmarkManifest(path.join(packageDir, 'package.json')) as { scripts?: Record<string, string> };
  const selectedScript = scriptName;
  const inferredTsc = checkKind === 'typecheck' && !selectedScript && await fileExists(path.join(packageDir, 'tsconfig.json'));
  if (!selectedScript && !inferredTsc) return 'not configured';
  if (selectedScript && !manifest.scripts?.[selectedScript]) return 'missing';

  const relativeDir = path.relative(checkout, packageDir).split(path.sep).join('/') || '.';
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const limits = resolveDockerLimits(memoryMb);
  const dockerArgs = [
    'run', '--rm', '--network=none', ...dockerMemoryArgs(limits, uid, gid), '--cpus=1', '--pids-limit=256', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', `${uid}:${gid}`,
    ...dockerBindArgs(checkout, '/workspace'), ...dockerBindArgs(path.join(checkout, '.git'), '/workspace/.git', true), '--workdir', `/workspace/${relativeDir}`,
    '--env', 'HOME=/home/benchmark', '--env', 'CI=1', '--env', `NODE_OPTIONS=--max-old-space-size=${Math.max(256, limits.memoryMb - 256)}`, ...containerEnvArgs(env), nodeImage,
    ...(inferredTsc ? ['npm', 'exec', '--no', '--', 'tsc', '--noEmit'] : ['npm', 'run', '--ignore-scripts', selectedScript!]),
  ];
  try {
    await run('docker', dockerArgs, checkout, home);
    return 'pass';
  } catch (error) {
    return `fail: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try { await readFile(file); return true; } catch { return false; }
}

async function runPhaseChecks(
  repo: BenchRepo,
  checkout: string,
  packageDirs: string[],
  typecheckScript: string | undefined,
  testScript: string | undefined,
  home: string,
  memoryMb?: number,
): Promise<{ typecheck: string; tests: string }> {
  const runForAll = async (script: string | undefined, kind: 'typecheck' | 'test'): Promise<string> => {
    const expectedText = kind === 'typecheck' ? repo.typecheckScriptText : repo.testScriptText;
    const targetPath = kind === 'typecheck' ? repo.typecheckPath : repo.testPath;
    const targets = targetPath ? [path.resolve(checkout, targetPath)] : packageDirs;
    const results: string[] = [];
    for (const dir of targets) {
      if (!script) {
        results.push(await runIsolatedDockerScript(checkout, dir, undefined, kind, home, repo.env, memoryMb));
        continue;
      }
      const packageJson = await readBenchmarkManifest(path.join(dir, 'package.json')) as { scripts?: Record<string, string> };
      const actualText = packageJson.scripts?.[script];
      if (actualText !== expectedText) {
        results.push(actualText ? 'not run (script text differs from reviewed command)' : 'not configured');
        continue;
      }
      results.push(await runIsolatedDockerScript(checkout, dir, script, kind, home, repo.env, memoryMb));
    }
    return results.length ? results.join('; ') : 'not configured';
  };
  const typecheck = await runForAll(typecheckScript, 'typecheck');
  const tests = await runForAll(testScript, 'test');
  return { typecheck, tests };
}

export async function analyzeBenchmarkMigration(migration: Migration, checkout: string): Promise<RunOutcome> {
  // The reviewed OpenAI corpus is tested in Node 24 containers. This confirms
  // the benchmark runtime; it does not assert the repositories' deployment runtimes.
  return runMigration(migration, { cwd: checkout, dryRun: true, analysisOnly: true,
    nodeRuntime: migration.id === 'openai@5' ? 20 : undefined,
    analysisRuntimeOverride: migration.id === 'openai@5' });
}

export async function benchmarkOne(
  repo: BenchRepo,
  root: string,
  home: string,
  migration: Migration = firebaseAdminV14,
  memoryMb?: number,
): Promise<BenchResult> {
  validateRepoEntry(repo);
  const result: BenchResult = {
    name: repo.name, commit: repo.commit, status: 'failed', usages: 0, migrated: 0, manual: 0,
    typecheck: { before: 'not run', after: 'not run' }, tests: { before: 'not run', after: 'not run' }, details: '',
  };
  if (repo.invalidReason) {
    result.status = 'invalid repository';
    result.details = repo.invalidReason;
    return result;
  }
  const checkout = path.join(root, repo.name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  try {
    await run('git', ['clone', '--depth=1', '--filter=blob:none', '--no-tags', '--single-branch', '--branch', repo.branch, '--no-checkout', repo.url, checkout], root, home);
    await assertPinnedCommitIsBranchAncestor(checkout, repo, home);
    await run('git', ['checkout', '--detach', repo.commit], checkout, home);
    const head = (await run('git', ['rev-parse', 'HEAD'], checkout, home)).trim();
    if (head.toLowerCase() !== repo.commit.toLowerCase()) throw new Error(`${repo.name}: checkout did not resolve to the pinned commit.`);

    await clearPackageManagerCredentialFiles(checkout);
    const migrationDirs = await findMigrationPackages(checkout, migration);
    if (migrationDirs.length === 0) {
      result.status = 'skipped';
      result.details = `No package.json in this commit declares ${migration.packageName} major v${migration.fromMajor}.`;
      return result;
    }
    const installLocations = await installDirs(checkout, migrationDirs, repo);
    await installDependencies(repo, checkout, installLocations, home, 'baseline', memoryMb);

    const packageDirs: string[] = [];
    for (const directory of new Set([checkout, ...migrationDirs])) {
      if (await fileExists(path.join(directory, 'package.json'))) packageDirs.push(directory);
    }
    const before = await runPhaseChecks(repo, checkout, packageDirs, repo.typecheckScript, repo.testScript, home, memoryMb);
    result.typecheck.before = before.typecheck;
    result.tests.before = before.tests;

    // Test code may mutate the writable bind mount; restore the pinned source before
    // running migration logic on the host, then install the migrated tree in Docker.
    await run('git', ['reset', '--hard', head], checkout, home);
    await run('git', ['clean', '-fdx'], checkout, home);
    await clearPackageManagerCredentialFiles(checkout);

    const outcome = await analyzeBenchmarkMigration(migration, checkout);
    result.migrated = outcome.changes.length;
    result.manual = outcome.manual.length;
    result.manualFindings = outcome.manual.slice(0, 500).map(({ file, line, reason }) => ({ file, line, reason }));
    result.usages = result.migrated + result.manual;
    result.details = outcome.manifestNotes.join(' ');

    // Display diffs may summarize large lockfiles and are not guaranteed to be
    // executable patches. Apply the exact, path-checked file changes instead.
    await applyProposedFiles(checkout, outcome.proposedFiles);

    const changedSources = outcome.filesChanged
      .filter((file) => /\.(?:[cm]?js|jsx|tsx?)$/i.test(file) && !file.endsWith('.d.ts'))
      .map((file) => path.join(checkout, file));
    const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true, noResolve: true } });
    for (const file of changedSources) project.addSourceFileAtPath(file);
    const syntaxErrors = project.getSourceFiles().flatMap((source) => (source.compilerNode as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []);
    if (syntaxErrors.length > 0) throw new Error(`Syntax validation found ${syntaxErrors.length} parse error(s) after applying the migration.`);

    const targetNotes = await ensureTargetMajorInBenchmarkCopy(checkout, migrationDirs, migration);
    result.details = [...new Set([
      result.details,
      ...targetNotes,
      'The original lockfiles were retained in the disposable checkout and updated by the selected package manager for post-migration checks.',
    ].filter(Boolean))].join(' ');
    await installDependencies(repo, checkout, installLocations, home, 'post-migration', memoryMb);
    const after = await runPhaseChecks(repo, checkout, packageDirs, repo.typecheckScript, repo.testScript, home, memoryMb);
    result.typecheck.after = after.typecheck;
    result.tests.after = after.tests;
    if (migration.id === 'openai@5') {
      const newCompilerFindings = compilerRegressionFindings(before.typecheck, after.typecheck);
      result.manualFindings = [...(result.manualFindings ?? []), ...newCompilerFindings];
      result.manual += newCompilerFindings.length;
      result.usages = result.migrated + result.manual;
    }
    // This is an impact hint, not a migration rule. A compiler message may be
    // caused by another dependency; keep it out of the automatic migration rate.
    if (!before.typecheck.includes('…') && !after.typecheck.includes('…')) {
      const newlyReported = newTypeScriptDiagnostics(
        parseTypeScriptDiagnostics(before.typecheck),
        parseTypeScriptDiagnostics(after.typecheck),
      );
      if (newlyReported.length > 0) {
        result.details += ` Candidate new TypeScript diagnostics after SDK update (not attributed automatically): ${newlyReported.map((item) => `${item.file}:${item.line}:${item.column} TS${item.code} ${item.message}`).join('; ')}.`;
      }
    }
    if (migration.packageName === 'openai' && /TS2304[^;\n]*(?:RequestInit|Headers|Blob|File|Response|FormData|AbortController)/.test(after.typecheck)
      && !/TS2304[^;\n]*(?:RequestInit|Headers|Blob|File|Response|FormData|AbortController)/.test(before.typecheck)) {
      result.details += ' OpenAI v5 uses web platform types. Check the project TypeScript lib setting (for example DOM) and compatible Node type declarations before attributing these errors to a migration rule.';
    }
    const requiresRuntimeReview = requiresRuntimeReviewFromNotes(targetNotes);
    const verificationRegressed = hasVerificationRegression(before.typecheck, after.typecheck)
      || hasVerificationRegression(before.tests, after.tests);
    if (verificationRegressed) result.details += ' A previously passing check failed after the SDK upgrade; review the project and SDK types before accepting this migration.';
    result.status = result.manual > 0 || requiresRuntimeReview || verificationRegressed ? 'manual review required' : 'completed';
  } catch (error) {
    result.details = [result.details, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ');
  }
  return result;
}

export function requiresRuntimeReviewFromNotes(notes: string[]): boolean {
  return notes.some((note) => /\brequires Node\.js \d+ or (?:later|newer)\b/.test(note));
}

export function hasVerificationRegression(before: string, after: string): boolean {
  return before === 'pass' && after.startsWith('fail:');
}

/** Compiler errors seen only after a previously green check are impact evidence, not proof of an SDK cause. */
export function compilerRegressionFindings(before: string, after: string): Array<{ file: string; line: number; reason: string }> {
  if (!hasVerificationRegression(before, after)) return [];
  const seen = new Set<string>();
  return parseTypeScriptDiagnostics(after).flatMap((diagnostic) => {
    const file = diagnostic.file.replace(/^fail:\s*(?:Command failed \([^)]*\)\.\s*)?(?:…\s*)?/, '');
    const key = `${file}\0${diagnostic.code}\0${diagnostic.message}`;
    if (seen.has(key) || seen.size >= 5) return [];
    seen.add(key);
    const toolContentWidening = [2339, 2345].includes(diagnostic.code)
      && diagnostic.message.includes('ChatCompletionContentPartText[]');
    return [{ file, line: diagnostic.line,
      reason: toolContentWidening
        ? `OpenAI v5 tool message content may be a ChatCompletionContentPartText[] as well as a string; extract or narrow text parts before calling string methods or adding content to string collections.`
        : `New compiler diagnostic TS${diagnostic.code} after installing the exact target SDK: ${diagnostic.message}. The cause is not attributed automatically; review this line before accepting the migration.` }];
  });
}

export function renderBenchmarkReport(
  results: BenchResult[],
  completion: 'in progress' | 'complete' = 'complete',
  expectedCount = results.length,
  migration: Migration = firebaseAdminV14,
): string {
  const detected = results.reduce((sum, row) => sum + row.usages, 0);
  const migrated = results.reduce((sum, row) => sum + row.migrated, 0);
  const manual = results.reduce((sum, row) => sum + row.manual, 0);
  const eligible = Math.max(0, detected - manual);
  const rate = detected === 0 ? 'N/A' : `${((migrated / detected) * 100).toFixed(1)}%`;
  const eligibleRate = eligible === 0 ? 'N/A' : `${((migrated / eligible) * 100).toFixed(1)}%`;
  const lines = [
    `# ${migration.title} public repository benchmark`, '',
    ...(migration.experimental ? ['> **Experimental migration:** these results are research evidence, not validation for automatic rollout.', ''] : []),
    `Generated: ${new Date().toISOString()}`, '',
    ...(process.env.GITHUB_RUN_ID && /^\d+$/.test(process.env.GITHUB_RUN_ID) ? [`Run ID: \`${process.env.GITHUB_RUN_ID}\``, ''] : []),
    ...((process.env.UPSTREAMFIX_SOURCE_SHA ?? process.env.GITHUB_SHA) && /^[0-9a-f]{40}$/.test(process.env.UPSTREAMFIX_SOURCE_SHA ?? process.env.GITHUB_SHA ?? '') ? [`Tool SHA: \`${process.env.UPSTREAMFIX_SOURCE_SHA ?? process.env.GITHUB_SHA}\``, ''] : []),
    `Run status: **${completion}** (${results.length} of ${expectedCount} repositories recorded).`, '',
    `Automatic migration rate: **${rate}** (${migrated} of ${detected} detected migration items).`,
    `Automatic rate excluding manual-review items: **${eligibleRate}** (${migrated} of ${eligible} eligible items).`,
    'The denominator counts migration change groups plus manual findings, including potential edits withheld in files with manual findings and up to five new compiler diagnostics per previously passing project; it does not count individual API callsites. The OpenAI benchmark confirms Node.js 20 for its disposable Node 24 container only; it does not establish any repository’s production runtime.', '',
    '| Repository | Pinned commit | Status | Detected items | Migrated | Manual | Types before | Types after | Tests before | Tests after | Details |',
    '|---|---|---:|---:|---:|---:|---|---|---|---|---|',
    ...results.map((row) => `| ${cell(row.name)} | \`${row.commit.slice(0, 12)}\` | ${cell(row.status)} | ${row.usages} | ${row.migrated} | ${row.manual} | ${cell(row.typecheck.before)} | ${cell(row.typecheck.after)} | ${cell(row.tests.before)} | ${cell(row.tests.after)} | ${cell(row.details)} |`),
    ...(results.some((row) => row.manualFindings?.length) ? [
      '', '## Manual findings', '',
      '| Repository | File | Line | Reason |',
      '|---|---|---:|---|',
      ...results.flatMap((row) => (row.manualFindings ?? []).map((finding) =>
        `| ${cell(row.name)} | ${cell(finding.file)} | ${finding.line} | ${cell(finding.reason)} |`)),
    ] : []),
    '', `Project checks run only inside Docker image \`${nodeImage}\` with networking disabled. Dependency installation runs in Docker with no host credentials; lifecycle scripts are disabled.`, '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = resolveBenchmarkConfig(parseBenchmarkArgs(process.argv.slice(2)));
  const { migration, reposPath, reportPath: outputPath, only, memoryMb, yes, estimateOnly } = config;
  const corpus = await readBenchmarkRepos(reposPath);
  const repos = only ? corpus.filter((repo) => repo.name === only) : corpus;
  if (only && repos.length !== 1) throw new Error(`--only "${only}" must match exactly one repository name in ${reposPath}.`);
  if (repos.length === 0) throw new Error(`No repositories found in ${reposPath}.`);
  for (const repo of repos) validateRepoEntry(repo);
  const lowMb = repos.length * 2 * 60;
  const highMb = repos.length * 2 * 200;
  console.log(`Selected ${repos.length} repository(s), up to ${repos.length * 2} dependency installations.`);
  console.log(`Without a warm cache, a rough transfer range is ${(lowMb / 1024).toFixed(1)}–${(highMb / 1024).toFixed(1)} GiB. Actual traffic varies by lockfile and cache contents.`);
  console.log(`Persistent install cache: ${defaultCacheRoot}.`);
  if (estimateOnly) return;
  if (!yes) throw new Error('No repositories were cloned. Re-run with --yes to allow network downloads, or --estimate-only to view the estimate.');
  const limits = resolveDockerLimits(memoryMb);
  assertInstallMemory(limits);
  console.log(`Docker cap: ${limits.memoryMb} MiB RAM and swap combined; ${limits.tempMb} MiB /tmp.`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'upstreamfix-benchmark-home-'));
  try {
    await Promise.all([
      writeFile(path.join(home, 'npmrc.user'), '', 'utf8'),
      writeFile(path.join(home, 'npmrc.global'), '', 'utf8'),
    ]);
    const results: BenchResult[] = [];
    for (const repo of repos) {
      console.log(`Benchmarking ${repo.name} at ${repo.commit.slice(0, 12)}...`);
      const result = await benchmarkOne(repo, root, home, migration, memoryMb);
      results.push(result);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, renderBenchmarkReport(results, 'in progress', repos.length, migration), 'utf8');
      console.log(`${repo.name}: ${result.status}; ${result.migrated} migrated, ${result.manual} manual.`);
      await rm(path.join(root, repo.name.replace(/[^A-Za-z0-9_.-]/g, '_')), { recursive: true, force: true });
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderBenchmarkReport(results, 'complete', repos.length, migration), 'utf8');
    console.log(`Benchmark report written to ${path.relative(repoRoot, outputPath)} (${results.length} repositories).`);
    const failures = results.filter((result) => result.status === 'failed');
    if (failures.length > 0) {
      console.error(`${failures.length} repository benchmark(s) failed; see the report artifact for the installation or verification errors.`);
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
  }
}

export interface BenchmarkOptions {
  migrationId: string;
  reposPath?: string;
  reportPath?: string;
  only?: string;
  memoryMb?: number;
  yes?: boolean;
  estimateOnly?: boolean;
}

export interface ResolvedBenchmarkConfig {
  migration: Migration;
  reposPath: string;
  reportPath: string;
  only?: string;
  memoryMb?: number;
  yes?: boolean;
  estimateOnly?: boolean;
}

export function resolveBenchmarkConfig(options: BenchmarkOptions, root = repoRoot): ResolvedBenchmarkConfig {
  const migration = migrations.find((candidate) => candidate.id === options.migrationId);
  if (!migration) throw new Error(`Unknown migration "${options.migrationId}". Available: ${migrations.map(({ id }) => id).join(', ')}`);
  const slug = migration.id.replace(/[^A-Za-z0-9_.-]/g, '-');
  return {
    migration,
    only: options.only,
    memoryMb: options.memoryMb,
    yes: options.yes,
    estimateOnly: options.estimateOnly,
    reposPath: path.resolve(root, options.reposPath ?? (migration.id === firebaseAdminV14.id
      ? 'benchmark/repos.json'
      : `benchmark/${slug}-repos.json`)),
    reportPath: path.resolve(root, options.reportPath ?? (options.only
      ? `benchmark/${slug}-${options.only.replace(/[^A-Za-z0-9_.-]/g, '-')}-results.md`
      : migration.id === firebaseAdminV14.id ? 'benchmark/results.md' : `benchmark/${slug}-results.md`)),
  };
}

export async function readBenchmarkRepos(file: string): Promise<BenchRepo[]> {
  let contents: string;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Benchmark repository manifest not found: ${file}`);
    }
    throw error;
  }
  const repos = JSON.parse(contents) as BenchRepo[];
  if (!Array.isArray(repos)) throw new Error(`${file} must contain an array.`);
  return repos;
}

export function parseBenchmarkArgs(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { migrationId: firebaseAdminV14.id };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: npm run benchmark -- [--migration <id>] [--repos <json-file>] [--report <markdown-file>] [--only <repo-name>] [--memory-mb <512-4096>] [--estimate-only | --yes]');
      console.log(`Available migrations: ${migrations.map(({ id }) => id).join(', ')}`);
      console.log('--estimate-only prints the transfer estimate without cloning or downloading. --yes is required to start a benchmark.');
      process.exit(0);
    }
    if (argument === '--yes' || argument === '--estimate-only') {
      if (argument === '--yes') options.yes = true;
      else options.estimateOnly = true;
      continue;
    }
    if (!['--migration', '--repos', '--report', '--only', '--memory-mb'].includes(argument)) throw new Error(`Unknown benchmark option "${argument}".`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    if (argument === '--migration') options.migrationId = value;
    if (argument === '--repos') options.reposPath = path.resolve(repoRoot, value);
    if (argument === '--report') options.reportPath = path.resolve(repoRoot, value);
    if (argument === '--only') options.only = value;
    if (argument === '--memory-mb') {
      if (!/^\d+$/.test(value)) throw new Error('--memory-mb must be an integer between 512 and 4096.');
      options.memoryMb = Number(value);
      resolveDockerLimits(options.memoryMb, 8 * 1024 * 1024 * 1024);
    }
    index += 1;
  }
  if (options.yes && options.estimateOnly) throw new Error('Choose either --yes or --estimate-only.');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`benchmark: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
